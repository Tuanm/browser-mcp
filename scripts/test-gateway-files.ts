#!/usr/bin/env bun
/**
 * test-gateway-files.ts - download destination="gateway" and upload
 * source="gateway", driven through the REAL service-worker.js, offscreen.js and
 * mcp-server.js under a mock chrome, against a real HTTP gateway.
 *
 * The same scenario runs twice:
 *
 *   1. against a small in-process gateway (always - this is what CI runs), and
 *   2. against the real code-mcp-gateway worker under wrangler, when GATEWAY_DIR
 *      points at its worker/ directory (bun run test:gateway does this for a
 *      sibling checkout). Opt-in: a cold wrangler takes a while to start.
 *
 * Most checks are about what must NOT happen: a download the agent did not start
 * must not leave the device, the device token must not reach a URL or a page,
 * stored files must not be readable without the device's credentials, and the
 * file handlers must not accept messages from web pages.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const SRC = ROOT + "/packages/browser-extension/src/";
const EXT_ID = "bmcptest";
const DEVICE = "bmcp-files";
const TOKEN = "tok-" + crypto.randomUUID().replace(/-/g, "");
const OTHER = "bmcp-other";
const OTHER_TOKEN = "tok-" + crypto.randomUUID().replace(/-/g, "");

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: unknown, detail = "") {
  if (cond) {
    pass++;
    console.log("  PASS " + name);
  } else {
    fail++;
    failures.push(name + (detail ? ": " + detail : ""));
    console.log("  FAIL " + name + (detail ? ": " + detail : ""));
  }
}

// Every fetch the extension makes is recorded. The harness itself uses rawFetch,
// so the record holds only what extension code did.
const rawFetch = globalThis.fetch.bind(globalThis);
type Seen = { url: string; method: string; headers: Record<string, string> };
const seen: Seen[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers || {}).forEach((v, k) => (headers[k] = v));
  seen.push({ url, method: (init?.method || "GET").toUpperCase(), headers });
  return rawFetch(input, init);
}) as typeof fetch;

const basic = (id: string, token: string) => "Basic " + btoa(id + ":" + token);

interface Gateway {
  label: string;
  base: string;
  host: string;
  register(id: string, token: string): Promise<void>;
  stop(): void;
}

/** The parts of /api/files the extension relies on, with the same auth rules. */
/** Set to emulate a gateway that predates X-File-Key on upload. */
let legacyGateway = false;

function startFakeGateway(): Gateway {
  const devices = new Map<string, string>();
  const files = new Map<
    string,
    { owner: string; name: string; type: string; bytes: Uint8Array; key?: string; expiresAt: number }
  >();
  const who = (req: Request) => {
    const m = /^Basic (.+)$/.exec(req.headers.get("authorization") || "");
    if (!m) return null;
    const [id, ...rest] = atob(m[1]).split(":");
    return devices.get(id) === rest.join(":") ? id : null;
  };
  let base = "";
  const view = (id: string) => {
    const f = files.get(id)!;
    return {
      id,
      name: f.name,
      size: f.bytes.byteLength,
      content_type: f.type,
      status: "ready",
      protected: Boolean(f.key),
      expires_at: new Date(f.expiresAt).toISOString(),
      download_url: base + "/api/files/" + id,
      page_url: base + "/files/" + id,
    };
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const owner = who(req);
      if (url.pathname === "/api/files" && req.method === "POST") {
        if (!owner) return new Response("unauthorized", { status: 401 });
        const id = crypto.randomUUID().replace(/-/g, "");
        const days = Number(url.searchParams.get("expiry_days") || 7);
        files.set(id, {
          owner,
          name: url.searchParams.get("name") || "file",
          type: req.headers.get("content-type") || "application/octet-stream",
          bytes: new Uint8Array(await req.arrayBuffer()),
          key: (legacyGateway ? null : req.headers.get("x-file-key")) || url.searchParams.get("key") || undefined,
          expiresAt: Date.now() + days * 86400000,
        });
        return Response.json({ ok: true, file: view(id) }, { status: 201 });
      }
      if (url.pathname === "/api/files" && req.method === "GET") {
        if (!owner) return new Response("unauthorized", { status: 401 });
        return Response.json({ files: [...files.keys()].filter((id) => files.get(id)!.owner === owner).map(view) });
      }
      const m = /^\/api\/files\/([a-f0-9]{32})$/.exec(url.pathname);
      if (m && req.method === "DELETE") {
        const f = files.get(m[1]);
        if (!f || f.owner !== owner) return new Response("not found", { status: 404 });
        files.delete(m[1]);
        return Response.json({ ok: true });
      }
      if (m && req.method === "GET") {
        const f = files.get(m[1]);
        if (!f) return new Response("not found", { status: 404 });
        if (f.key && owner !== f.owner && req.headers.get("x-file-key") !== f.key) {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(f.bytes, { headers: { "content-type": f.type } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = "http://127.0.0.1:" + server.port;
  return {
    label: "in-process gateway",
    base,
    host: "127.0.0.1:" + server.port,
    register: async (id, token) => void devices.set(id, token),
    stop: () => server.stop(true),
    count: () => files.size,
  } as Gateway & { count(): number };
}

/** The real code-mcp-gateway worker, under wrangler, with simulated R2. */
async function startRealGateway(dir: string): Promise<Gateway> {
  const port = 8860 + Math.floor(Math.random() * 100);
  const state = mkdtempSync(join(tmpdir(), "bmcp-gw-state-"));
  const proc = spawn(
    "node",
    [
      dir + "/node_modules/.bin/wrangler",
      "dev",
      "--local",
      "-c",
      dir + "/wrangler.dev.toml",
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--persist-to",
      state,
    ],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log: string[] = [];
  const keep = (c: Buffer) => {
    log.push(c.toString());
    while (log.length > 40) log.shift();
  };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);
  const base = "http://127.0.0.1:" + port;
  const stop = () => {
    proc.kill();
    rmSync(state, { recursive: true, force: true });
  };
  for (let i = 0; i < 1200; i++) {
    try {
      const r = await rawFetch(base + "/admin/api/devices");
      if (r.status < 500) {
        return {
          label: "real code-mcp-gateway",
          base,
          host: "127.0.0.1:" + port,
          register: async (id, token) => {
            const res = await rawFetch(base + "/admin/api/devices", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ deviceId: id, token }),
            });
            if (!res.ok) throw new Error("could not register " + id + ": HTTP " + res.status);
          },
          stop,
        };
      }
    } catch {}
    await Bun.sleep(250);
  }
  stop();
  throw new Error("wrangler did not become ready\n" + log.join("").slice(-1200));
}

// A mock chrome complete enough for the download, upload and offscreen paths.
const config: Record<string, string> = { deviceId: DEVICE, authToken: TOKEN, gatewayHost: "" };
let tabUrl = "https://example.com/upload";
type Item = {
  id: number;
  url: string;
  finalUrl: string;
  filename: string;
  state: string;
  startTime: string;
  totalBytes: number;
  fileSize: number;
  bytesReceived: number;
  mime: string;
};
const downloadItems: Item[] = [];
const calls = {
  removeFile: [] as number[],
  cancel: [] as number[],
  erase: [] as number[],
  callFunctionOn: [] as any[],
  executeScript: [] as any[],
};
const listeners: Record<string, Function[]> = {};
const add = (k: string) => (fn: Function) => void (listeners[k] ||= []).push(fn);

function deliver(listener: Function | undefined, message: any, sender: any): Promise<any> {
  return new Promise((resolve) => {
    if (!listener) return resolve(undefined);
    let answered = false;
    const kept = listener(message, sender, (resp: any) => {
      answered = true;
      resolve(resp);
    });
    if (kept !== true && !answered) resolve(undefined);
  });
}

let offscreenListener: Function | undefined;
function makeChrome(withDebugger: boolean) {
  const chrome: any = {
    runtime: {
      id: EXT_ID,
      getURL: (p: string) => "chrome-extension://" + EXT_ID + "/" + p,
      onMessage: { addListener: add("onMessage") },
      onConnect: { addListener: add("onConnect") },
      onInstalled: { addListener: add("onInstalled") },
      onStartup: { addListener: add("onStartup") },
      // The service worker's messages go to the offscreen document, which sees
      // an extension sender: no tab, the worker's own URL.
      sendMessage: (message: any) =>
        deliver(offscreenListener, message, {
          id: EXT_ID,
          url: "chrome-extension://" + EXT_ID + "/src/service-worker.js",
        }),
      connect: () => ({
        disconnect() {},
        onDisconnect: { addListener() {} },
        onMessage: { addListener() {} },
        postMessage() {},
      }),
      lastError: null,
    },
    storage: {
      local: { get: async () => ({ ...config }), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: add("storageChanged") },
    },
    tabs: {
      query: async () => [{ id: 7, url: "https://example.com/", title: "Example", active: true }],
      get: async (id: number) => ({ id, url: tabUrl, title: "Example", status: "complete" }),
      sendMessage: async () => ({}),
      update: async () => ({ id: 7 }),
      onCreated: { addListener: add("tabsCreated") },
      onRemoved: { addListener: add("tabsRemoved") },
      onUpdated: { addListener: add("tabsUpdated") },
      onActivated: { addListener: add("tabsActivated") },
    },
    scripting: {
      executeScript: async (arg: any) => {
        calls.executeScript.push(arg);
        const a = arg.args || [];
        return [{ frameId: 0, result: { files: 1, name: a[2], size: 0 } }];
      },
      registerContentScripts: async () => {},
      getRegisteredContentScripts: async () => [],
    },
    action: {
      setIcon: async () => {},
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    notifications: {
      onClicked: { addListener: add("nClick") },
      onClosed: { addListener: add("nClose") },
      create: async () => "1",
    },
    downloads: {
      setUiOptions: async () => {},
      onCreated: { addListener: add("dlCreated") },
      onChanged: { addListener: add("dlChanged") },
      search: (query: any, cb?: Function) => {
        let items = [...downloadItems].sort((a, b) => b.startTime.localeCompare(a.startTime));
        if (query && query.id !== undefined) items = items.filter((i) => i.id === query.id);
        if (cb) cb(items);
        return Promise.resolve(items);
      },
      removeFile: async (id: number) => void calls.removeFile.push(id),
      cancel: async (id: number) => void calls.cancel.push(id),
      erase: async (q: any) => {
        calls.erase.push(q.id);
        const i = downloadItems.findIndex((d) => d.id === q.id);
        if (i >= 0) downloadItems.splice(i, 1);
        return [q.id];
      },
    },
    windows: { onFocusChanged: { addListener: add("winFocus") } },
    webNavigation: {},
    cookies: {},
    history: { search: async () => [] },
    permissions: {},
    offscreen: { hasDocument: async () => true, createDocument: async () => {}, closeDocument: async () => {} },
  };
  if (withDebugger) {
    chrome.debugger = {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_t: any, method: string, params: any) => {
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelector") return { nodeId: 2 };
        if (method === "DOM.resolveNode") return { object: { objectId: "obj-1" } };
        if (method === "Runtime.callFunctionOn") {
          calls.callFunctionOn.push(params);
          return { result: { value: "ok" } };
        }
        return {};
      },
      onEvent: { addListener: add("dbgEvent") },
      onDetach: { addListener: add("dbgDetach") },
    };
  }
  return chrome;
}

let swListener: Function | undefined;
function command(method: string, params: any): Promise<{ result?: any; error?: { message: string } }> {
  return deliver(
    swListener,
    { source: "offscreen", type: "command", id: 1, method, params },
    { id: EXT_ID, url: "chrome-extension://" + EXT_ID + "/src/offscreen.html" },
  );
}

/** What CDP reports when a tab the agent is attached to starts a download. */
function cdpDownload(tabId: number, guid: string, url: string) {
  for (const fn of listeners.dbgEvent || [])
    fn({ tabId }, "Browser.downloadWillBegin", { guid, url, suggestedFilename: "x" });
  for (const fn of listeners.dbgEvent || []) fn({ tabId }, "Browser.downloadProgress", { guid, state: "completed" });
}

function addItem(id: number, url: string, filename: string, size: number, mime: string) {
  downloadItems.push({
    id,
    url,
    finalUrl: url,
    filename,
    state: "complete",
    startTime: new Date().toISOString(),
    totalBytes: size,
    fileSize: size,
    bytesReceived: size,
    mime,
  });
}

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
const errorOf = (r: any) => String(r?.error?.message ?? "");

async function scenario(gw: Gateway, workDir: string) {
  console.log("\n== " + gw.label + " ==");
  const seenFrom = seen.length; // this scenario's requests only
  config.gatewayHost = gw.host;
  await gw.register(DEVICE, TOKEN);
  await gw.register(OTHER, OTHER_TOKEN);

  const report = new Uint8Array(300 * 1024).map((_, i) => (i * 37 + 11) & 0xff);
  const reportPath = join(workDir, "q3-report-" + Date.now() + ".pdf");
  writeFileSync(reportPath, report);
  const userPath = join(workDir, "payslip-" + Date.now() + ".pdf");
  writeFileSync(userPath, new Uint8Array([9, 9, 9]));
  const auth = { authorization: basic(DEVICE, TOKEN) };
  const posts = () => seen.filter((s) => s.method === "POST" && s.url.startsWith(gw.base)).length;

  // ---- download -> gateway, for a download the agent's tab started ----
  const signed = "https://files.example.com/q3-report.pdf?X-Amz-Signature=SIGSECRET&token=abc";
  cdpDownload(7, "g-agent-" + gw.label, signed);
  addItem(101, signed, reportPath, report.byteLength, "application/pdf");
  const seenBefore = seen.length;
  const stored = await command("download", { action: "latest", destination: "gateway", tabId: 7 });
  const out = stored.result;
  check(
    "an agent-started download is stored in gateway storage",
    out?.saved_to === "gateway",
    errorOf(stored) || JSON.stringify(out).slice(0, 160),
  );
  const fileId: string = out?.file?.id;
  check("it comes back with a gateway file id", /^[a-f0-9]{32}$/.test(String(fileId)), String(fileId));
  check("the stored size is the downloaded size", out?.file?.size === report.byteLength, String(out?.file?.size));
  check("it is reported as protected", out?.file?.protected === true);
  check(
    "the source URL loses its signed query",
    out?.source === "https://files.example.com/q3-report.pdf",
    String(out?.source),
  );
  check(
    "the local copy is removed once the gateway holds it",
    out?.removed_from_device === true && calls.removeFile.includes(101),
  );
  check("the download's entry is erased too", calls.erase.includes(101));

  const upload = seen.slice(seenBefore).find((s) => s.method === "POST" && s.url.startsWith(gw.base));
  const fileKey = upload?.headers["x-file-key"] || "";
  check(
    "the upload carries the device credentials as a header",
    upload?.headers.authorization === basic(DEVICE, TOKEN),
  );
  check("it is protected at creation with a long random key", /^[a-f0-9]{64}$/.test(fileKey), fileKey.slice(0, 12));
  check(
    "no key or token appears in the upload URL",
    !!upload && !upload.url.includes("key=") && !upload.url.includes(TOKEN),
    upload?.url,
  );
  const outJson = JSON.stringify(stored);
  check("the result never discloses the token", !outJson.includes(TOKEN));
  check("the result never discloses the file key", !!fileKey && !outJson.includes(fileKey));
  check("the result never repeats the signed query", !outJson.includes("SIGSECRET"));

  check("nobody can fetch it without credentials", (await rawFetch(gw.base + "/api/files/" + fileId)).status === 401);
  const owned = await rawFetch(gw.base + "/api/files/" + fileId, { headers: auth });
  check(
    "the device can, and the bytes are intact",
    owned.status === 200 && sameBytes(new Uint8Array(await owned.arrayBuffer()), report),
  );

  const stray = seen
    .slice(seenFrom)
    .filter((s) => !s.url.startsWith("file://") && !s.url.startsWith(gw.base) && !/^wss?:/.test(s.url));
  check("the extension talked only to the configured gateway", stray.length === 0, stray.map((s) => s.url).join(", "));
  check("no extension request put the token in a URL", !seen.slice(seenFrom).some((s) => s.url.includes(TOKEN)));

  // ---- a download the agent did not start never leaves the device ----
  const postsBefore = posts();
  cdpDownload(9, "g-user-" + gw.label, "https://bank.example.com/payslip.pdf");
  addItem(102, "https://bank.example.com/payslip.pdf", userPath, 3, "application/pdf");
  const refused = await command("download", { action: "latest", destination: "gateway", tabId: 7 });
  check(
    "a download from another tab is refused",
    /agent's tab/.test(errorOf(refused)),
    errorOf(refused) || JSON.stringify(refused.result),
  );
  check("...and is left on the device", !calls.removeFile.includes(102));
  check("...and nothing was uploaded", posts() === postsBefore);

  // A plain user download with no CDP event at all is no different.
  addItem(103, "https://mail.example.com/attachment.zip", userPath, 3, "application/zip");
  const untracked = await command("download", { action: "wait", destination: "gateway", tabId: 7, timeout: 600 });
  check("an untracked download is refused", /agent's tab/.test(errorOf(untracked)), errorOf(untracked));
  check("...and nothing was uploaded", posts() === postsBefore && !calls.removeFile.includes(103));

  // ---- if the gateway refuses, the file stays on the device ----
  cdpDownload(7, "g-refused-" + gw.label, "https://files.example.com/kept.pdf");
  addItem(106, "https://files.example.com/kept.pdf", userPath, 3, "application/pdf");
  config.authToken = "wrong-token";
  const rejected = await command("download", { action: "latest", destination: "gateway", tabId: 7 });
  config.authToken = TOKEN;
  check(
    "a gateway refusal is reported",
    /Could not store/.test(errorOf(rejected)),
    errorOf(rejected) || JSON.stringify(rejected.result),
  );
  check(
    "...and the local copy is kept",
    !calls.removeFile.includes(106) && !calls.cancel.includes(106) && !calls.erase.includes(106),
  );
  downloadItems.splice(
    downloadItems.findIndex((d) => d.id === 106),
    1,
  );

  // ---- an old gateway that cannot protect at upload: fail closed ----
  if ("count" in gw) {
    legacyGateway = true;
    const filesBefore = (gw as any).count();
    cdpDownload(7, "g-legacy-" + gw.label, "https://files.example.com/legacy.pdf");
    addItem(107, "https://files.example.com/legacy.pdf", userPath, 3, "application/pdf");
    const legacy = await command("download", { action: "latest", destination: "gateway", tabId: 7 });
    legacyGateway = false;
    check(
      "an old gateway that leaves the file public is refused",
      /did not protect/.test(errorOf(legacy)),
      errorOf(legacy) || JSON.stringify(legacy.result),
    );
    check(
      "...the public copy is deleted again",
      (gw as any).count() === filesBefore,
      (gw as any).count() + " vs " + filesBefore,
    );
    check("...and the local copy is kept", !calls.removeFile.includes(107));
    downloadItems.splice(
      downloadItems.findIndex((d) => d.id === 107),
      1,
    );
  }

  // ---- configuration and argument errors fail closed ----
  config.authToken = "";
  const noCreds = await command("download", { action: "latest", destination: "gateway", tabId: 7 });
  check("without a device token it refuses", /device id and token/.test(errorOf(noCreds)), errorOf(noCreds));
  config.authToken = TOKEN;

  const postsBeforeBig = posts();
  cdpDownload(7, "g-big-" + gw.label, "https://files.example.com/huge.iso");
  addItem(104, "https://files.example.com/huge.iso", reportPath, 300 * 1048576, "application/octet-stream");
  const big = await command("download", { action: "latest", destination: "gateway", tabId: 7 });
  check("a download over 200 MiB is refused", /200 MiB/.test(errorOf(big)), errorOf(big));
  check("...and stays on the device", !calls.removeFile.includes(104) && posts() === postsBeforeBig);
  downloadItems.splice(
    downloadItems.findIndex((d) => d.id === 104),
    1,
  );

  check(
    "an unknown destination is rejected",
    /Unknown destination/.test(errorOf(await command("download", { action: "latest", destination: "cloud" }))),
  );
  check(
    "a bad expiry_days is rejected",
    /expiry_days/.test(
      errorOf(await command("download", { action: "latest", destination: "gateway", expiryDays: -1 })),
    ),
  );
  check(
    "destination gateway needs wait or latest",
    /wait|latest/.test(errorOf(await command("download", { action: "list", destination: "gateway" }))),
  );

  cdpDownload(7, "g-exp-" + gw.label, "https://files.example.com/short.txt");
  addItem(105, "https://files.example.com/short.txt", userPath, 3, "text/plain");
  const shortLived = await command("download", { action: "latest", destination: "gateway", tabId: 7, expiryDays: 1 });
  const ttl = Date.parse(shortLived.result?.file?.expires_at || "") - Date.now();
  check("expiry_days sets the lifetime", ttl > 0 && ttl <= 1.05 * 86400000, errorOf(shortLived) || String(ttl));

  // ---- upload <- gateway ----
  const roundTrip = await command("file_upload", { selector: "#f", source: "gateway", fileId, tabId: 7 });
  const injected = calls.callFunctionOn.at(-1)?.arguments?.map((a: any) => a.value) || [];
  check("a gateway file is uploaded into the page", roundTrip.result?.source === "gateway", errorOf(roundTrip));
  check("the page receives the exact bytes", sameBytes(b64ToBytes(String(injected[0] || "")), report));
  check("it keeps its name", String(injected[1]).startsWith("q3-report-"), String(injected[1]));
  check("it keeps its type", injected[2] === "application/pdf", String(injected[2]));
  check("the page never sees the token", !JSON.stringify(calls.callFunctionOn).includes(TOKEN));

  const csv = await rawFetch(gw.base + "/api/files?name=invoice.csv&expiry_days=1", {
    method: "POST",
    headers: { ...auth, "content-type": "text/csv" },
    body: "a,b\n1,2\n",
  });
  const csvId = ((await csv.json()) as any).file.id;
  await command("file_upload", { selector: "#f", source: "gateway", fileId: csvId, tabId: 7 });
  const csvArgs = calls.callFunctionOn.at(-1)?.arguments?.map((a: any) => a.value) || [];
  check(
    "a seeded file arrives with its own name and type",
    csvArgs[1] === "invoice.csv" && String(csvArgs[2]).startsWith("text/csv"),
    JSON.stringify(csvArgs.slice(1)),
  );

  const theirs = await rawFetch(gw.base + "/api/files?name=theirs.txt&expiry_days=1", {
    method: "POST",
    headers: { authorization: basic(OTHER, OTHER_TOKEN), "content-type": "text/plain" },
    body: "not yours",
  });
  const theirId = ((await theirs.json()) as any).file.id;
  const foreign = await command("file_upload", { selector: "#f", source: "gateway", fileId: theirId, tabId: 7 });
  check(
    "another device's file is refused",
    /No file/.test(errorOf(foreign)),
    errorOf(foreign) || JSON.stringify(foreign.result),
  );
  check("...without its bytes ever being fetched", !seen.some((s) => s.url.endsWith("/api/files/" + theirId)));

  const fetchesBefore = seen.length;
  const traversal = await command("file_upload", {
    selector: "#f",
    source: "gateway",
    fileId: "../../admin/api/devices",
    tabId: 7,
  });
  check("a malformed file id is refused", /32-character id/.test(errorOf(traversal)), errorOf(traversal));
  check("...before any request is made", seen.length === fetchesBefore);
  tabUrl = "http://shop.example.com/upload";
  const beforePlain = seen.length;
  const plain = await command("file_upload", { selector: "#f", source: "gateway", fileId, tabId: 7 });
  check(
    "a gateway file is never put into a plain-http page",
    /https:\/\//.test(errorOf(plain)),
    errorOf(plain) || JSON.stringify(plain.result),
  );
  check("...and is not even fetched", seen.length === beforePlain);
  tabUrl = "http://localhost:3000/upload";
  check(
    "a local http page is allowed",
    (await command("file_upload", { selector: "#f", source: "gateway", fileId, tabId: 7 })).result?.source ===
      "gateway",
  );
  tabUrl = "https://example.com/upload";
  check(
    "source gateway takes no content",
    /takes a file_id/.test(
      errorOf(await command("file_upload", { selector: "#f", source: "gateway", fileId, content: "aGk=" })),
    ),
  );

  const bigFile = await rawFetch(gw.base + "/api/files?name=big.bin&expiry_days=1", {
    method: "POST",
    headers: { ...auth, "content-type": "application/octet-stream" },
    body: new Uint8Array(26 * 1048576),
  });
  const bigId = ((await bigFile.json()) as any).file.id;
  const tooBig = await command("file_upload", { selector: "#f", source: "gateway", fileId: bigId, tabId: 7 });
  check("a file over the page-upload limit is refused", /25 MiB/.test(errorOf(tooBig)), errorOf(tooBig));
  check("...without downloading it first", !seen.some((s) => s.url.endsWith("/api/files/" + bigId)));

  // ---- the offscreen file handlers ignore web pages ----
  const pagePosts = posts();
  const fromPage = await deliver(
    offscreenListener,
    {
      type: "gateway-store-download",
      filePath: reportPath,
      uploadUrl: gw.base + "/api/files?name=x",
      authorization: basic(DEVICE, TOKEN),
      fileKey: "k",
    },
    { id: EXT_ID, tab: { id: 7 }, url: "https://evil.example/" },
  );
  check(
    "a web page cannot drive the gateway upload handler",
    fromPage?.ok === false && /extension only/.test(fromPage.error),
    JSON.stringify(fromPage),
  );
  check("...and nothing was sent", posts() === pagePosts);
  const readFromPage = await deliver(
    offscreenListener,
    { type: "read-file", filePath: reportPath },
    { id: EXT_ID, tab: { id: 7 }, url: "https://evil.example/" },
  );
  check(
    "a web page cannot read local files through the offscreen document",
    readFromPage?.ok === false && !readFromPage?.base64,
  );
  const elsewhere = await deliver(
    offscreenListener,
    {
      type: "gateway-store-download",
      filePath: reportPath,
      uploadUrl: "https://evil.example/collect",
      authorization: "x",
      fileKey: "k",
    },
    { id: EXT_ID, url: "chrome-extension://" + EXT_ID + "/src/service-worker.js" },
  );
  check(
    "even the extension cannot point it anywhere but /api/files",
    elsewhere?.ok === false && /refusing/.test(elsewhere.error),
    JSON.stringify(elsewhere),
  );
  check("...and evil.example was never contacted", !seen.some((s) => s.url.includes("evil.example")));

  // Checked again at the end so the upload phase is covered too.
  check("no request in any phase put the token in a URL", !seen.slice(seenFrom).some((s) => s.url.includes(TOKEN)));
  return { fileId };
}

// The tool surface: arguments reach the worker (download used to drop tab_id).
async function toolSurface() {
  console.log("\n== MCP tool surface ==");
  const { createMcpHandler } = await import(SRC + "mcp-server.js");
  const sent: Array<[string, any]> = [];
  const handle = createMcpHandler(async (method: string, params: any) => {
    sent.push([method, params]);
    return { tabId: 7, source: params.source, fileId: params.fileId, fileName: "n", size: 1 };
  });
  const list = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const toolsByName: any = Object.fromEntries((list?.result?.tools || []).map((t: any) => [t.name, t]));
  check(
    "download offers destination device|gateway",
    JSON.stringify(toolsByName.download?.inputSchema?.properties?.destination?.enum) === '["device","gateway"]',
  );
  check(
    "upload offers source device|gateway",
    JSON.stringify(toolsByName.upload?.inputSchema?.properties?.source?.enum) === '["device","gateway"]',
  );
  check(
    "download takes no gateway URL or host",
    !Object.keys(toolsByName.download?.inputSchema?.properties || {}).some((k) => /url|host/.test(k)),
  );

  await handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "download", arguments: { action: "latest", destination: "gateway", tab_id: 7, expiry_days: 2 } },
  });
  const d = sent.find(([m]) => m === "download")?.[1];
  check(
    "download passes destination, tab_id and expiry_days through",
    d?.destination === "gateway" && d?.tabId === 7 && d?.expiryDays === 2,
    JSON.stringify(d),
  );
  await handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "upload", arguments: { selector: "#f", source: "gateway", file_id: "a".repeat(32) } },
  });
  const u = sent.find(([m]) => m === "file_upload")?.[1];
  check(
    "upload passes source and file_id through",
    u?.source === "gateway" && u?.fileId === "a".repeat(32),
    JSON.stringify(u),
  );
}

// WebKit has no chrome.debugger: the scripting path must do the same thing.
async function webkitUpload(gw: Gateway, fileId: string) {
  console.log("\n== WebKit upload (no chrome.debugger) ==");
  (globalThis as any).chrome = makeChrome(false);
  listeners.onMessage = [];
  await import(SRC + "service-worker.js?webkit=" + Date.now());
  await Bun.sleep(80);
  swListener = listeners.onMessage[0];
  config.gatewayHost = gw.host;
  const r = await command("file_upload", { selector: "#f", source: "gateway", fileId, tabId: 7 });
  const args = calls.executeScript.at(-1)?.args || [];
  check("WebKit uploads a gateway file through chrome.scripting", r.result?.source === "gateway", errorOf(r));
  check(
    "...with the file's bytes, name and type",
    args[0] === "#f" && b64ToBytes(String(args[1])).byteLength === 300 * 1024 && args[3] === "application/pdf",
    JSON.stringify([args[0], args[2], args[3]]),
  );
  check("...and never the token", !JSON.stringify(calls.executeScript).includes(TOKEN));
}

/**
 * Opt-in smoke test against a deployed gateway with an existing device:
 *   SMOKE_GATEWAY=code-mcp.example.workers.dev SMOKE_DEVICE=id SMOKE_TOKEN=t bun scripts/test-gateway-files.ts
 * One download -> gateway -> page upload round trip; the file is deleted after.
 */
async function smoke(host: string, device: string, token: string, workDir: string) {
  console.log("\n== smoke: " + host + " (device " + device + ") ==");
  config.gatewayHost = host;
  config.deviceId = device;
  config.authToken = token;
  const base = (/^(localhost|127\.)/.test(host) ? "http://" : "https://") + host;
  const auth = { authorization: basic(device, token) };
  const bytes = new Uint8Array(64 * 1024).map((_, i) => (i * 13 + 5) & 0xff);
  const path = join(workDir, "smoke-" + Date.now() + ".bin");
  writeFileSync(path, bytes);
  const before = ((await (await rawFetch(base + "/api/files", { headers: auth })).json()) as any).files.map(
    (f: any) => f.id,
  );
  cdpDownload(7, "g-smoke", "https://files.example.com/smoke.bin");
  addItem(900, "https://files.example.com/smoke.bin", path, bytes.byteLength, "application/octet-stream");
  const r = await command("download", { action: "latest", destination: "gateway", tabId: 7, expiryDays: 1 });
  const after = ((await (await rawFetch(base + "/api/files", { headers: auth })).json()) as any).files;
  const added = after.filter((f: any) => !before.includes(f.id));
  if (r.error) {
    console.log("  download -> gateway refused: " + r.error.message);
    check(
      "a refusal leaves nothing behind on the gateway",
      added.length === 0,
      JSON.stringify(added.map((f: any) => f.name)),
    );
    check("...and keeps the local copy", !calls.removeFile.includes(900));
    return;
  }
  const id = r.result.file.id;
  check(
    "smoke: stored in gateway storage, protected",
    r.result.saved_to === "gateway" && r.result.file.protected === true,
  );
  check("smoke: anonymous read refused", (await rawFetch(base + "/api/files/" + id)).status === 401);
  const owned = new Uint8Array(await (await rawFetch(base + "/api/files/" + id, { headers: auth })).arrayBuffer());
  check("smoke: the device reads back the exact bytes", sameBytes(owned, bytes));
  check("smoke: removed from the device", r.result.removed_from_device === true);
  const up = await command("file_upload", { selector: "#f", source: "gateway", fileId: id, tabId: 7 });
  const injected = calls.callFunctionOn.at(-1)?.arguments?.map((a: any) => a.value) || [];
  check(
    "smoke: uploaded into the page byte-for-byte",
    up.result?.source === "gateway" && sameBytes(b64ToBytes(String(injected[0])), bytes),
    errorOf(up),
  );
  check("smoke: no token in any URL", !seen.some((s) => s.url.includes(token)));
  const del = await rawFetch(base + "/api/files/" + id, { method: "DELETE", headers: auth });
  check("smoke: cleaned up", del.status === 200, String(del.status));
}

const workDir = mkdtempSync(join(tmpdir(), "bmcp-gw-files-"));
let exitCode = 1;
try {
  (globalThis as any).chrome = makeChrome(true);
  await import(SRC + "service-worker.js?cdp=" + Date.now());
  await Bun.sleep(60);
  swListener = (listeners.onMessage || [])[0];
  await import(SRC + "offscreen.js");
  await Bun.sleep(60);
  offscreenListener = (listeners.onMessage || [])[1];
  if (!swListener || !offscreenListener) throw new Error("listeners did not register");

  if (process.env.SMOKE_GATEWAY) {
    await smoke(process.env.SMOKE_GATEWAY, process.env.SMOKE_DEVICE || "", process.env.SMOKE_TOKEN || "", workDir);
    console.log("\n" + pass + " passed, " + fail + " failed");
    if (failures.length) console.log("Failures:\n  - " + failures.join("\n  - "));
    process.exit(fail === 0 ? 0 : 1);
  }
  const fake = startFakeGateway();
  const firstId = (await scenario(fake, workDir)).fileId;
  await toolSurface();

  const dir = process.env.GATEWAY_DIR ? resolve(ROOT, process.env.GATEWAY_DIR) : "";
  const haveCheckout =
    !!dir && existsSync(dir + "/node_modules/.bin/wrangler") && existsSync(dir + "/wrangler.dev.toml");
  if (!dir) {
    console.log("\n== real code-mcp-gateway: not run (set GATEWAY_DIR, or use bun run test:gateway) ==");
  } else if (haveCheckout) {
    const real = await startRealGateway(dir);
    try {
      await scenario(real, workDir);
    } finally {
      real.stop();
    }
  } else {
    throw new Error("GATEWAY_DIR=" + dir + " has no wrangler.dev.toml or installed wrangler");
  }

  // Last, because it replaces the global chrome.
  await webkitUpload(fake, firstId);
  fake.stop();
  exitCode = fail === 0 ? 0 : 1;
} catch (err) {
  fail++;
  failures.push("harness: " + ((err as Error).stack || err));
  console.log("  FAIL harness: " + ((err as Error).stack || err));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (failures.length) console.log("Failures:\n  - " + failures.join("\n  - "));
// The worker and offscreen document keep reconnect timers alive.
process.exit(exitCode);
