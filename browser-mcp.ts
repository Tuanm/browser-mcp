#!/usr/bin/env bun
/**
 * browser-mcp.ts — Browser MCP server
 *
 * Exposes the connected Chrome extension's browser operations as MCP tools
 * (Streamable-HTTP JSON-RPC at POST /mcp, same protocol as code-mcp), and can
 * tunnel the MCP endpoint through a code-mcp-gateway so remote agents can
 * drive this browser.
 *
 * Endpoints:
 *   POST /mcp                  MCP JSON-RPC (initialize / tools/list / tools/call / ping)
 *   GET  /browser/ws           WebSocket bridge for the Chrome extension
 *   POST /browser/files/upload Extension uploads a downloaded file (multipart)
 *   GET  /browser/files/:id    Extension fetches a file for browser_upload_file
 *   POST /files/upload         Agent uploads a file (multipart) -> { file_id }
 *   GET  /files/:id            Agent downloads a stored file
 *   GET  /extension            Extension zip for easy install
 *   GET  /health               JSON status
 *   GET  /                     HTML status page
 *
 * Gateway protocol (mirrors code-mcp): connect wss://<domain>/ws[/<deviceId>],
 * send {type:'register',deviceId}, keepalive every 25s, watchdog 75s, and
 * forward inbound {id, request, token} to the local /mcp handler.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ============================================================================
// Args
// ============================================================================

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const port = Number(args.port ?? process.env.PORT ?? 7777);
const bindAddr: string = (args.bind as string) ?? "127.0.0.1";
/** Agent-facing auth token: gates /mcp and /files/* (constant-time compare). */
const token: string | undefined = (args.token as string) || undefined;
/**
 * Extension-facing auth token (optional): when set, the extension must present
 * it on /browser/ws and /browser/files/* (?token=). Defense in depth on top of
 * the mandatory chrome-extension:// Origin check.
 */
const extensionToken: string | undefined = (args["extension-token"] as string) || undefined;
/** Gateway domain (e.g. gateway.example.workers.dev). */
const gatewayDomain: string | undefined = (args.gateway as string) || undefined;
/** Device id for the gateway connection. */
const deviceId: string | undefined = (args.id as string) || undefined;
/** Directory containing the unpacked extension (for /extension zip). */
const extDir: string = (args["ext-dir"] as string) ?? resolve(import.meta.dir, "packages", "browser-extension");
/** Where agent/extension files are stored. */
const filesDir: string = (args["files-dir"] as string) ?? resolve(import.meta.dir, "files");
/** DEV ONLY: skip the chrome-extension:// Origin check on /browser/ws. Never use on a shared machine. */
const allowAnyOrigin = args["allow-any-origin"] === true;

const gatewayMode = !!gatewayDomain;

// ============================================================================
// File store
// ============================================================================

const MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MiB
const FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface StoredFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  sha256: string;
  createdAt: number;
  path: string;
}

const fileIndex = new Map<string, StoredFile>();

function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() || "upload.bin";
  let safe = base.replace(/[\x00-\x1f\x22\x5c]/g, "_"); // control chars, quotes, backslash
  if (!safe || safe === "." || safe === "..") safe = `upload-${Date.now()}`;
  return safe;
}

function saveFile(name: string, buf: Uint8Array, mimetype: string): StoredFile {
  mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  const id = randomBytes(6).toString("hex"); // 12 hex chars, unguessable
  const safeName = sanitizeFilename(name);
  const dot = safeName.lastIndexOf(".");
  const ext = dot > 0 ? safeName.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) : "";
  const storedName = ext ? `${id}.${ext}` : id;
  const path = join(filesDir, storedName);
  writeFileSync(path, buf, { mode: 0o600 });
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(buf);
  const meta: StoredFile = {
    id,
    name: safeName,
    mimetype: mimetype || "application/octet-stream",
    size: buf.length,
    sha256: hash.digest("hex"),
    createdAt: Date.now(),
    path,
  };
  fileIndex.set(id, meta);
  try { writeFileSync(`${path}.json`, JSON.stringify(meta), { mode: 0o600 }); } catch {}
  return meta;
}

function loadFileIndex(): void {
  if (!existsSync(filesDir)) return;
  for (const f of readdirSync(filesDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const meta = JSON.parse(readFileSync(join(filesDir, f), "utf8")) as StoredFile;
      if (meta?.id && meta?.path && existsSync(meta.path)) fileIndex.set(meta.id, meta);
    } catch {}
  }
}

function getFile(id: string): StoredFile | null {
  return fileIndex.get(id) ?? null;
}

// TTL cleanup (hourly, unref'd so it never blocks exit)
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - FILE_TTL_MS;
  for (const [id, f] of fileIndex) {
    if (f.createdAt < cutoff) {
      try { unlinkSync(f.path); } catch {}
      try { unlinkSync(`${f.path}.json`); } catch {}
      fileIndex.delete(id);
    }
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();

// ============================================================================
// Auth helpers
// ============================================================================

function checkTokenValue(given: string | null | undefined, expected: string | undefined): boolean {
  if (!expected) return true; // no auth configured
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

function checkMcpToken(req: Request, url: URL): boolean {
  if (!token) return true;
  const q = url.searchParams.get("token");
  if (q) return checkTokenValue(q, token);
  return checkTokenValue(extractBearer(req), token);
}

function checkExtensionToken(req: Request, url: URL): boolean {
  if (!extensionToken) return true;
  return checkTokenValue(url.searchParams.get("token"), extensionToken);
}

/**
 * Mandatory Origin check for the extension WebSocket: only Chrome/Firefox
 * extensions may connect. This blocks drive-by web pages from opening a rogue
 * WS to localhost and impersonating the extension.
 */
function checkExtensionOrigin(req: Request): { ok: boolean; reason?: string } {
  if (allowAnyOrigin) return { ok: true };
  const origin = req.headers.get("origin");
  if (!origin) return { ok: false, reason: "missing Origin header (extensions always send chrome-extension://)" };
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) return { ok: true };
  return { ok: false, reason: `origin not allowed: ${origin.slice(0, 64)}` };
}

const EXT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const FILE_ID_PATTERN = /^[a-f0-9]{12}$/;

/**
 * Origin gate for agent-facing endpoints (/mcp, /files/*).
 *
 * WHY: CORS "Access-Control-Allow-Origin: *" on a browser-control server is a
 * CSRF vector - any website the user visits could POST JSON-RPC to
 * http://localhost:<port>/mcp and drive the browser (navigate, execute JS,
 * read cookies). Native MCP clients send no Origin header, so they are
 * unaffected. Browser-based local tools (localhost origins) still work. Any
 * other browser origin is rejected outright - the request is never processed.
 */
function checkMcpOrigin(req: Request): { ok: boolean; reason?: string } {
  const origin = req.headers.get("origin");
  if (!origin) return { ok: true }; // native clients (no browser CORS enforcement)
  if (
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1") ||
    origin.startsWith("http://0.0.0.0") ||
    origin.startsWith("http://[::1]") ||
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://")
  ) {
    return { ok: true };
  }
  return { ok: false, reason: "origin not allowed: " + origin.slice(0, 64) };
}

/** CORS headers: echo the allowed origin (never "*" when a browser sent Origin). */
function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (origin) return { ...CORS_HEADERS, "Access-Control-Allow-Origin": origin };
  return CORS_HEADERS;
}

// ============================================================================
// Browser bridge (WebSocket server side)
// ============================================================================

interface BrowserWsData {
  type: "browser-extension";
  extensionId: string;
  connectedAt: number;
}

interface PendingRequest {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
  extensionId: string;
}

const connections = new Map<string, any>(); // extensionId -> ServerWebSocket
const pendingRequests = new Map<string, PendingRequest>();
const lastPong = new Map<string, number>();
let requestCounter = 0;

const DEFAULT_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUTS: Record<string, number> = {
  navigate: 60_000,
  execute: 60_000,
  wait_for: 60_000,
  download: 120_000,
  file_upload: 120_000,
};
/**
 * Hard cap on bridge command duration. In gateway mode the gateway aborts its
 * forward after 60s (code-mcp client uses AbortSignal.timeout(60_000)), so cap
 * at 55s there; locally we allow up to 120s. The extension's offscreen relay
 * timeout (125s) must stay above this cap so the server times out first.
 */
const MAX_BRIDGE_TIMEOUT = gatewayMode ? 55_000 : 120_000;
const MAX_CONNECTIONS = 10;

const HEARTBEAT_CHECK_INTERVAL_MS = 30_000;
const HEARTBEAT_DEAD_THRESHOLD_MS = 45_000;

const heartbeatInterval = setInterval(() => {
  const now = Date.now();
  for (const [extId, ws] of connections) {
    const lastSeen = lastPong.get(extId) ?? ws.data.connectedAt;
    if (now - lastSeen > HEARTBEAT_DEAD_THRESHOLD_MS) {
      console.warn(`[browser-mcp] extension ${extId} unresponsive, closing`);
      try { ws.close(1001, "heartbeat timeout"); } catch {}
      continue;
    }
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
  }
}, HEARTBEAT_CHECK_INTERVAL_MS);
heartbeatInterval.unref();

function handleBrowserWsOpen(ws: any): void {
  const extId = ws.data.extensionId;
  const existing = connections.get(extId);
  if (existing) {
    try { existing.close(1000, "replaced"); } catch {}
  } else if (connections.size >= MAX_CONNECTIONS) {
    try { ws.close(1013, "Too many browser extensions connected"); } catch {}
    return;
  }
  connections.set(extId, ws);
  lastPong.set(extId, Date.now());
  console.log(`[browser-mcp] Extension connected: ${extId} (${connections.size} total)`);
}

function handleBrowserWsClose(ws: any): void {
  const extId = ws.data.extensionId;
  if (connections.get(extId) !== ws) return; // replaced by newer connection
  connections.delete(extId);
  lastPong.delete(extId);
  for (const [id, p] of pendingRequests) {
    if (p.extensionId === extId) {
      clearTimeout(p.timer);
      pendingRequests.delete(id);
      p.reject(new Error(`Browser extension disconnected during '${p.method}'`));
    }
  }
  console.log(`[browser-mcp] Extension disconnected: ${extId} (${connections.size} total)`);
}

function handleBrowserWsMessage(ws: any, message: string | Buffer): void {
  let data: any;
  try { data = JSON.parse(message.toString()); } catch { return; }
  if (data.type === "ping") {
    try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
    lastPong.set(ws.data.extensionId, Date.now());
    return;
  }
  if (data.type === "pong") {
    lastPong.set(ws.data.extensionId, Date.now());
    return;
  }
  if (data.id && pendingRequests.has(data.id)) {
    const pending = pendingRequests.get(data.id)!;
    pendingRequests.delete(data.id);
    clearTimeout(pending.timer);
    if (data.error) {
      pending.reject(new Error(data.error.message || JSON.stringify(data.error)));
    } else {
      pending.resolve(data.result);
    }
  }
}

/** Pick the browser to drive: first connected extension (single-browser model). */
function pickBrowserWs(): any | null {
  return connections.values().next().value ?? null;
}

export function isExtensionConnected(): boolean {
  return connections.size > 0;
}

function sendBrowserCommand(
  method: string,
  params: Record<string, any> = {},
  opts?: { timeoutMs?: number },
): Promise<any> {
  const ws = pickBrowserWs();
  if (!ws) {
    throw new Error(
      "No browser extension connected. Install the Browser MCP extension, then click the toolbar icon and Connect.",
    );
  }
  const id = `req_${++requestCounter}_${randomBytes(4).toString("hex")}`;
  const extId = ws.data.extensionId;
  const timeoutMs = Math.min(opts?.timeoutMs || COMMAND_TIMEOUTS[method] || DEFAULT_TIMEOUT_MS, MAX_BRIDGE_TIMEOUT);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Browser command '${method}' timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, method, timer, extensionId: extId });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err: any) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(err instanceof Error ? err : new Error("Failed to send browser command"));
    }
  });
}

// ============================================================================
// MCP tools
// ============================================================================

const MAX_SCREENSHOT_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MiB decoded -> image content block
const MAX_TEXT_OUTPUT = 50_000; // truncate huge text results
const MAX_FILE_READ_TEXT = 512 * 1024; // browser_file_read text cap
const MAX_FILE_READ_IMAGE = 4 * 1024 * 1024; // browser_file_read image cap

interface ToolDef {
  description: string;
  parameters: Record<string, any>;
  required: string[];
  handler: (args: Record<string, any>) => Promise<any>;
}

/** Format a tool result into MCP content blocks. */
function textBlocks(text: string): any[] {
  return [{ type: "text", text }];
}

/** JSON-stringify a result, truncating long text. */
function jsonOut(v: any): string {
  if (typeof v === "string") return v.length > MAX_TEXT_OUTPUT ? v.slice(0, MAX_TEXT_OUTPUT) + "\n\n... (truncated)" : v;
  let s: string;
  try { s = JSON.stringify(v, null, 2); } catch { s = String(v); }
  return s.length > MAX_TEXT_OUTPUT ? s.slice(0, MAX_TEXT_OUTPUT) + "\n\n... (truncated)" : s;
}

/** bridge_timeout (seconds) -> ms override, capped by server limits. */
function bridgeTimeoutMs(args: Record<string, any>): number | undefined {
  const t = typeof args.bridge_timeout === "number" ? args.bridge_timeout * 1000 : undefined;
  return t;
}

function outError(e: unknown): { blocks: any[]; isError: true } {
  const msg = e instanceof Error ? e.message : String(e);
  return { blocks: textBlocks(`ERROR: ${msg}`), isError: true };
}

function outJson(v: any): { blocks: any[] } {
  return { blocks: textBlocks(jsonOut(v)) };
}

const tools: Record<string, ToolDef> = {
  browser_status: {
    description:
      "Check browser extension connection status. Returns whether the Browser MCP Chrome/Edge extension is connected and available for browser automation.",
    parameters: {},
    required: [],
    handler: async () => {
      const connected = isExtensionConnected();
      return outJson({
        connected,
        extensions: connections.size,
        message: connected
          ? "Browser extension connected (" + connections.size + " instance" + (connections.size > 1 ? "s" : "") + ")."
          : "No browser extension connected. Install and enable the Browser MCP extension, then click the toolbar icon and Connect.",
      });
    },
  },

  browser_navigate: {
    description:
      "Navigate a browser tab to a URL. If a tab with the target URL is already open (check via browser_tabs list first), reuse it by passing its tab_id instead of opening a new tab. Creates a new tab if no tab_id is specified. Close tabs you no longer need via browser_tabs action=close.",
    parameters: {
      url: { type: "string", description: "URL to navigate to" },
      tab_id: { type: "number", description: "Target tab ID (optional - creates new tab if omitted)" },
      wait_for: {
        type: "string",
        description: 'Wait condition: "load" (default) or "domcontentloaded"',
        enum: ["load", "domcontentloaded"],
      },
      bridge_timeout: {
        type: "number",
        description: "Override server-side timeout in seconds (default: 60, max: 120). Use for slow-loading pages.",
      },
    },
    required: ["url"],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("navigate", { url: args.url, tabId: args.tab_id, waitFor: args.wait_for || "load" }, { timeoutMs: bridgeTimeoutMs(args) });
        return outJson({ tab_id: result.tabId, url: result.url, title: result.title, ...(result.download_triggered && { download_triggered: result.download_triggered }) });
      } catch (e) { return outError(e); }
    },
  },

  browser_screenshot: {
    description:
      "Take a screenshot of the current browser tab. Returns a JPEG image content block (max 8 MiB). " +
      "PREFER browser_extract or browser_execute to read page content - they return structured data, are faster, and use less context. " +
      "Only use screenshots when you need visual layout information that cannot be obtained from DOM/text extraction (e.g., charts, images, visual styling, spatial layout). " +
      "On anti-bot protected sites, use stealth=true (viewport-only, no selector/fullPage).",
    parameters: {
      tab_id: { type: "number", description: "Tab to screenshot (optional - uses active tab)" },
      selector: { type: "string", description: "CSS selector to screenshot a specific element (optional)" },
      full_page: { type: "boolean", description: "Capture full scrollable page instead of viewport (default: false)" },
      stealth: {
        type: "boolean",
        description: "Use stealth mode. Only viewport screenshots are available (selector and full_page are ignored). Uses chrome.tabs.captureVisibleTab instead of CDP.",
      },
    },
    required: [],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("screenshot", { tabId: args.tab_id, selector: args.selector, fullPage: args.full_page, stealth: args.stealth });
        if (!result.dataUrl) return outError(new Error("No screenshot data returned"));
        const m = result.dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.*)$/);
        const mimeType = m ? m[1] : "image/jpeg";
        const base64 = m ? m[2] : result.dataUrl.replace(/^data:image\/\w+;base64,/, "");
        const bytes = Math.floor((base64.length * 3) / 4);
        if (bytes <= MAX_SCREENSHOT_IMAGE_BYTES) {
          return {
            blocks: [
              { type: "image", data: base64, mimeType },
              { type: "text", text: jsonOut({ tab_id: result.tabId, width: result.width, height: result.height, format: "jpeg", size: bytes }) },
            ],
          };
        }
        // Too large for an image block - store as a file and reference it.
        const buf = Buffer.from(base64, "base64");
        const file = saveFile(`screenshot-${Date.now()}.jpg`, buf, mimeType);
        return outJson({
          file_id: file.id,
          tab_id: result.tabId,
          width: result.width,
          height: result.height,
          size: file.size,
          message: `Screenshot too large for an inline image block (${(bytes / 1024 / 1024).toFixed(1)} MiB). Stored as file_id="${file.id}". Use browser_file_read or fetch /files/${file.id} locally.`,
        });
      } catch (e) { return outError(e); }
    },
  },

  browser_click: {
    description:
      'Click an element on the page. Supports single-click, double-click (click_count=2 to select words or open items), and right-click (button="right" for context menus). For dynamic pages, prefer selectors over coordinates. Set intercept_file_chooser=true when clicking upload/file buttons. ' +
      "WARNING: On anti-bot protected sites, use stealth=true to avoid CDP debugger detection that causes immediate logout/redirect.",
    parameters: {
      selector: { type: "string", description: "CSS selector of element to click" },
      x: { type: "number", description: "X coordinate (if no selector)" },
      y: { type: "number", description: "Y coordinate (if no selector)" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
      button: { type: "string", description: '"left" (default) for normal click, "right" for context menu, "middle" for new-tab link open', enum: ["left", "right", "middle"] },
      click_count: { type: "number", description: "1 = single-click (default), 2 = double-click (select word, open item), 3 = triple-click (select line/paragraph)" },
      pierce: { type: "boolean", description: "Pierce shadow DOM and iframes to find the element (default: false)" },
      intercept_file_chooser: {
        type: "boolean",
        description: "Set true when clicking a file upload button. Intercepts the file chooser dialog so you can provide a file via browser_upload_file. Do NOT set for download buttons.",
      },
      stealth: {
        type: "boolean",
        description: "Use stealth mode to avoid CDP debugger detection on anti-bot protected sites. Uses chrome.scripting injection instead of CDP Input events. el.click() is used (isTrusted=true). Cannot intercept file choosers in stealth mode.",
      },
    },
    required: [],
    handler: async (args) => {
      if (!args.selector && (args.x === undefined || args.y === undefined))
        return outError(new Error("Provide either a CSS selector or x,y coordinates"));
      try {
        const result = await sendBrowserCommand("click", {
          selector: args.selector, x: args.x, y: args.y, tabId: args.tab_id, button: args.button || "left",
          clickCount: args.click_count, pierce: args.pierce, intercept_file_chooser: args.intercept_file_chooser, stealth: args.stealth,
        });
        return outJson({ clicked: true, element: result.element || args.selector || `(${args.x}, ${args.y})`, tab_id: result.tabId, ...(result.download_triggered && { download_triggered: result.download_triggered }), ...(result.file_chooser_opened && { file_chooser_opened: result.file_chooser_opened }) });
      } catch (e) { return outError(e); }
    },
  },

  browser_type: {
    description:
      "Type text into a focused element or a specific element by selector. Can also send special keys like Enter, Tab, Escape. " +
      "On anti-bot protected sites, use stealth=true to avoid CDP debugger detection.",
    parameters: {
      text: { type: "string", description: "Text to type" },
      selector: { type: "string", description: "CSS selector of input element (optional - types into focused element)" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
      clear_first: { type: "boolean", description: "Clear the field before typing (default: false)" },
      press_enter: { type: "boolean", description: "Press Enter after typing (default: false)" },
      pierce: { type: "boolean", description: "Pierce shadow DOM and iframes to find the element (default: false)" },
      stealth: {
        type: "boolean",
        description: "Use stealth mode to avoid CDP debugger detection. Sets value via native setter + dispatches input/change events. Works with React/Vue controlled inputs.",
      },
    },
    required: ["text"],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("type", { text: args.text, selector: args.selector, tabId: args.tab_id, clearFirst: args.clear_first, pressEnter: args.press_enter, pierce: args.pierce, stealth: args.stealth });
        return outJson({ typed: true, text_length: String(args.text).length, element: result.element || args.selector || "(focused)", tab_id: result.tabId });
      } catch (e) { return outError(e); }
    },
  },

  browser_extract: {
    description:
      "Extract structured content from the current page. Can extract text, links, form data, tables, or the accessibility tree. " +
      "PREFERRED over browser_screenshot for reading page content - returns structured text data that is faster, cheaper, and more accurate than OCR from screenshots.",
    parameters: {
      mode: {
        type: "string",
        description: '"text" (visible text), "links" (all links), "forms" (form fields), "tables" (table data), "accessibility" (accessibility tree), "html" (raw HTML of selector)',
        enum: ["text", "links", "forms", "tables", "accessibility", "html"],
      },
      selector: { type: "string", description: "CSS selector to scope extraction (optional - uses whole page)" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
      frame_id: { type: "string", description: "Frame ID to extract from (use browser_frames to list frames)" },
      bridge_timeout: { type: "number", description: "Override server-side timeout in seconds (default: 30, max: 120). Use for heavy pages." },
    },
    required: ["mode"],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("extract", { mode: args.mode, selector: args.selector, tabId: args.tab_id, frameId: args.frame_id }, { timeoutMs: bridgeTimeoutMs(args) });
        return { blocks: textBlocks(jsonOut(result.data)) };
      } catch (e) { return outError(e); }
    },
  },

  browser_tabs: {
    description:
      "List, close, or activate browser tabs. IMPORTANT: Before opening new tabs, check if a suitable tab is already open. Close tabs you no longer need to keep the browser tidy and reduce resource usage.",
    parameters: {
      action: { type: "string", description: '"list" (default) - shows all tabs; "close" - close a tab; "activate" - bring a tab to foreground', enum: ["list", "close", "activate"] },
      tab_id: { type: "number", description: "Tab ID for close/activate actions" },
    },
    required: [],
    handler: async (args) => {
      const action = args.action || "list";
      if ((action === "close" || action === "activate") && args.tab_id === undefined)
        return outError(new Error(`tab_id is required for "${action}" action`));
      try {
        const result = await sendBrowserCommand("tabs", { action, tabId: args.tab_id });
        return outJson(result);
      } catch (e) { return outError(e); }
    },
  },

  browser_execute: {
    description:
      "Execute JavaScript in the browser tab. Supports running inline code OR a stored script by ID (saved via browser_store). " +
      "When reusing a stored script, pass script_id (and optional script_args) instead of code - this avoids re-sending large scripts and enables reuse across sessions. " +
      "If both code and script_id are provided, script_id takes priority. " +
      "TIP: If you find yourself running similar code more than once, save it as a reusable script via browser_store (with a description) and call it by script_id going forward. " +
      "WARNING: On anti-bot protected sites, use stealth=true to avoid CDP debugger detection that causes immediate logout/redirect.",
    parameters: {
      code: { type: "string", description: "JavaScript code to execute in the page context (omit if using script_id)" },
      script_id: {
        type: "string",
        description: "Key of a stored script (saved via browser_store with action=set). The script is loaded and wrapped in an async function - use 'return <expr>' to return values (unlike inline code, the last expression is NOT implicitly returned). Prefer this over re-sending code.",
      },
      script_args: { type: "object", description: "Arguments object passed to the stored script as __args. Access via __args.key inside the script. Only used with script_id." },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
      frame_id: { type: "string", description: "Frame ID for frame-targeted execution (use browser_frames to list frames)" },
      stealth: {
        type: "boolean",
        description: "Use stealth mode to avoid CDP debugger detection. Runs code via chrome.scripting in MAIN world instead of CDP Runtime.evaluate. Frame targeting not supported in stealth mode.",
      },
      bridge_timeout: { type: "number", description: "Override server-side timeout in seconds (default: 60, max: 120). Use for long-running scripts." },
    },
    required: [],
    handler: async (args) => {
      try {
        let code = args.code;
        if (args.script_id) {
          const storeResult = await sendBrowserCommand("store", { action: "get", key: args.script_id, tabId: args.tab_id });
          const storedScript = storeResult?.value;
          if (!storeResult?.found) return outError(new Error(`Stored script '${String(args.script_id).slice(0, 100)}' not found. Use browser_store action=set to save it first, or browser_store action=list to see available scripts.`));
          if (typeof storedScript !== "string" || storedScript.length === 0) return outError(new Error(`Stored item '${String(args.script_id).slice(0, 100)}' is not a valid script (type: ${typeof storedScript}). Store a non-empty JS code string.`));
          let argsJson: string;
          try { argsJson = JSON.stringify(args.script_args ?? {}); } catch { return outError(new Error("script_args is not JSON-serializable (check for BigInt, circular references, or other non-serializable values)")); }
          code = `(async function(){const __args=${argsJson};${storedScript}})()`;
        }
        if (!code) return outError(new Error("Either 'code' or 'script_id' is required."));
        if (!args.script_id) code = `(async()=>{${code}})()`;
        const result = await sendBrowserCommand("execute", { code, tabId: args.tab_id, frameId: args.frame_id, stealth: args.stealth }, { timeoutMs: bridgeTimeoutMs(args) });
        let output = result.value !== undefined ? (typeof result.value === "string" ? result.value : jsonOut(result.value)) : "(undefined)";
        return { blocks: textBlocks(output) };
      } catch (e) { return outError(e); }
    },
  },

  browser_scroll: {
    description:
      "Scroll the page or a specific scrollable area (sidebar, panel, chat list, etc.). When selector is given, the scroll event targets that element - the browser automatically scrolls the nearest scrollable ancestor. Use this to scroll within nested containers, not just the main page.",
    parameters: {
      direction: { type: "string", description: "Scroll direction", enum: ["up", "down", "left", "right"] },
      amount: { type: "number", description: "Scroll distance in pixels (default: 300)" },
      selector: { type: "string", description: "CSS selector - scroll event fires at this element's center, scrolling its nearest scrollable container (sidebar, panel, etc.)" },
      x: { type: "number", description: "X coordinate to scroll at (alternative to selector)" },
      y: { type: "number", description: "Y coordinate to scroll at (alternative to selector)" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
      stealth: { type: "boolean", description: "Use stealth mode. Uses window.scrollBy() via chrome.scripting instead of CDP mouseWheel events." },
    },
    required: [],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("scroll", { direction: args.direction || "down", amount: args.amount, selector: args.selector, x: args.x, y: args.y, tabId: args.tab_id, stealth: args.stealth });
        return outJson({ scrolled: true, direction: result.direction, amount: result.amount, tab_id: result.tabId });
      } catch (e) { return outError(e); }
    },
  },

  browser_hover: {
    description:
      "Hover over an element to reveal hidden UI: tooltips, dropdown menus, action buttons, preview popups, and hover-only content. Essential for inspecting elements that only appear on mouse-over. After hovering, take a screenshot or extract to see the revealed content.",
    parameters: {
      selector: { type: "string", description: "CSS selector of element to hover over" },
      x: { type: "number", description: "X coordinate (if no selector)" },
      y: { type: "number", description: "Y coordinate (if no selector)" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
      pierce: { type: "boolean", description: "Pierce shadow DOM and iframes to find the element (default: false)" },
      stealth: { type: "boolean", description: "Use stealth mode. Dispatches mouseenter/mouseover/mousemove events via chrome.scripting. CSS :hover may not activate (JS listeners will fire)." },
    },
    required: [],
    handler: async (args) => {
      if (!args.selector && (args.x === undefined || args.y === undefined))
        return outError(new Error("Provide either a CSS selector or x,y coordinates"));
      try {
        const result = await sendBrowserCommand("hover", { selector: args.selector, x: args.x, y: args.y, tabId: args.tab_id, pierce: args.pierce, stealth: args.stealth });
        return outJson({ hovered: true, element: result.element, tab_id: result.tabId });
      } catch (e) { return outError(e); }
    },
  },

  browser_mouse_move: {
    description:
      "Move the mouse cursor to specific coordinates. Use sparingly - most interactions should use browser_click or browser_hover instead. Useful when you need to position the cursor at a precise location (e.g., to dismiss a popup, move away from an element, or prepare for a manual sequence).",
    parameters: {
      x: { type: "number", description: "Target X coordinate" },
      y: { type: "number", description: "Target Y coordinate" },
      steps: { type: "number", description: "Number of intermediate movement steps (default: 1). Use higher values for smoother travel." },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
    },
    required: ["x", "y"],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("mouse_move", { x: args.x, y: args.y, steps: args.steps, tabId: args.tab_id });
        return outJson({ moved: true, position: result.position, tab_id: result.tabId });
      } catch (e) { return outError(e); }
    },
  },

  browser_drag: {
    description:
      "Drag and drop from one position to another. Use selectors or coordinates for source and target. Works for sliders, sortable lists, and drag-and-drop UIs.",
    parameters: {
      from_selector: { type: "string", description: "CSS selector of element to drag from" },
      from_x: { type: "number", description: "Start X coordinate (if no from_selector)" },
      from_y: { type: "number", description: "Start Y coordinate (if no from_selector)" },
      to_selector: { type: "string", description: "CSS selector of element to drop onto" },
      to_x: { type: "number", description: "End X coordinate (if no to_selector)" },
      to_y: { type: "number", description: "End Y coordinate (if no to_selector)" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
      steps: { type: "number", description: "Number of intermediate move steps (default: 10). More steps = smoother drag." },
    },
    required: [],
    handler: async (args) => {
      if (!args.from_selector && (args.from_x === undefined || args.from_y === undefined))
        return outError(new Error("Provide from_selector or from_x/from_y coordinates"));
      if (!args.to_selector && (args.to_x === undefined || args.to_y === undefined))
        return outError(new Error("Provide to_selector or to_x/to_y coordinates"));
      try {
        const result = await sendBrowserCommand("drag", { fromSelector: args.from_selector, fromX: args.from_x, fromY: args.from_y, toSelector: args.to_selector, toX: args.to_x, toY: args.to_y, tabId: args.tab_id, steps: args.steps });
        return outJson({ dragged: true, from: result.from, to: result.to, tab_id: result.tabId });
      } catch (e) { return outError(e); }
    },
  },

  browser_keypress: {
    description:
      "Send keyboard key presses with optional modifiers. Use for shortcuts, navigation keys, and special keys like Enter, Tab, Escape, Arrow keys, F1-F12, etc.",
    parameters: {
      key: {
        type: "string",
        description: 'Key to press: "Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Home", "End", "PageUp", "PageDown", "F1"-"F12", or any character',
      },
      modifiers: { type: "array", items: { type: "string" }, description: 'Modifier keys to hold: "ctrl", "shift", "alt", "meta", or combinations like ["ctrl", "shift"]' },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
      stealth: { type: "boolean", description: "Use stealth mode. Dispatches KeyboardEvent via chrome.scripting instead of CDP Input.dispatchKeyEvent." },
    },
    required: ["key"],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("keypress", { key: args.key, modifiers: args.modifiers, tabId: args.tab_id, stealth: args.stealth });
        return outJson({ pressed: true, key: result.key, modifiers: result.modifiers, tab_id: result.tabId });
      } catch (e) { return outError(e); }
    },
  },

  browser_wait_for: {
    description:
      "Wait for an element to appear on the page. Polls until the element matching the selector exists and is visible. Use before interacting with dynamically loaded content.",
    parameters: {
      selector: { type: "string", description: "CSS selector to wait for" },
      timeout: { type: "number", description: "Maximum wait time in milliseconds (default: 5000, max: 30000)" },
      visible: { type: "boolean", description: "Require element to be visible, not just in DOM (default: true)" },
      pierce: { type: "boolean", description: "Pierce shadow DOM and iframes to find the element (default: false)" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
      bridge_timeout: { type: "number", description: "Override server-side timeout in seconds (default: 60, max: 120). Should be >= timeout/1000." },
    },
    required: ["selector"],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("wait_for", { selector: args.selector, tabId: args.tab_id, timeout: args.timeout, visible: args.visible, pierce: args.pierce }, { timeoutMs: bridgeTimeoutMs(args) });
        return outJson({ found: true, element: result.element, elapsed_ms: result.elapsed, tab_id: result.tabId });
      } catch (e) { return outError(e); }
    },
  },

  browser_select: {
    description:
      'Select an option from a <select> dropdown element. Can select by value, visible text, or index. Dispatches "input" and "change" events.',
    parameters: {
      selector: { type: "string", description: "CSS selector of the <select> element" },
      value: { type: "string", description: "Option value attribute to select" },
      text: { type: "string", description: "Visible text of the option to select" },
      index: { type: "number", description: "Zero-based index of the option to select" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
    },
    required: ["selector"],
    handler: async (args) => {
      if (args.value === undefined && args.text === undefined && args.index === undefined)
        return outError(new Error("Provide value, text, or index to select"));
      try {
        const result = await sendBrowserCommand("select", { selector: args.selector, value: args.value, text: args.text, index: args.index, tabId: args.tab_id });
        return outJson({ selected: true, value: result.selected, text: result.text, index: result.index, tab_id: result.tabId });
      } catch (e) { return outError(e); }
    },
  },

  browser_handle_dialog: {
    description:
      'Handle a JavaScript dialog (alert, confirm, or prompt). Must be called after a dialog appears. Use action "accept" to click OK or "dismiss" to click Cancel.',
    parameters: {
      action: { type: "string", description: '"accept" (click OK, default) or "dismiss" (click Cancel)', enum: ["accept", "dismiss"] },
      prompt_text: { type: "string", description: "Text to enter in a prompt() dialog (optional)" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
    },
    required: [],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("dialog", { action: args.action || "accept", promptText: args.prompt_text, tabId: args.tab_id });
        return outJson({ handled: result.handled, type: result.type, dialog_message: result.dialogMessage, tab_id: result.tabId });
      } catch (e) { return outError(e); }
    },
  },

  browser_history: {
    description: "Navigate back or forward in browser history. Equivalent to clicking the browser's back/forward buttons.",
    parameters: {
      action: { type: "string", description: '"back" or "forward"', enum: ["back", "forward"] },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
    },
    required: ["action"],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("history", { action: args.action, tabId: args.tab_id });
        return outJson({ navigated: true, action: result.action, url: result.url, title: result.title, tab_id: result.tabId });
      } catch (e) { return outError(e); }
    },
  },

  browser_upload_file: {
    description:
      "Upload a file to a web page. Two modes: (1) After clicking an upload button that opens a file chooser dialog (file_chooser_opened in response), just provide file_id - no selector needed. " +
      '(2) Direct mode: provide both file_id and a CSS selector for the <input type="file"> element. ' +
      "The file must first exist on the Browser MCP server: upload it locally via POST /files/upload (multipart, returns file_id), OR pass content (base64) + filename inline so the server stores it for you (works when you are remote via the gateway).",
    parameters: {
      selector: {
        type: "string",
        description: 'CSS selector of the <input type="file"> element. Optional if a file chooser dialog is pending from a previous click.',
      },
      file_id: { type: "string", description: "File ID from a previous upload (POST /files/upload) or from browser_file_read/browser_download" },
      content: { type: "string", description: "Base64-encoded file content (alternative to file_id for remote agents). Max ~20 MiB decoded." },
      filename: { type: "string", description: "Filename used when content is provided (e.g. 'report.pdf')" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
    },
    required: [],
    handler: async (args) => {
      try {
        let fileId = args.file_id;
        if (!fileId && args.content) {
          const buf = Buffer.from(String(args.content), "base64");
          if (buf.length > 20 * 1024 * 1024) return outError(new Error(`Inline content too large (${(buf.length / 1024 / 1024).toFixed(1)} MiB). Max 20 MiB - upload via POST /files/upload instead.`));
          const f = saveFile(String(args.filename || "upload.bin"), buf, "application/octet-stream");
          fileId = f.id;
        }
        if (!fileId) return outError(new Error("file_id is required (or provide content+filename)"));
        const result = await sendBrowserCommand("file_upload", { selector: args.selector, fileId, tabId: args.tab_id });
        return outJson({ uploaded: true, selector: result.selector || args.selector || "(file chooser)", file_id: fileId, filename: result.fileName, tab_id: result.tabId });
      } catch (e) { return outError(e); }
    },
  },

  browser_frames: {
    description:
      "List all frames (iframes) in the current page. Returns frame IDs, URLs, names, and hierarchy. Use frame IDs with browser_execute and browser_extract for frame-targeted commands.",
    parameters: {
      tab_id: { type: "number", description: "Target tab ID (optional)" },
    },
    required: [],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("frames", { tabId: args.tab_id });
        return outJson(result);
      } catch (e) { return outError(e); }
    },
  },

  browser_touch: {
    description: "Dispatch touch events for mobile interaction testing. Supports tap, swipe, long-press, and pinch gestures.",
    parameters: {
      action: { type: "string", description: '"tap", "swipe", "long-press", or "pinch"', enum: ["tap", "swipe", "long-press", "pinch"] },
      selector: { type: "string", description: "CSS selector of target element (alternative to x,y)" },
      x: { type: "number", description: "Start X coordinate" },
      y: { type: "number", description: "Start Y coordinate" },
      end_x: { type: "number", description: "End X coordinate for swipe gesture" },
      end_y: { type: "number", description: "End Y coordinate for swipe" },
      scale: { type: "number", description: "Scale factor for pinch gesture (e.g., 0.5 = zoom out, 2.0 = zoom in)" },
      duration: { type: "number", description: "Hold duration in ms for long-press (default: 500)" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
    },
    required: ["action"],
    handler: async (args) => {
      if (!args.selector && (args.x === undefined || args.y === undefined))
        return outError(new Error("Provide either selector or x,y coordinates"));
      try {
        const result = await sendBrowserCommand("touch", { action: args.action, selector: args.selector, x: args.x, y: args.y, endX: args.end_x, endY: args.end_y, scale: args.scale, duration: args.duration, tabId: args.tab_id });
        return outJson(result);
      } catch (e) { return outError(e); }
    },
  },

  browser_emulate: {
    description:
      'Emulate a mobile device or custom viewport. Set screen dimensions, device scale factor, touch capability, and user agent. Use action "clear" to reset.',
    parameters: {
      action: { type: "string", description: '"set" (default) to apply emulation, or "clear" to reset to defaults', enum: ["set", "clear"] },
      width: { type: "number", description: "Viewport width in pixels" },
      height: { type: "number", description: "Viewport height in pixels" },
      device_scale_factor: { type: "number", description: "Device pixel ratio (default: 1, use 2 for retina, 3 for high-DPI mobile)" },
      is_mobile: { type: "boolean", description: "Enable mobile mode (affects rendering, default: false)" },
      has_touch: { type: "boolean", description: "Enable touch event support (default: false)" },
      user_agent: { type: "string", description: "Custom user agent string (optional)" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
    },
    required: [],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("emulate", { action: args.action || "set", width: args.width, height: args.height, deviceScaleFactor: args.device_scale_factor, isMobile: args.is_mobile, hasTouch: args.has_touch, userAgent: args.user_agent, tabId: args.tab_id });
        return outJson(result);
      } catch (e) { return outError(e); }
    },
  },

  browser_download: {
    description:
      'Track and capture file downloads. Use "list" to see recent downloads, "wait" to wait for a download to complete, or "latest" to get the most recent completed download. Completed downloads are automatically uploaded to the Browser MCP server and returned as file_id (max 500 MiB). Use browser_file_read or fetch /files/<file_id> to read the content.',
    parameters: {
      action: { type: "string", description: '"list" (recent downloads), "wait" (wait for next download), or "latest" (most recent completed)', enum: ["list", "wait", "latest"] },
      timeout: { type: "number", description: "Max wait time in ms for 'wait' action (default: 30000, max: 120000)" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
    },
    required: ["action"],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("download", { action: args.action, timeout: args.timeout });
        return outJson(result);
      } catch (e) { return outError(e); }
    },
  },

  browser_auth: {
    description:
      'Handle HTTP Basic/Digest authentication popups (e.g., staging servers, enterprise proxies). Use "status" to check if a page requires auth, "provide" to supply credentials, or "cancel" to dismiss.',
    parameters: {
      action: { type: "string", description: '"status" (check for pending auth), "provide" (supply credentials), or "cancel"', enum: ["status", "provide", "cancel"] },
      username: { type: "string", description: "Username for authentication (required for 'provide')" },
      password: { type: "string", description: "Password for authentication (required for 'provide')" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
    },
    required: ["action"],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("auth", { action: args.action, username: args.username, password: args.password, tabId: args.tab_id });
        return outJson(result);
      } catch (e) { return outError(e); }
    },
  },

  browser_permissions: {
    description:
      'Grant, deny, or reset browser permissions for a site. Controls access to camera, microphone, geolocation, notifications, clipboard, MIDI, and other web APIs. Grant permissions before interacting with features that need them (e.g., grant "geolocation" before testing a map app).',
    parameters: {
      action: { type: "string", description: '"grant", "deny", or "reset" (back to prompt)', enum: ["grant", "deny", "reset"] },
      permissions: {
        type: "array",
        items: { type: "string" },
        description: 'Permission names: "geolocation", "camera", "microphone", "notifications", "clipboard-read", "clipboard-write", "midi", "background-sync", "sensors", "screen-wake-lock"',
      },
      origin: { type: "string", description: "Origin to set permission for (default: current page origin)" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
    },
    required: ["action", "permissions"],
    handler: async (args) => {
      if (!args.permissions?.length) return outError(new Error("permissions array is required"));
      try {
        const result = await sendBrowserCommand("permissions", { action: args.action, permissions: args.permissions, origin: args.origin, tabId: args.tab_id });
        return outJson(result);
      } catch (e) { return outError(e); }
    },
  },

  browser_store: {
    description:
      "Store and retrieve data/scripts per-website using the browser's extension storage. " +
      "IMPORTANT: For any script you plan to run more than once, save it here first (action=set with a description), then run it via browser_execute with script_id instead of resending the code. " +
      "Use action=list to see all stored items with their descriptions. " +
      "Data is scoped to the page origin and stored securely in extension storage (invisible to page JavaScript). " +
      "Use descriptive keys like 'scroll-to-bottom', 'extract-table', 'login-form' so scripts are easy to find and reuse.",
    parameters: {
      action: {
        type: "string",
        description: '"set", "get", "list" (all keys with descriptions), "delete" (one key), or "clear" (all data for this origin)',
        enum: ["set", "get", "list", "delete", "clear"],
      },
      key: { type: "string", description: "Storage key (required for set/get/delete)" },
      value: { type: "string", description: "Value to store (required for set; for scripts this is the JS code)" },
      description: { type: "string", description: "Human-readable description of the stored item (optional, recommended for scripts)" },
      tab_id: { type: "number", description: "Target tab ID (optional)" },
    },
    required: ["action"],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("store", { action: args.action, key: args.key, value: args.value, description: args.description, tabId: args.tab_id });
        return outJson(result);
      } catch (e) { return outError(e); }
    },
  },

  browser_cookies: {
    description:
      "Read, set, or remove cookies for the current site (HttpOnly-safe via the chrome.cookies API - no CDP, no page-visible JavaScript). " +
      "Use browser_cookies action=getAll to inspect what the browser has for the current origin before deciding what to change.",
    parameters: {
      action: {
        type: "string",
        description: '"getAll" (list cookies for url/domain), "get" (one cookie by name), "set", or "remove"',
        enum: ["getAll", "get", "set", "remove"],
      },
      url: { type: "string", description: "URL scope for cookie operations (optional - inferred from active tab)" },
      domain: { type: "string", description: "Domain filter for getAll (optional)" },
      name: { type: "string", description: "Cookie name (required for get/set/remove)" },
      value: { type: "string", description: "Cookie value (for set)" },
      path: { type: "string", description: "Cookie path (for set, default '/')" },
      secure: { type: "boolean", description: "Secure flag (for set)" },
      http_only: { type: "boolean", description: "HttpOnly flag (for set)" },
      same_site: { type: "string", description: "SameSite value: 'Strict', 'Lax', or 'None' (for set)" },
      expiration_date: { type: "number", description: "Unix timestamp for expiration. Omit for session cookie." },
      tab_id: { type: "number", description: "Target tab ID (optional, used to infer URL if not provided)" },
    },
    required: ["action"],
    handler: async (args) => {
      try {
        const result = await sendBrowserCommand("cookies", {
          action: args.action, url: args.url, domain: args.domain, name: args.name, value: args.value, path: args.path,
          secure: args.secure, httpOnly: args.http_only, sameSite: args.same_site, expirationDate: args.expiration_date, tabId: args.tab_id,
        });
        return outJson(result);
      } catch (e) { return outError(e); }
    },
  },

  browser_file_read: {
    description:
      "Read a file previously stored on the Browser MCP server (from browser_download, a screenshot that was too large, or POST /files/upload). " +
      "Returns small text files inline as text and images up to 4 MiB as an image block. Larger files return base64 text up to 2 MiB; anything bigger must be fetched locally via GET http://localhost:<port>/files/<file_id>.",
    parameters: {
      file_id: { type: "string", description: "File ID (12 hex chars)" },
    },
    required: ["file_id"],
    handler: async (args) => {
      const f = getFile(String(args.file_id ?? ""));
      if (!f) return outError(new Error("File not found: " + args.file_id));
      const buf = await Bun.file(f.path).arrayBuffer();
      const bytes = new Uint8Array(buf);
      const isText = /^(text\/|application\/(json|xml|javascript|typescript|x-javascript|x-www-form-urlencoded)|image\/svg\+xml)/.test(f.mimetype);
      if (f.mimetype.startsWith("image/") && bytes.length <= MAX_FILE_READ_IMAGE) {
        return { blocks: [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: f.mimetype }] };
      }
      if (bytes.length <= 50_000) {
        const body = isText ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString("base64");
        return { blocks: textBlocks(jsonOut({ file_id: f.id, name: f.name, mimetype: f.mimetype, size: f.size, body })) };
      }
      if (bytes.length <= MAX_FILE_READ_TEXT) {
        const body = isText ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString("base64");
        return { blocks: textBlocks("file_id: " + f.id + "\nname: " + f.name + "\nmimetype: " + f.mimetype + "\nsize: " + f.size + "\nbody:\n" + body) };
      }
      return outJson({
        file_id: f.id,
        name: f.name,
        mimetype: f.mimetype,
        size: f.size,
        sha256: f.sha256,
        message: "File is " + (f.size / 1024 / 1024).toFixed(1) + " MiB - too large to return inline. Fetch it locally via GET http://localhost:" + port + "/files/" + f.id + ".",
      });
    },
  },
};

// ============================================================================
// JSON-RPC dispatch (MCP Streamable-HTTP style, same as code-mcp)
// ============================================================================

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

async function handle(msg: Json): Promise<Json | null> {
  const { id, method, params } = (msg ?? {}) as any;
  const ok = (result: Json) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params))) {
    return err(-32602, "Invalid params: expected object");
  }
  try {
    if (method === "initialize") {
      return ok({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "browser-mcp", version: "0.1.0" },
      });
    }
    if (method === "notifications/initialized") return null;
    if (method === "ping") return ok({});
    if (method === "tools/list") {
      return ok({
        tools: Object.entries(tools).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: { type: "object", properties: t.parameters, required: t.required },
        })),
      });
    }
    if (method === "tools/call") {
      const { name, arguments: args } = params ?? {};
      const t = tools[name];
      if (!t) return err(-32601, "unknown tool: " + name);
      const result = await t.handler(args ?? {});
      if (result && typeof result === "object" && "blocks" in result) {
        return ok({ content: result.blocks, ...(result.isError ? { isError: true } : {}) });
      }
      const text = typeof result === "string" ? result : jsonOut(result);
      return ok({ content: [{ type: "text", text }] });
    }
    return err(-32601, "unknown method: " + method);
  } catch (e: any) {
    if (id == null) return null;
    const text = "ERROR: " + (e?.message ?? e);
    return ok({ content: [{ type: "text", text }], isError: true });
  }
}

// ============================================================================
// HTTP server
// ============================================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function contentDisposition(type: "attachment" | "inline", filename: string): string {
  const safe = filename.replace(/[\r\n"]/g, "_").replace(/[^\x20-\x7E]/g, "_");
  return type + "; filename=\"" + safe + "\"";
}

async function handleFileUpload(req: Request): Promise<Response> {
  const declaredLen = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_FILE_BYTES) {
    return Response.json({ ok: false, error: "upload exceeds " + MAX_FILE_BYTES + " bytes" }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e: any) {
    return Response.json({ ok: false, error: "bad form: " + (e?.message ?? e) }, { status: 400 });
  }
  const f = form.get("file");
  if (!(f instanceof File)) return Response.json({ ok: false, error: "missing 'file' field" }, { status: 400 });
  if (f.size > MAX_FILE_BYTES) {
    return Response.json({ ok: false, error: "file too large (max " + MAX_FILE_BYTES + " bytes)" }, { status: 413 });
  }
  const buf = new Uint8Array(await f.arrayBuffer());
  const stored = saveFile(f.name || "upload.bin", buf, f.type || "application/octet-stream");
  return Response.json({
    ok: true,
    file: { id: stored.id, name: stored.name, mimetype: stored.mimetype, size: stored.size, sha256: stored.sha256 },
  });
}

function handleFileDownload(id: string, inline: boolean): Response | null {
  if (!FILE_ID_PATTERN.test(id)) return Response.json({ ok: false, error: "invalid file id" }, { status: 400 });
  const f = getFile(id);
  if (!f || !existsSync(f.path)) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  const blob = Bun.file(f.path);
  return new Response(blob, {
    headers: {
      "Content-Type": f.mimetype,
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", f.name),
      "Content-Length": String(f.size),
      "Referrer-Policy": "no-referrer",
    },
  });
}

function renderStatusPage(): string {
  const connected = isExtensionConnected();
  const exts = Array.from(connections.keys());
  const gw = gatewayStatus;
  const extClass = connected ? "ok" : "bad";
  const extLabel = connected ? "connected" : "disconnected";
  let gwHtml: string;
  if (gatewayMode) {
    const gwClass = gw.connected ? "ok" : "bad";
    const gwLabel = gw.connected ? "connected" : "connecting/reconnecting";
    gwHtml = "<div>Gateway: <span class=\"" + gwClass + "\">" + gwLabel + "</span>" + (gw.deviceId ? " (device " + gw.deviceId + ")" : "") + "</div>";
  } else {
    gwHtml = "<div>Gateway: <span class=\"bad\">not configured</span> (start with --gateway &lt;domain&gt;)</div>";
  }
  const lines = [
    "<!DOCTYPE html>",
    "<html><head><meta charset=\"utf-8\"><title>Browser MCP</title>",
    "<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#111}",
    "h1{font-size:20px}.card{border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:12px 0}",
    ".ok{color:#16a34a;font-weight:600}.bad{color:#9ca3af;font-weight:600}",
    "code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:13px}</style></head><body>",
    "<h1>Browser MCP</h1>",
    "<div class=\"card\">",
    "<div>Extension: <span class=\"" + extClass + "\">" + extLabel + "</span></div>",
    "<div>Extensions: " + (exts.length > 0 ? exts.join(", ") : "none") + "</div>",
    "<div>MCP tools: " + String(Object.keys(tools).length) + "</div>",
    gwHtml,
    "</div>",
    "<div class=\"card\">",
    "<div><b>MCP endpoint:</b> <code>POST http://localhost:" + String(port) + "/mcp</code></div>",
    "<div><b>Extension zip:</b> <code>GET /extension</code></div>",
    "<div><b>Health:</b> <code>GET /health</code></div>",
    "</div>",
    "</body></html>",
  ];
  return lines.join("\n");
}

// Gateway status shared with the status page
const gatewayStatus: { connected: boolean; deviceId: string | null } = { connected: false, deviceId: null };

const server = Bun.serve({
  port,
  hostname: bindAddr,
  maxRequestBodySize: 512 * 1024 * 1024, // 512 MiB (file uploads up to 500 MiB)
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS preflight for agent-facing endpoints only (browser-based MCP clients).
    // Origin-gated: browser clients from non-local origins get 403 (CSRF defense).
    if (req.method === "OPTIONS" && (path === "/mcp" || path.startsWith("/files/"))) {
      const oc = checkMcpOrigin(req);
      if (!oc.ok) return new Response("Rejected: " + oc.reason, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeadersFor(req) });
    }

    // Status page + health (no auth - localhost only by default)
    if (req.method === "GET" && path === "/") return new Response(renderStatusPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (req.method === "GET" && path === "/health") {
      return Response.json({
        ok: true,
        extensionConnected: isExtensionConnected(),
        extensions: Array.from(connections.keys()),
        tools: Object.keys(tools).length,
        gateway: gatewayMode ? { configured: true, connected: gatewayStatus.connected, deviceId: gatewayStatus.deviceId } : { configured: false },
      });
    }

    // Extension zip for easy install
    if (req.method === "GET" && path === "/extension") {
      const zipPath = join(import.meta.dir, "dist", "browser-extension.zip");
      if (!existsSync(zipPath)) {
        return new Response("Extension zip not found. Run: bun build-extension.ts", { status: 404 });
      }
      return new Response(Bun.file(zipPath), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": "attachment; filename=\"browser-mcp-extension.zip\"",
          "Content-Length": String(statSync(zipPath).size),
        },
      });
    }

    // Extension file endpoints (uploaded downloads, files for upload)
    if (path === "/browser/files/upload" && req.method === "POST") {
      if (!checkExtensionToken(req, url)) return new Response("unauthorized", { status: 401 });
      const resp = await handleFileUpload(req);
      return new Response(resp.body, { status: resp.status, headers: { "Content-Type": "application/json" } });
    }
    const extFileMatch = path.match(/^\/browser\/files\/([A-Za-z0-9]+)$/);
    if (extFileMatch && req.method === "GET") {
      if (!checkExtensionToken(req, url)) return new Response("unauthorized", { status: 401 });
      const resp = handleFileDownload(extFileMatch[1], false);
      return resp ?? new Response("not found", { status: 404 });
    }

    // Agent file endpoints (origin-gated like /mcp - CSRF defense for browser clients)
    if (path === "/files/upload" && req.method === "POST") {
      const oc = checkMcpOrigin(req);
      if (!oc.ok) return new Response("Rejected: " + oc.reason, { status: 403 });
      if (!checkMcpToken(req, url)) return new Response("unauthorized", { status: 401, headers: corsHeadersFor(req) });
      const resp = await handleFileUpload(req);
      return new Response(resp.body, { status: resp.status, headers: { "Content-Type": "application/json", ...corsHeadersFor(req) } });
    }
    const agentFileMatch = path.match(/^\/files\/([A-Za-z0-9]+)$/);
    if (agentFileMatch && req.method === "GET") {
      const oc = checkMcpOrigin(req);
      if (!oc.ok) return new Response("Rejected: " + oc.reason, { status: 403 });
      if (!checkMcpToken(req, url)) return new Response("unauthorized", { status: 401, headers: corsHeadersFor(req) });
      const resp = handleFileDownload(agentFileMatch[1], true);
      if (resp) return new Response(resp.body, { status: resp.status, headers: { ...Object.fromEntries(resp.headers), ...corsHeadersFor(req) } });
      return new Response("not found", { status: 404 });
    }

    // Extension WebSocket bridge
    if (path === "/browser/ws") {
      const originCheck = checkExtensionOrigin(req);
      if (!originCheck.ok) {
        console.warn("[browser-mcp] Rejected /browser/ws: " + originCheck.reason);
        return new Response("Rejected: " + originCheck.reason, { status: 403 });
      }
      if (!checkExtensionToken(req, url)) {
        return new Response("Auth token required. Provide ?token= parameter.", { status: 401 });
      }
      const rawExtId = url.searchParams.get("extId");
      if (rawExtId && !EXT_ID_PATTERN.test(rawExtId)) {
        return new Response("Invalid extension ID", { status: 400 });
      }
      const extId = rawExtId || ("ext_" + randomBytes(4).toString("hex"));
      const success = srv.upgrade(req, {
        data: { type: "browser-extension" as const, extensionId: extId, connectedAt: Date.now() },
      });
      if (success) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // MCP JSON-RPC endpoint (origin-gated - a malicious website must not be able to drive the browser)
    if (path === "/mcp") {
      if (req.method !== "POST") return new Response("POST /mcp", { status: 405, headers: CORS_HEADERS });
      const oc = checkMcpOrigin(req);
      if (!oc.ok) return new Response("Rejected: " + oc.reason, { status: 403 });
      if (!checkMcpToken(req, url)) return new Response("unauthorized", { status: 401, headers: corsHeadersFor(req) });
      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
          { status: 400, headers: corsHeadersFor(req) },
        );
      }
      const resp = await handle(body);
      if (resp === null) return new Response(null, { status: 204, headers: corsHeadersFor(req) });
      return Response.json(resp, { headers: corsHeadersFor(req) });
    }

    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) { handleBrowserWsOpen(ws); },
    close(ws) { handleBrowserWsClose(ws); },
    message(ws, message) { handleBrowserWsMessage(ws, message); },
    perMessageDeflate: false,
  },
});

// ============================================================================
// Gateway client (mirrors code-mcp.ts protocol)
// ============================================================================

if (gatewayMode) {
  const assignedDeviceId = deviceId ?? randomUUID();
  const localMcpUrl = "http://127.0.0.1:" + String(port) + "/mcp";
  const BASE_DELAY_MS = 1000;
  const MAX_DELAY_MS = 60_000;
  let retries = 0;

  (function connect() {
    const isLocal = /^(localhost|127\.|192\.168\.|10\.|172\.16\.|ws:\/\/|http:\/\/)/.test(gatewayDomain ?? "");
    const scheme = isLocal ? "ws" : "wss";
    const url = assignedDeviceId ? scheme + "://" + gatewayDomain + "/ws/" + assignedDeviceId : scheme + "://" + gatewayDomain + "/ws";
    console.error("[" + assignedDeviceId + "] Connecting to gateway " + url + " ...");
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err: any) {
      console.error("[" + assignedDeviceId + "] WS create failed: " + (err?.message ?? err));
      scheduleRetry();
      return;
    }

    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    const WATCHDOG_MS = 75_000;
    const armWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        console.error("[" + assignedDeviceId + "] no inbound for " + WATCHDOG_MS + "ms; forcing reconnect");
        try { ws.close(); } catch {}
      }, WATCHDOG_MS);
    };
    const cleanup = () => {
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
    };

    ws.addEventListener("open", () => {
      console.error("[" + assignedDeviceId + "] Connected to gateway");
      retries = 0;
      gatewayStatus.connected = true;
      gatewayStatus.deviceId = assignedDeviceId;
      ws.send(JSON.stringify({ type: "register", deviceId: assignedDeviceId }));
      armWatchdog();
      keepaliveTimer = setInterval(() => {
        try { ws.send(JSON.stringify({ type: "keepalive" })); }
        catch (err: any) {
          console.error("[" + assignedDeviceId + "] keepalive send failed: " + (err?.message ?? err));
          try { ws.close(); } catch {}
        }
      }, 25_000);
    });

    ws.addEventListener("message", async (e) => {
      armWatchdog();
      try {
        const msg = JSON.parse(e.data as string);
        if (msg?.type === "keepalive-ack") return;
        if (msg?.id == null || !msg?.request) return;
        const tokenParam = msg.token ? "?token=" + encodeURIComponent(msg.token) : "";
        try {
          const res = await fetch(localMcpUrl + tokenParam, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(msg.request),
            signal: AbortSignal.timeout(60_000),
          });
          let resp: any;
          try { resp = await res.json(); } catch {
            const text = await res.text().catch(() => "");
            resp = { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "upstream HTTP " + res.status + ": " + text.slice(0, 200) } };
          }
          ws.send(JSON.stringify({ id: msg.id, response: resp }));
        } catch (err: any) {
          // Forward an error response so the remote agent does not hang.
          try {
            ws.send(JSON.stringify({ id: msg.id, response: { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "upstream error: " + (err?.message ?? err) } } }));
          } catch {}
          console.error("[" + assignedDeviceId + "] handle error: " + (err?.message ?? err));
        }
      } catch (err: any) {
        console.error("[" + assignedDeviceId + "] gateway message error: " + (err?.message ?? err));
      }
    });

    ws.addEventListener("close", () => {
      cleanup();
      gatewayStatus.connected = false;
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, Math.min(retries, 6))) + Math.floor(Math.random() * 500);
      retries++;
      console.error("[" + assignedDeviceId + "] Disconnected; retry #" + retries + " in " + delay + "ms");
      setTimeout(connect, delay);
    });

    ws.addEventListener("error", (err: any) => {
      console.error("[" + assignedDeviceId + "] Gateway WS error: " + (err?.message ?? err));
    });

    function scheduleRetry() {
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, Math.min(retries, 6))) + Math.floor(Math.random() * 500);
      retries++;
      console.error("[" + assignedDeviceId + "] Retrying in " + delay + "ms");
      setTimeout(connect, delay);
    }
  })();
}

// ============================================================================
// Startup + shutdown
// ============================================================================

loadFileIndex();
console.error(
  "browser-mcp listening on http://" + (bindAddr === "0.0.0.0" ? "localhost" : bindAddr) + ":" + port + "/mcp"
  + (token ? " (auth)" : " (no auth)")
  + " - tools: " + Object.keys(tools).join(", ")
  + (gatewayMode ? " - gateway: " + gatewayDomain : ""),
);
if (gatewayMode && !token) {
  console.error(
    "WARNING: gateway mode is enabled WITHOUT --token. Anyone who can reach the gateway can control this browser. " +
    "Configure the same token on the gateway device to lock it down.",
  );
}
if (bindAddr !== "127.0.0.1" && !token) {
  console.error(
    "WARNING: binding to " + bindAddr + " without --token exposes browser control on the network. " +
    "Use --token when binding to 0.0.0.0.",
  );
}

function shutdown(signal: string) {
  console.error("\n[" + signal + "] shutting down");
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
