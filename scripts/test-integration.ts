#!/usr/bin/env bun
/**
 * test-integration.ts — End-to-end tests for browser-mcp without a real browser:
 *   - MCP JSON-RPC (initialize / tools/list / tools/call)
 *   - file upload/download / file_read
 *   - extension WS bridge (mock extension, incl. Origin + token checks)
 *   - gateway mode (mock code-mcp-gateway)
 */
import { spawn, sleep } from "bun";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = import.meta.dir + "/..";
let failures = 0;
let passed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log("  PASS " + name);
  } else {
    failures++;
    console.log("  FAIL " + name + (detail ? " :: " + String(detail).slice(0, 400) : ""));
  }
}

async function mcpCall(base: string, body: any): Promise<any> {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

// ---- start server A (no auth) ----
const filesDir = ROOT + "/.test-files";
rmSync(filesDir, { recursive: true, force: true });
mkdirSync(filesDir, { recursive: true });
const serverA = spawn(
  ["bun", ROOT + "/browser-mcp.ts", "--port", "7779", "--bind", "127.0.0.1", "--files-dir", filesDir],
  { stdout: "pipe", stderr: "pipe" },
);
await sleep(1200);
const A = "http://127.0.0.1:7779";

console.log("\n== MCP protocol ==");
let r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
});
ok(
  "initialize",
  r.status === 200 &&
    r.json?.result?.serverInfo?.name === "browser-mcp" &&
    r.json?.result?.protocolVersion === "2024-11-05",
  JSON.stringify(r.json),
);

r = await mcpCall(A, { jsonrpc: "2.0", id: 2, method: "ping" });
ok("ping", r.json?.result && typeof r.json.result === "object", JSON.stringify(r.json));

// Notifications (no id): the local server answers with 204 No Content
// (spec-correct) - strict clients like codex/pi reject a response body.
r = await mcpCall(A, { jsonrpc: "2.0", method: "notifications/initialized" });
ok("notification 204 no content", r.status === 204, "status " + r.status + " body " + JSON.stringify(r.json));

r = await mcpCall(A, { jsonrpc: "2.0", id: 3, method: "tools/list" });
ok(
  "tools/list 67 tools",
  r.json?.result?.tools?.length === 67,
  "got " + (r.json?.result?.tools?.length ?? "?") + " tools",
);
const names = (r.json?.result?.tools ?? []).map((t: any) => t.name);
ok("has navigate", names.includes("navigate"));
ok("has file_read", names.includes("file_read"));
const navSchema = (r.json?.result?.tools ?? []).find((t: any) => t.name === "navigate");
ok(
  "navigate inputSchema",
  navSchema?.inputSchema?.type === "object" && navSchema.inputSchema.required?.includes("url"),
);

r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "status", arguments: {} },
});
ok(
  "status disconnected (status query, not error)",
  r.json?.result?.isError !== true && (r.json?.result?.content?.[0]?.text ?? "").includes('"connected": false'),
  JSON.stringify(r.json?.result),
);

r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 5,
  method: "tools/call",
  params: { name: "tabs", arguments: {} },
});
ok("tabs no extension -> error", r.json?.result?.isError === true, JSON.stringify(r.json?.result));

r = await mcpCall(A, { jsonrpc: "2.0", id: 6, method: "unknown_method" });
ok("unknown method -> -32601", r.json?.error?.code === -32601, JSON.stringify(r.json));

console.log("\n== CSRF origin gate on /mcp ==");
r = await fetch(A + "/mcp", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    origin: "https://evil.example",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "execute", arguments: { code: "1" } },
  }),
});
ok("evil web origin -> 403 (blocked)", r.status === 403, "status=" + r.status);
r = await fetch(A + "/mcp", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    origin: "http://localhost:3000",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" }),
});
ok("localhost origin -> allowed", r.status === 200, "status=" + r.status);
r = await fetch(A + "/mcp", {
  method: "OPTIONS",
  headers: { origin: "https://evil.example" },
});
ok("preflight evil origin -> 403", r.status === 403, "status=" + r.status);

console.log("\n== Files ==");
const form = new FormData();
form.append("file", new Blob(["hello browser-mcp"], { type: "text/plain" }), "greeting.txt");
r = await fetch(A + "/files/upload", { method: "POST", body: form });
const up = await r.json();
ok(
  "upload returns file_id",
  r.status === 200 && up?.ok === true && /^[a-f0-9]{12}$/.test(up.file?.id ?? ""),
  JSON.stringify(up),
);
const fileId = up.file?.id ?? "";

r = await fetch(A + "/files/" + fileId);
ok("download roundtrip", r.status === 200 && (await r.text()) === "hello browser-mcp", "status=" + r.status);
ok("download disposition", (r.headers.get("content-disposition") ?? "").includes("greeting.txt"));

r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name: "file_read", arguments: { file_id: fileId } },
});
ok(
  "file_read inline text",
  /hello browser-mcp/.test(r.json?.result?.content?.[0]?.text ?? ""),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);

r = await fetch(A + "/files/../../etc/passwd");
ok("path traversal rejected", r.status === 400 || r.status === 404, "status=" + r.status);

console.log("\n== Extension bridge (mock extension) ==");

// Origin rejection: no Origin header -> 403
const badWs = await fetch("http://127.0.0.1:7779/browser/ws?extId=evil");
ok("no Origin -> rejected", badWs.status === 403, "status=" + badWs.status);

// Origin rejection: web page origin -> 403
const evilWs = await fetch("http://127.0.0.1:7779/browser/ws?extId=evil2", {
  headers: { origin: "https://evil.example" },
});
ok("evil origin -> rejected", evilWs.status === 403, "status=" + evilWs.status);

// Mock extension connects with chrome-extension:// origin
const commands: Array<{ id: string; method: string; params: any }> = [];
const extWs = new WebSocket("ws://127.0.0.1:7779/browser/ws?extId=mock1", {
  headers: { origin: "chrome-extension://abcdefgh" },
});
const extReady = new Promise<void>((resolve) => {
  extWs.addEventListener("open", () => resolve());
});
await extReady;
ok("extension connected (open)", extWs.readyState === WebSocket.OPEN);

extWs.addEventListener("message", (ev: any) => {
  const data = JSON.parse(ev.data);
  if (data.type === "ping") {
    extWs.send(JSON.stringify({ type: "pong" }));
    return;
  }
  if (data.id && data.method) {
    commands.push({
      id: data.id,
      method: data.method,
      params: data.params ?? {},
    });
    // canned replies
    if (data.method === "tabs")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: {
            tabs: [
              {
                id: 1,
                title: "Mock Tab",
                url: "https://example.com",
                active: true,
                windowId: 1,
              },
            ],
          },
        }),
      );
    else if (data.method === "navigate")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: { tabId: 7, url: "https://example.com", title: "Example" },
        }),
      );
    else if (data.method === "screenshot")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: {
            tabId: 7,
            dataUrl: "data:image/jpeg;base64," + Buffer.from("fakejpeg").toString("base64"),
          },
        }),
      );
    else if (data.method === "store")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: { stored: true, key: data.params?.key },
        }),
      );
    else if (data.method === "execute") extWs.send(JSON.stringify({ id: data.id, result: { value: 42 } }));
    else if (data.method === "snapshot")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: {
            url: "https://example.com",
            title: "Example",
            entries: [
              {
                role: "button",
                tag: "button",
                name: "Submit",
                selector: "#submit",
                value: "",
              },
              {
                role: "textbox",
                tag: "input",
                name: "Name",
                selector: "#name",
                value: "",
              },
              {
                role: "checkbox",
                tag: "input",
                name: "Subscribe",
                selector: "#sub",
                checked: false,
              },
            ],
          },
        }),
      );
    else if (data.method === "find")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: {
            matches: [
              {
                role: "button",
                tag: "button",
                name: "Submit",
                selector: "#submit",
                value: "",
              },
            ],
          },
        }),
      );
    else if (data.method === "get_element")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: { exists: true, tag: "input", value: "hello", text: "hello" },
        }),
      );
    else if (data.method === "is_element")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: { exists: true, check: data.params?.check, result: true },
        }),
      );
    else if (
      data.method === "click" ||
      data.method === "dblclick" ||
      data.method === "focus" ||
      data.method === "fill" ||
      data.method === "check" ||
      data.method === "uncheck"
    )
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: {
            tabId: 7,
            element: data.params?.selector,
            checked: data.method === "check",
          },
        }),
      );
    else if (data.method === "reload" || data.method === "back" || data.method === "forward")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: { tabId: 7, url: "https://example.com", title: "Example" },
        }),
      );
    else if (data.method === "close") extWs.send(JSON.stringify({ id: data.id, result: { closed: 7 } }));
    else if (data.method === "storage")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: { items: { k1: "v1" }, count: 1 },
        }),
      );
    else if (data.method === "pdf")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: {
            data: Buffer.from("%PDF-1.4 fake").toString("base64"),
            tabId: 7,
          },
        }),
      );
    else if (data.method === "set")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: {
            tabId: 7,
            viewport: {
              width: data.params?.width,
              height: data.params?.height,
            },
          },
        }),
      );
    else if (data.method === "highlight") extWs.send(JSON.stringify({ id: data.id, result: { tabId: 7 } }));
    else if (data.method === "window")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: {
            windows: [
              {
                id: 1,
                focused: true,
                type: "normal",
                tabs: [
                  {
                    id: 1,
                    title: "Mock Tab",
                    url: "https://example.com",
                    active: true,
                  },
                ],
              },
            ],
          },
        }),
      );
    else if (data.method === "console")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: {
            messages: [{ type: "log", text: "hello from page", ts: 1 }],
            count: 1,
          },
        }),
      );
    else if (data.method === "errors")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: { errors: [{ text: "TypeError: x", ts: 1 }], count: 1 },
        }),
      );
    else if (data.method === "network")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: {
            requests: [
              {
                url: "https://example.com/api",
                method: "GET",
                status: 200,
                mimeType: "application/json",
              },
            ],
            count: 1,
          },
        }),
      );
    else if (data.method === "wait")
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: { tabId: 7, found: true, waited: 250 },
        }),
      );
    else
      extWs.send(
        JSON.stringify({
          id: data.id,
          result: { ok: true, tabId: data.params?.tabId ?? null },
        }),
      );
  }
});

// status now connected
r = await fetch(A + "/health");
const health = await r.json();
ok("health extensionConnected", health.extensionConnected === true, JSON.stringify(health));

// navigate through the bridge
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 10,
  method: "tools/call",
  params: { name: "navigate", arguments: { url: "https://example.com" } },
});
ok(
  "navigate via bridge",
  r.json?.result?.content?.[0]?.text?.includes('"tab_id": 7') &&
    r.json?.result?.content?.[0]?.text?.includes("Example"),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);
ok(
  "bridge received navigate command",
  commands.some((c) => c.method === "navigate" && c.params.url === "https://example.com"),
);

// tabs through the bridge
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 11,
  method: "tools/call",
  params: { name: "tabs", arguments: { action: "list" } },
});
ok(
  "tabs via bridge",
  r.json?.result?.content?.[0]?.text?.includes("Mock Tab"),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);

// screenshot returns image content block
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 12,
  method: "tools/call",
  params: { name: "screenshot", arguments: {} },
});
const blocks = r.json?.result?.content ?? [];
ok(
  "screenshot image block",
  blocks.some((b: any) => b.type === "image" && b.mimeType === "image/jpeg"),
  JSON.stringify(blocks.map((b: any) => b.type)),
);

// store roundtrip
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 13,
  method: "tools/call",
  params: {
    name: "store",
    arguments: { action: "set", key: "k1", value: "v1" },
  },
});
ok(
  "store via bridge",
  (r.json?.result?.content?.[0]?.text ?? "").includes("stored"),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);

// agent-browser port: snapshot + @ref system
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 20,
  method: "tools/call",
  params: { name: "snapshot", arguments: {} },
});
const snapText = r.json?.result?.content?.[0]?.text ?? "";
ok(
  "snapshot assigns refs",
  snapText.includes("[ref=e1]") && snapText.includes("[ref=e2]") && snapText.includes("[ref=e3]"),
  snapText.slice(0, 200),
);
ok(
  "snapshot shows roles",
  snapText.includes('button "Submit"') && snapText.includes('textbox "Name"'),
  snapText.slice(0, 200),
);

// click by ref (dispatcher resolves e2 -> #name)
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 21,
  method: "tools/call",
  params: { name: "click", arguments: { ref: "e2" } },
});
ok(
  "click via ref",
  (r.json?.result?.content?.[0]?.text ?? "").includes("clicked"),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);
ok(
  "ref resolved to selector",
  commands.some((c) => c.method === "click" && c.params.selector === "#name"),
  JSON.stringify(commands.filter((c) => c.method === "click").map((c) => c.params)),
);

// stale ref error
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 22,
  method: "tools/call",
  params: { name: "click", arguments: { ref: "e99" } },
});
ok(
  "stale ref -> helpful error",
  r.json?.result?.isError === true && /Run snapshot again/.test(r.json?.result?.content?.[0]?.text ?? ""),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);

// find
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 23,
  method: "tools/call",
  params: { name: "find", arguments: { role: "button", name: "Submit" } },
});
ok(
  "find returns ref",
  (r.json?.result?.content?.[0]?.text ?? "").includes("[ref="),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);

// get / is
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 24,
  method: "tools/call",
  params: { name: "get", arguments: { property: "value", selector: "#name" } },
});
ok(
  "get value",
  (r.json?.result?.content?.[0]?.text ?? "").includes("hello"),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 25,
  method: "tools/call",
  params: { name: "is", arguments: { check: "visible", selector: "#name" } },
});
ok(
  "is visible -> true",
  (r.json?.result?.content?.[0]?.text ?? "").trim() === "true",
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);

// fill / check / uncheck / focus / dblclick
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 26,
  method: "tools/call",
  params: { name: "fill", arguments: { text: "abc", selector: "#name" } },
});
ok(
  "fill sends clear-first type",
  commands.some((c) => c.method === "fill" && c.params.selector === "#name"),
  JSON.stringify(commands.filter((c) => c.method === "fill")),
);
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 27,
  method: "tools/call",
  params: { name: "check", arguments: { selector: "#sub" } },
});
ok(
  "check",
  (r.json?.result?.content?.[0]?.text ?? "").includes("checked"),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 28,
  method: "tools/call",
  params: { name: "uncheck", arguments: { ref: "e3" } },
});
ok(
  "uncheck via ref",
  (r.json?.result?.content?.[0]?.text ?? "").includes("false"),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 29,
  method: "tools/call",
  params: { name: "focus", arguments: { ref: "e2" } },
});
ok(
  "focus via ref",
  (r.json?.result?.content?.[0]?.text ?? "").includes("focused"),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 30,
  method: "tools/call",
  params: { name: "dblclick", arguments: { selector: "#name" } },
});
ok(
  "dblclick",
  commands.some((c) => c.method === "dblclick"),
  "ok",
);

// reload / back / forward / close / wait / highlight
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 31,
  method: "tools/call",
  params: { name: "reload", arguments: {} },
});
ok("reload", (r.json?.result?.content?.[0]?.text ?? "").includes("reloaded"));
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 32,
  method: "tools/call",
  params: { name: "back", arguments: {} },
});
ok("back", (r.json?.result?.content?.[0]?.text ?? "").includes("back"));
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 33,
  method: "tools/call",
  params: { name: "forward", arguments: {} },
});
ok("forward", (r.json?.result?.content?.[0]?.text ?? "").includes("forward"));
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 34,
  method: "tools/call",
  params: { name: "wait", arguments: { mode: "text", text: "hello" } },
});
ok(
  "wait text",
  (r.json?.result?.content?.[0]?.text ?? "").includes("found"),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 35,
  method: "tools/call",
  params: { name: "highlight", arguments: { ref: "e1" } },
});
ok("highlight", (r.json?.result?.content?.[0]?.text ?? "").includes("highlighted"));

// storage / pdf / set / window
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 36,
  method: "tools/call",
  params: { name: "storage", arguments: { action: "get", type: "local" } },
});
ok(
  "storage get",
  (r.json?.result?.content?.[0]?.text ?? "").includes("k1"),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 37,
  method: "tools/call",
  params: { name: "pdf", arguments: { format: "a4" } },
});
ok(
  "pdf -> file_id",
  /file_id/.test(r.json?.result?.content?.[0]?.text ?? ""),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 38,
  method: "tools/call",
  params: {
    name: "set",
    arguments: { property: "viewport", width: 1920, height: 1080 },
  },
});
ok(
  "set viewport",
  (r.json?.result?.content?.[0]?.text ?? "").includes("1920"),
  JSON.stringify(r.json?.result?.content?.[0]?.text),
);
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 39,
  method: "tools/call",
  params: { name: "window", arguments: { action: "list" } },
});
ok("window list", (r.json?.result?.content?.[0]?.text ?? "").includes("Mock Tab"));

// console / errors / network
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 40,
  method: "tools/call",
  params: { name: "console", arguments: { action: "view" } },
});
ok("console", (r.json?.result?.content?.[0]?.text ?? "").includes("hello from page"));
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 41,
  method: "tools/call",
  params: { name: "errors", arguments: { action: "view" } },
});
ok("errors", (r.json?.result?.content?.[0]?.text ?? "").includes("TypeError"));
r = await mcpCall(A, {
  jsonrpc: "2.0",
  id: 42,
  method: "tools/call",
  params: { name: "network", arguments: { action: "view" } },
});
ok("network", (r.json?.result?.content?.[0]?.text ?? "").includes("example.com/api"));

// new tool names are shortened
r = await mcpCall(A, { jsonrpc: "2.0", id: 43, method: "tools/list" });
const allNames = (r.json?.result?.tools ?? []).map((x: any) => x.name);
ok(
  "renamed tools (press/dialog/upload/perms)",
  allNames.includes("press") &&
    allNames.includes("dialog") &&
    allNames.includes("upload") &&
    allNames.includes("perms"),
);
ok(
  "no tool keeps a browser_ prefix",
  allNames.every((n: string) => !n.startsWith("browser_")),
);
// DevTools-grade tools added (matching OpenTabs feature set)
ok(
  "devtools tools present",
  [
    "notify",
    "groups",
    "bookmarks",
    "session",
    "intercept",
    "har",
    "ws",
    "throttle",
    "resources",
    "coverage",
    "pseudo",
    "styles",
    "site_data",
    "extension",
    "vault",
    "record",
    "speak",
    "transcript",
    "paint",
  ].every((t) => allNames.includes(t)),
  "missing: " +
    [
      "notify",
      "groups",
      "bookmarks",
      "session",
      "intercept",
      "har",
      "ws",
      "throttle",
      "resources",
      "coverage",
      "pseudo",
      "styles",
      "site_data",
      "extension",
      "vault",
      "record",
      "speak",
      "transcript",
      "paint",
    ]
      .filter((t) => !allNames.includes(t))
      .join(","),
);
// transcript/paint tools expose their action enums
const transcriptTool = (r.json?.result?.tools ?? []).find((x: any) => x.name === "transcript");
ok(
  "transcript schema has show/clear/status",
  !!transcriptTool?.inputSchema?.properties?.action?.enum?.includes("show") &&
    !!transcriptTool?.inputSchema?.properties?.action?.enum?.includes("clear") &&
    !!transcriptTool?.inputSchema?.properties?.action?.enum?.includes("status"),
);
const paintTool = (r.json?.result?.tools ?? []).find((x: any) => x.name === "paint");
ok(
  "paint schema has draw/clear/status + shape enum (incl label)",
  !!paintTool?.inputSchema?.properties?.action?.enum?.includes("draw") &&
    !!paintTool?.inputSchema?.properties?.shape?.enum?.includes("arrow") &&
    !!paintTool?.inputSchema?.properties?.shape?.enum?.includes("label"),
);
// dialog tool exposes status (JS dialog inspection) + click passthrough of dialog_opened
const dialogTool = (r.json?.result?.tools ?? []).find((x: any) => x.name === "dialog");
ok("dialog schema has status action", !!dialogTool?.inputSchema?.properties?.action?.enum?.includes("status"));
// vault schema exposes action enum
const vaultTool = (r.json?.result?.tools ?? []).find((x: any) => x.name === "vault");
ok("vault schema has action enum", !!vaultTool?.inputSchema?.properties?.action?.enum?.includes("unlock"));
// ref param injected into click schema
const clickTool = allNames.length ? null : null;
const schemaTool = (r.json?.result?.tools ?? []).find((x: any) => x.name === "click");
ok("click schema has ref", !!schemaTool?.inputSchema?.properties?.ref);

// extension disconnect -> pending cleanup
extWs.close();
await sleep(300);
r = await fetch(A + "/health");
ok("health extensionDisconnected after close", (await r.json()).extensionConnected === false);

serverA.kill();

// ===========================================================================
console.log("\n== Auth (token + extension-token) ==");
const serverB = spawn(
  [
    "bun",
    ROOT + "/browser-mcp.ts",
    "--port",
    "7781",
    "--bind",
    "127.0.0.1",
    "--token",
    "sekrit",
    "--extension-token",
    "extsekrit",
    "--files-dir",
    filesDir,
  ],
  {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BMCP_GATEWAY_DOMAIN: "127.0.0.1:1" },
  },
);
await sleep(1200);
const B = "http://127.0.0.1:7781";

r = await mcpCall(B, { jsonrpc: "2.0", id: 1, method: "tools/list" });
ok("mcp without token -> 401", r.status === 401, "status=" + r.status);
r = await fetch(B + "/mcp?token=sekrit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
});
ok("mcp with query token -> 200", r.status === 200);
r = await fetch(B + "/mcp", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer sekrit",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
});
ok("mcp with bearer token -> 200", r.status === 200);

// extension WS without extension-token -> 401
const extNoToken = await fetch(B + "/browser/ws?extId=mock2", {
  headers: { origin: "chrome-extension://abcdefgh" },
});
ok("ws without extension token -> 401", extNoToken.status === 401, "status=" + extNoToken.status);
const extWrongToken = await fetch(B + "/browser/ws?extId=mock2&token=wrong", {
  headers: { origin: "chrome-extension://abcdefgh" },
});
ok("ws with wrong extension token -> 401", extWrongToken.status === 401);
// extension upload without token -> 401
const f2 = new FormData();
f2.append("file", new Blob(["x"]), "x.txt");
r = await fetch(B + "/browser/files/upload", { method: "POST", body: f2 });
ok("browser files upload without token -> 401", r.status === 401);

// Popup gateway flow: extension connects with deviceId + token (the token serves BOTH the
// extension channel AND becomes the /mcp auth token the gateway forwards).
const popupWs = new WebSocket("ws://127.0.0.1:7781/browser/ws?extId=mock3&deviceId=dev-popup&token=extsekrit", {
  headers: { origin: "chrome-extension://abcdefgh" },
});
const popupOpen = await new Promise<boolean>((resolve) => {
  const to = setTimeout(() => resolve(false), 3000);
  popupWs.addEventListener("open", () => {
    clearTimeout(to);
    resolve(true);
  });
});
ok("popup WS connects (token satisfies extension channel)", popupOpen === true);
await sleep(300);
r = await mcpCall(B, { jsonrpc: "2.0", id: 90, method: "tools/list" });
ok("popup token gates /mcp (no token -> 401)", r.status === 401, "status=" + r.status);
r = await fetch(B + "/mcp?token=extsekrit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "ping" }),
});
ok("popup token accepted on /mcp", r.status === 200, "status=" + r.status);
r = await fetch(B + "/mcp?token=sekrit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 92, method: "ping" }),
});
ok("CLI --token no longer accepted once popup token set", r.status === 401, "status=" + r.status);
popupWs.close();
serverB.kill();

// ===========================================================================
console.log("\n== Gateway mode (mock gateway) ==");

// Mock code-mcp-gateway: accepts WS, replies keepalive-ack, forwards requests to local /mcp
const gwMsgs: string[] = [];
let gwDeviceId: string | null = null;
let gwForwardOk = false;
const gwServer = Bun.serve({
  port: 7780,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    if (srv.upgrade(req)) return undefined;
    return new Response("ws only", { status: 400 });
  },
  websocket: {
    open(ws) {},
    message(ws, message) {
      const data = JSON.parse(message.toString());
      if (data.type === "register") {
        gwDeviceId = data.deviceId;
        gwMsgs.push("register:" + data.deviceId);
        return;
      }
      if (data.type === "keepalive") {
        ws.send(JSON.stringify({ type: "keepalive-ack" }));
        gwMsgs.push("keepalive");
        return;
      }
      if (data.id != null && data.request) {
        gwMsgs.push("request:" + data.request.method);
        // forward to the local /mcp like the real gateway does
        (async () => {
          const res = await fetch("http://127.0.0.1:7782/mcp?token=gw-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data.request),
          });
          const resp = await res.json();
          gwForwardOk = gwForwardOk || resp?.result?.serverInfo?.name === "browser-mcp";
          ws.send(JSON.stringify({ id: data.id, response: resp }));
        })();
      }
    },
    close(ws) {},
  },
});

const serverC = spawn(
  [
    "bun",
    ROOT + "/browser-mcp.ts",
    "--port",
    "7782",
    "--bind",
    "127.0.0.1",
    "--token",
    "gw-token",
    "--gateway",
    "127.0.0.1:7780",
    "--id",
    "test-device",
    "--files-dir",
    filesDir,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
await sleep(1500);

// client connects to the gateway WS and sends an MCP request through it
const gwClient = new WebSocket("ws://127.0.0.1:7780/ws/test-device");
await new Promise<void>((resolve) => gwClient.addEventListener("open", () => resolve()));
gwClient.send(JSON.stringify({ type: "register", deviceId: "test-device" }));
gwClient.send(
  JSON.stringify({
    id: 100,
    request: { jsonrpc: "2.0", id: 100, method: "initialize", params: {} },
  }),
);
const initResp = await new Promise<any>((resolve) => {
  const t = setTimeout(() => resolve(null), 4000);
  gwClient.addEventListener("message", (ev: any) => {
    const d = JSON.parse(ev.data);
    if (d.id === 100) {
      clearTimeout(t);
      resolve(d);
    }
  });
});
ok(
  "gateway forward -> initialize response",
  initResp?.response?.result?.serverInfo?.name === "browser-mcp",
  JSON.stringify(initResp),
);
ok("gateway received register", gwMsgs.includes("register:test-device"));
ok("gateway forwarded request", gwMsgs.includes("request:initialize"));
ok("gateway forward hit local /mcp", gwForwardOk);

// wait for a keepalive to confirm liveness protocol works
await sleep(300);
gwClient.close();
gwServer.stop(true);
serverC.kill();

console.log("\n========== RESULTS: " + passed + " passed, " + failures + " failed ==========");
process.exit(failures > 0 ? 1 : 0);
