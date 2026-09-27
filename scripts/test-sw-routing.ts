#!/usr/bin/env bun
/**
 * test-sw-routing.ts - loads the REAL service-worker.js under a mock `chrome`
 * and proves the capability routing. This is the regression guard for
 * "Chrome behaviour must not change":
 *
 *   1. the module EVALUATES on a browser without chrome.debugger (WebKit) -
 *      an unguarded top-level chrome.debugger access used to abort the worker,
 *      which is why nothing worked in Orion/iPadOS
 *   2. a CDP-capable browser drives `check` through the DevTools Protocol
 *   3. a CDP-less browser drives `check` through chrome.scripting only
 *   4. page instrumentation is registered ONLY where CDP is missing
 */
const SW = "../packages/browser-extension/src/service-worker.js";

let pass = 0;
let fail = 0;
const failures: string[] = [];
const ok = (name: string) => {
  pass++;
  console.log("  PASS " + name);
};
const bad = (name: string, why: string) => {
  fail++;
  failures.push(name + ": " + why);
  console.log("  FAIL " + name + ": " + why);
};

function makeChrome(opts: { debugger: boolean; offscreen: boolean; registerContentScripts?: boolean }) {
  const calls = {
    sendCommand: [] as string[],
    executeScript: [] as any[],
    registered: [] as any[],
    tabMessages: [] as any[],
  };
  const listeners: Record<string, Function[]> = {};
  const add = (k: string) => (fn: Function) => {
    (listeners[k] ||= []).push(fn);
  };
  const chrome: any = {
    runtime: {
      id: "bmcptest",
      getURL: (p: string) => "chrome-extension://bmcptest/" + p,
      onMessage: { addListener: add("onMessage") },
      onConnect: { addListener: add("onConnect") },
      onInstalled: { addListener: add("onInstalled") },
      onStartup: { addListener: add("onStartup") },
      sendMessage: async () => ({}),
      connect: () => ({ disconnect() {}, onDisconnect: { addListener() {} } }),
      lastError: null,
    },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    tabs: {
      query: async () => [{ id: 7, url: "https://example.com/", title: "Example", active: true }],
      get: async () => ({ id: 7, url: "https://example.com/", title: "Example" }),
      sendMessage: async (_tabId: any, message: any) => {
        calls.tabMessages.push(message);
        return {};
      },
      update: async () => ({ id: 7, url: "https://example.com/" }),
      onCreated: { addListener: add("tabsCreated") },
      onRemoved: { addListener: add("tabsRemoved") },
      onUpdated: { addListener: add("tabsUpdated") },
      onActivated: { addListener: add("tabsActivated") },
    },
    scripting: {
      executeScript: async (arg: any) => {
        calls.executeScript.push(arg);
        // unchecked + changed, so handleCheck proceeds to its CDP click path
        return [{ frameId: 0, result: { checked: false, changed: true } }];
      },
      registerContentScripts: async (s: any) => {
        calls.registered.push(s);
      },
      getRegisteredContentScripts: async () => [],
    },
    action: { setIcon: async () => {} },
    notifications: {
      onClicked: { addListener: add("nClick") },
      onClosed: { addListener: add("nClose") },
      create: async () => "1",
    },
    downloads: {
      setUiOptions: async () => {},
      onCreated: { addListener: add("dlCreated") },
      onChanged: { addListener: add("dlChanged") },
    },
    windows: { onFocusChanged: { addListener: add("winFocus") } },
    webNavigation: {},
    cookies: {},
    history: { search: async () => [] },
    permissions: {},
  };
  if (opts.debugger) {
    chrome.debugger = {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_t: any, method: string) => {
        calls.sendCommand.push(method);
        return {};
      },
      onEvent: { addListener: add("dbgEvent") },
      onDetach: { addListener: add("dbgDetach") },
    };
  }
  if (opts.offscreen) {
    chrome.offscreen = { hasDocument: async () => true, createDocument: async () => {}, closeDocument: async () => {} };
  }
  if (opts.registerContentScripts === false) {
    delete chrome.scripting.registerContentScripts;
  }
  return { chrome, calls, listeners };
}

let seq = 0;
async function load(opts: { debugger: boolean; offscreen: boolean; registerContentScripts?: boolean }) {
  const m = makeChrome(opts);
  (globalThis as any).chrome = m.chrome;
  // A distinct specifier gives a fresh module instance per scenario.
  await import(SW + "?scenario=" + ++seq);
  await new Promise((r) => setTimeout(r, 60));
  return m;
}

function command(m: any, method: string, params: any): Promise<any> {
  const listener = (m.listeners.onMessage || [])[0];
  if (!listener) return Promise.reject(new Error("no onMessage listener registered"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no response for " + method)), 5000);
    listener(
      { source: "offscreen", type: "command", id: 1, method, params },
      { id: "bmcptest", url: "chrome-extension://bmcptest/src/offscreen.html" },
      (resp: any) => {
        clearTimeout(timer);
        resolve(resp);
      },
    );
  });
}

const usedSelector = (c: any) => Array.isArray(c.args) && c.args[0] === "#agree";

console.log("== Chrome / Edge (chrome.debugger present) ==");
{
  const m = await load({ debugger: true, offscreen: true });
  let responded = false;
  try {
    await command(m, "check", { selector: "#agree" });
    responded = true;
  } catch (e) {
    bad("chrome: check responds", String((e as Error).message));
  }
  if (responded) ok("chrome: check responds");
  if (m.calls.sendCommand.length > 0) {
    ok("chrome: check ran through the DevTools Protocol (" + m.calls.sendCommand.slice(0, 3).join(", ") + ")");
  } else {
    bad("chrome: check ran through the DevTools Protocol", "no debugger commands were issued");
  }
  if (m.calls.registered.length === 0) ok("chrome: page instrumentation NOT registered (no injected scripts)");
  else bad("chrome: page instrumentation NOT registered", JSON.stringify(m.calls.registered));
}

console.log("\n== WebKit (no chrome.debugger, no chrome.offscreen) ==");
{
  let m: any = null;
  try {
    m = await load({ debugger: false, offscreen: false });
    ok("webkit: service worker evaluates without chrome.debugger");
  } catch (e) {
    bad("webkit: service worker evaluates without chrome.debugger", String((e as Error).message));
  }
  if (m) {
    let responded = false;
    try {
      await command(m, "check", { selector: "#agree" });
      responded = true;
    } catch (e) {
      bad("webkit: check responds", String((e as Error).message));
    }
    if (responded) ok("webkit: check responds");
    if (m.calls.sendCommand.length === 0) ok("webkit: no DevTools Protocol calls attempted");
    else bad("webkit: no DevTools Protocol calls attempted", m.calls.sendCommand.join(", "));
    if (m.calls.executeScript.some(usedSelector)) ok("webkit: check ran through chrome.scripting");
    else bad("webkit: check ran through chrome.scripting", JSON.stringify(m.calls.executeScript.map((c: any) => c.args)).slice(0, 160));
    const registered = m.calls.registered.flat();
    if (registered.length === 2) ok("webkit: page instrumentation registered (relay + MAIN shim)");
    else bad("webkit: page instrumentation registered", JSON.stringify(registered.map((r: any) => r.id)));
    if (registered.some((r: any) => r.world === "MAIN")) ok("webkit: instrumentation shim targets the MAIN world");
    else bad("webkit: instrumentation shim targets the MAIN world", "no MAIN-world registration");
    if (registered.every((r: any) => r.runAt === "document_start")) ok("webkit: instrumentation runs at document_start");
    else bad("webkit: instrumentation runs at document_start", JSON.stringify(registered.map((r: any) => r.runAt)));
  }
}

console.log("\n== WebKit: every routed method stays CDP-free ==");
{
  const m = await load({ debugger: false, offscreen: false });
  const cases: Array<[string, any]> = [
    ["check", { selector: "#agree" }],
    ["uncheck", { selector: "#agree" }],
    ["styles", { selector: "#agree" }],
    ["frames", {}],
    ["file_upload", { selector: "#f", content: "aGk=", filename: "a.txt" }],
    ["drag", { fromSelector: "#a", toSelector: "#b" }],
    ["console", {}],
    ["errors", {}],
    ["dialog", { action: "status" }],
    ["snapshot", {}],
    ["navigate", { url: "https://example.com/" }],
  ];
  for (const entry of cases) {
    const method = entry[0];
    const params = entry[1];
    const before = m.calls.sendCommand.length;
    let err: string | null = null;
    try {
      await command(m, method, params);
    } catch (e) {
      err = String((e as Error).message);
    }
    const delta = m.calls.sendCommand.length - before;
    if (delta === 0) ok("webkit: " + method + " issued no DevTools Protocol calls");
    else bad("webkit: " + method + " issued no DevTools Protocol calls", delta + " call(s): " + m.calls.sendCommand.slice(before).join(", "));
    if (err) bad("webkit: " + method + " completed", err);
  }
}

console.log("\n== Chrome: the same methods still take the CDP path ==");
{
  const m = await load({ debugger: true, offscreen: true });
  const cases: Array<[string, any]> = [
    ["check", { selector: "#agree" }],
    ["styles", { selector: "#agree" }],
    ["frames", {}],
    ["drag", { fromSelector: "#a", toSelector: "#b" }],
    ["file_upload", { selector: "#f", content: "aGk=", filename: "a.txt" }],
    ["console", {}],
  ];
  // Counting debugger commands is unreliable here: ensureDebugger/ensureCdpDomain
  // are memoised, so later calls legitimately issue none. Instead assert the
  // response never carries a CDP-free marker - only dispatchCdpFree emits the
  // "needs the DevTools Protocol" notes.
  for (const entry of cases) {
    const method = entry[0];
    const params = entry[1];
    let body = "";
    try {
      const resp: any = await command(m, method, params);
      body = JSON.stringify(resp && resp.result !== undefined ? resp.result : resp);
    } catch (e) {
      body = "threw: " + String((e as Error).message);
    }
    if (!/DevTools Protocol|this browser does not provide|unavailable in this browser/i.test(body)) {
      ok("chrome: " + method + " did not take the CDP-free path");
    } else {
      bad("chrome: " + method + " did not take the CDP-free path", body.slice(0, 160));
    }
  }
  if (m.calls.registered.length === 0) ok("chrome: no page instrumentation after the full run");
  else bad("chrome: no page instrumentation after the full run", JSON.stringify(m.calls.registered));
}

console.log("\n== WebKit: capability gaps produce actionable errors, not TypeErrors ==");
{
  const m = await load({ debugger: false, offscreen: false });
  const cases: Array<[string, any, RegExp]> = [
    ["groups", { action: "list" }, /chrome\.tabGroups/],
    ["site_data", { origin: "https://example.com" }, /chrome\.browsingData/],
  ];
  for (const entry of cases) {
    let text = "";
    try {
      const resp: any = await command(m, entry[0], entry[1]);
      text = JSON.stringify(resp);
    } catch (e) {
      text = String((e as Error).message);
    }
    if (entry[2].test(text)) ok("webkit: " + entry[0] + " explains the missing API");
    else bad("webkit: " + entry[0] + " explains the missing API", text.slice(0, 150));
  }
}

console.log("\n== WebKit: check reports the state the page actually reached ==");
{
  const m = await load({ debugger: false, offscreen: false });
  let checked: any = "unset";
  try {
    const resp: any = await command(m, "check", { selector: "#agree" });
    checked = resp && resp.result ? resp.result.checked : "no result";
  } catch {}
  if (checked === false) ok("webkit: check reports checked=false when the page stayed unchecked");
  else bad("webkit: check reports the real state", String(checked));
}

console.log("\n== WebKit without registerContentScripts: on-demand injection ==");
{
  const m = await load({ debugger: false, offscreen: false, registerContentScripts: false });
  const before = m.calls.executeScript.length;
  try {
    await command(m, "console", { action: "view" });
  } catch {}
  const injected = m.calls.executeScript
    .slice(before)
    .some((c: any) => Array.isArray(c.files) && c.files.indexOf("src/page-instrument.js") !== -1);
  if (injected) ok("webkit: console injects the instrumentation on demand");
  else bad("webkit: console injects the instrumentation on demand", "no file injection observed");
  if (m.calls.registered.length === 0) ok("webkit: nothing statically registered when the API is missing");
  else bad("webkit: nothing statically registered when the API is missing", JSON.stringify(m.calls.registered));
}

console.log("\n== Capture feedback: no border glow, flash only for screenshots ==");
{
  const m = await load({ debugger: true, offscreen: true });

  await command(m, "snapshot", {}).catch(() => {});
  const glow = m.calls.tabMessages.filter(
    (x: any) => x.type === "show-agent-overlay" || x.type === "hide-agent-overlay",
  );
  if (glow.length === 0) ok("no agent-overlay (glow) messages are ever sent");
  else bad("no agent-overlay (glow) messages are ever sent", JSON.stringify(glow));

  const beforeSnap = m.calls.tabMessages.length;
  await command(m, "snapshot", {}).catch(() => {});
  const snapTypes = m.calls.tabMessages.slice(beforeSnap).map((x: any) => x.type);
  if (snapTypes.indexOf("flash-capture") === -1) ok("a non-capture command does not flash");
  else bad("a non-capture command does not flash", JSON.stringify(snapTypes));

  const beforeShot = m.calls.tabMessages.length;
  try {
    await command(m, "screenshot", { tabId: 7 });
  } catch {}
  const shotTypes = m.calls.tabMessages.slice(beforeShot).map((x: any) => x.type);
  const cleared = shotTypes.indexOf("clear-capture-flash");
  const flashed = shotTypes.indexOf("flash-capture");
  if (cleared !== -1 && flashed !== -1) ok("screenshot clears any old flash and then flashes");
  else bad("screenshot clears any old flash and then flashes", JSON.stringify(shotTypes));
  if (cleared !== -1 && flashed !== -1 && cleared < flashed) ok("the flash is fired only after the capture");
  else bad("the flash is fired only after the capture", JSON.stringify(shotTypes));
}

console.log("\n== content script: capture flash shape ==");
{
  const src = await Bun.file(new URL("../packages/browser-extension/src/content-script.js", import.meta.url)).text();
  // Match identifiers, not prose: the comments legitimately explain that the glow
  // was removed.
  if (!/overlayEl|overlayCount|showAgentOverlay|hideAgentOverlay/.test(src))
    ok("content script carries no glow/overlay code");
  else bad("content script carries no glow/overlay code", "a glow/overlay identifier is back");
  if (/-agent-overlay|-overlay-style/.test(src))
    ok("the old overlay ids stay listed so stale elements are cleaned up");
  else bad("the old overlay ids stay listed so stale elements are cleaned up", "cleanup ids removed");
  if (/flashBusyUntil/.test(src)) ok("capture flash keeps its anti-strobe guard");
  else bad("capture flash keeps its anti-strobe guard", "flashBusyUntil missing");
  if (/prefers-reduced-motion/.test(src)) ok("capture flash honours prefers-reduced-motion");
  else bad("capture flash honours prefers-reduced-motion", "no reduced-motion check");
  if (/clear-capture-flash/.test(src) && /flash-capture/.test(src)) ok("both flash messages are handled");
  else bad("both flash messages are handled", "handler missing");
  if (/flash-capture/.test(src) && !/agent-overlay\(\)/.test(src)) ok("the overlay is no longer rendered");
  else bad("the overlay is no longer rendered", "showAgentOverlay is still callable");
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log("  - " + f);
}
process.exit(fail === 0 ? 0 : 1);
