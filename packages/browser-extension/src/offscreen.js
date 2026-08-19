/**
 * Browser MCP Offscreen Document — Persistent WebSocket bridge.
 *
 * Maintains a WebSocket connection to the local Browser MCP server
 * and relays commands to/from the service worker.
 */

console.log("[bmcp-offscreen] Script loaded");

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_URL = "ws://localhost:7777/browser/ws";
const RECONNECT_DELAY_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 20000;
const KEEPALIVE_INTERVAL_MS = 25000;
/** Direct-gateway mode: the extension itself is the MCP server (no local server). */
const DEFAULT_GATEWAY = "wss://code-mcp.tuanm.dev"; // host, path is /ws/<deviceId>
const GW_BASE_DELAY_MS = 1000;
const GW_MAX_DELAY_MS = 60000;
const GW_WATCHDOG_MS = 75000;

// ============================================================================
// State
// ============================================================================

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let extensionId = crypto.randomUUID().slice(0, 8);
let serverUrl = DEFAULT_URL;
let authToken = null;
let deviceId = null; // gateway device ID (from popup): enables DIRECT gateway mode
let connectAttempts = 0;
let lastError = null;
let mode = "local"; // "local" (browser-mcp server) | "gateway" (code-mcp gateway, no local server)
let gatewayHost = null; // overridable (tests / self-hosted gateways)
let gatewayWs = null;
let gatewayKeepaliveTimer = null;
let gatewayWatchdogTimer = null;
let gatewayReconnectTimer = null;
let gatewayRetries = 0;

/**
 * Apply an explicit config object (from the service worker - the SW is the
 * storage authority because chrome.storage is NOT available in offscreen
 * documents).
 */
function applyConfig(cfg) {
  if (!cfg) return;
  if (cfg.serverUrl) serverUrl = cfg.serverUrl;
  if (cfg.deviceId !== undefined) deviceId = cfg.deviceId || null;
  if (cfg.authToken !== undefined) authToken = cfg.authToken || null;
  if (cfg.gatewayHost) gatewayHost = cfg.gatewayHost;
}

/** Ask the service worker for the saved config, apply it, then connect. */
async function loadConfigAndConnect() {
  try {
    const cfg = await chrome.runtime.sendMessage({ type: "get-config", fromOffscreen: true });
    applyConfig(cfg || {});
  } catch {}
  return connect();
}

// ============================================================================
// Keep Service Worker Alive
// ============================================================================

function keepAlive() {
  setInterval(() => {
    try {
      const port = chrome.runtime.connect({ name: "keepalive" });
      setTimeout(() => port.disconnect(), 1000);
    } catch {
      // Service worker might be restarting
    }
  }, KEEPALIVE_INTERVAL_MS);
}

// ============================================================================
// WebSocket Connection
// ============================================================================

/**
 * Connect dispatcher: with a gateway device ID the extension talks to the
 * code-mcp gateway directly (no local server); otherwise it uses the local
 * browser-mcp server bridge.
 */
async function connect() {
  if (deviceId) return connectGateway();
  return connectLocal();
}

// ---- local server bridge (existing flow) ----
async function connectLocal() {
  console.log("[bmcp-offscreen] connect() called, ws state:", ws?.readyState, "url:", serverUrl);

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log("[bmcp-offscreen] Already connected/connecting, skipping");
    return;
  }

  connectAttempts++;
  let url = `${serverUrl}?extId=${extensionId}`;
  if (deviceId) url += `&deviceId=${encodeURIComponent(deviceId)}`;
  if (authToken) url += `&token=${encodeURIComponent(authToken)}`;
  const safeUrl = authToken ? url.replace(/token=[^&]+/, "token=***") : url;
  console.log(`[bmcp-offscreen] Connecting to ${safeUrl} (attempt ${connectAttempts})`);

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error("[bmcp-offscreen] WebSocket creation failed:", err);
    lastError = `WS create: ${err.message}`;
    ws = null;
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[bmcp-offscreen] Connected to Browser MCP server");
    lastError = null;
    connectAttempts = 0;
    broadcastStatus(true);
    startHeartbeat();
  };

  ws.onclose = (event) => {
    console.log(`[bmcp-offscreen] Disconnected (code: ${event.code}, reason: ${event.reason})`);
    lastError = `WS closed: ${event.code}`;
    ws = null;
    broadcastStatus(false);
    stopHeartbeat();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error("[bmcp-offscreen] WebSocket error:", err);
    lastError = "WS error (see offscreen console)";
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "pong") return;

      // Respond to server-initiated pings
      if (data.type === "ping") {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong" }));
        }
        return;
      }

      if (data.id && data.method) {
        try {
          // Race the service worker relay against a timeout to prevent silent hangs.
          // Must EXCEED the server's max per-command timeout (120s) so the server
          // times out first and returns a clean error instead of a silent hang.
          const RELAY_TIMEOUT_MS = 125_000;
          const response = await Promise.race([
            chrome.runtime.sendMessage({
              source: "offscreen",
              type: "command",
              id: data.id,
              method: data.method,
              params: data.params || {},
            }),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(`SW relay timeout after ${RELAY_TIMEOUT_MS / 1000}s`)),
                RELAY_TIMEOUT_MS,
              ),
            ),
          ]);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                id: data.id,
                result: response?.result,
                error: response?.error,
              }),
            );
          }
        } catch (err) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                id: data.id,
                error: { message: `Service worker error: ${err.message}` },
              }),
            );
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  };
}

// ---- direct gateway mode (the extension is the MCP server) ----

async function connectGateway() {
  mode = "gateway";
  if (gatewayWs && (gatewayWs.readyState === WebSocket.OPEN || gatewayWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  gatewayRetries++;
  let host = gatewayHost || DEFAULT_GATEWAY;
  const scheme = /^(localhost|127\.|192\.168\.|10\.|172\.16\.)/.test(host.replace(/^wss?:\/\//, "").split("/")[0]) ? "ws" : "wss";
  const url = scheme + "://" + host.replace(/^wss?:\/\//, "").replace(/\/$/, "") + "/ws/" + encodeURIComponent(deviceId);
  console.log("[bmcp-offscreen] Connecting to gateway " + url + " (attempt " + gatewayRetries + ")");
  try {
    gatewayWs = new WebSocket(url);
  } catch (err) {
    console.error("[bmcp-offscreen] Gateway WS create failed:", err);
    lastError = "gateway create: " + err.message;
    scheduleGatewayReconnect();
    return;
  }
  const gen = gatewayWs;

  const armWatchdog = () => {
    if (gatewayWatchdogTimer) clearTimeout(gatewayWatchdogTimer);
    gatewayWatchdogTimer = setTimeout(() => {
      console.error("[bmcp-offscreen] Gateway watchdog: no inbound for " + GW_WATCHDOG_MS + "ms");
      try { gen.close(); } catch {}
    }, GW_WATCHDOG_MS);
  };

  gen.onopen = () => {
    console.log("[bmcp-offscreen] Connected to gateway (device " + deviceId + ")");
    lastError = null;
    gatewayRetries = 0;
    broadcastStatus(true);
    gen.send(JSON.stringify({ type: "register", deviceId }));
    armWatchdog();
    if (gatewayKeepaliveTimer) clearInterval(gatewayKeepaliveTimer);
    gatewayKeepaliveTimer = setInterval(() => {
      if (gen && gen.readyState === WebSocket.OPEN) {
        try { gen.send(JSON.stringify({ type: "keepalive" })); } catch {}
      }
    }, KEEPALIVE_INTERVAL_MS);
  };

  gen.onclose = (event) => {
    if (gatewayWatchdogTimer) clearTimeout(gatewayWatchdogTimer);
    if (gatewayKeepaliveTimer) clearInterval(gatewayKeepaliveTimer);
    if (gatewayWs === gen) gatewayWs = null;
    lastError = "gateway closed: " + event.code;
    broadcastStatus(false);
    scheduleGatewayReconnect();
  };

  gen.onerror = (err) => {
    console.error("[bmcp-offscreen] Gateway WS error:", err);
    lastError = "gateway error";
  };

  gen.onmessage = async (event) => {
    armWatchdog();
    try {
      const data = JSON.parse(event.data);
      if (data.type === "keepalive-ack") return;
      if (data.id == null || !data.request) return;
      // Optional token check: the gateway sends the device token; verify it
      // matches the popup token when one is configured (defense in depth).
      if (authToken && data.token && data.token !== authToken) {
        gen.send(JSON.stringify({ id: data.id, response: { jsonrpc: "2.0", id: data.id, error: { code: -32001, message: "token mismatch" } } }));
        return;
      }
      try {
        const response = await chrome.runtime.sendMessage({ source: "offscreen", type: "mcp-request", id: data.id, request: data.request });
        if (gen && gen.readyState === WebSocket.OPEN) {
          gen.send(JSON.stringify({ id: data.id, response: response && response.response }));
        }
      } catch (err) {
        if (gen && gen.readyState === WebSocket.OPEN) {
          gen.send(JSON.stringify({ id: data.id, response: { jsonrpc: "2.0", id: data.id, error: { code: -32000, message: "extension error: " + (err.message || err) } } }));
        }
      }
    } catch {}
  };
}

function scheduleGatewayReconnect() {
  if (gatewayReconnectTimer) return;
  const delay = Math.min(GW_MAX_DELAY_MS, GW_BASE_DELAY_MS * Math.pow(2, Math.min(gatewayRetries, 6))) + Math.floor(Math.random() * 500);
  console.log("[bmcp-offscreen] Scheduling gateway reconnect in " + delay + "ms");
  gatewayReconnectTimer = setTimeout(() => {
    gatewayReconnectTimer = null;
    connect().catch(() => {});
  }, delay);
}

function stopGateway() {
  if (gatewayWatchdogTimer) { clearTimeout(gatewayWatchdogTimer); gatewayWatchdogTimer = null; }
  if (gatewayKeepaliveTimer) { clearInterval(gatewayKeepaliveTimer); gatewayKeepaliveTimer = null; }
  if (gatewayReconnectTimer) { clearTimeout(gatewayReconnectTimer); gatewayReconnectTimer = null; }
  if (gatewayWs) {
    gatewayWs.onclose = null;
    gatewayWs.onerror = null;
    gatewayWs.onmessage = null;
    try { gatewayWs.close(); } catch {}
    gatewayWs = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log(`[bmcp-offscreen] Scheduling reconnect in ${RECONNECT_DELAY_MS}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err) => console.error("[bmcp-offscreen] Reconnect failed:", err));
  }, RECONNECT_DELAY_MS);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function broadcastStatus(connected) {
  chrome.runtime
    .sendMessage({
      source: "offscreen",
      type: "connection-status",
      connected,
      extensionId,
    })
    .catch(() => {});
}

// ============================================================================
// Message Listener
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[bmcp-offscreen] Received message:", message.type);

  if (message.type === "get-status") {
    const gwConnected = gatewayWs !== null && gatewayWs !== undefined && gatewayWs.readyState === WebSocket.OPEN;
    const localConnected = ws !== null && ws !== undefined && ws.readyState === WebSocket.OPEN;
    const connected = mode === "gateway" ? gwConnected : localConnected;
    const status = {
      connected,
      mode,
      extensionId,
      deviceId,
      wsState: mode === "gateway" ? (gatewayWs ? gatewayWs.readyState : "no-gw-ws") : (ws ? ws.readyState : "no-ws"),
      connectAttempts,
      lastError,
    };
    console.log("[bmcp-offscreen] Responding to get-status:", JSON.stringify(status));
    sendResponse(status);
    return false;
  }

  if (message.type === "set-server-url") {
    console.log("[bmcp-offscreen] set-server-url:", message.url);
    serverUrl = message.url || DEFAULT_URL;
    if (message.token !== undefined) authToken = message.token || null;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
      ws = null;
    }
    stopHeartbeat();
    stopGateway();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("[bmcp-offscreen] connect after set-server-url failed:", err);
        sendResponse({ ok: true });
      });
    return true;
  }

  if (message.type === "reconnect") {
    console.log("[bmcp-offscreen] reconnect requested, url from message:", message.url);
    if (message.url) serverUrl = message.url;
    if (message.extensionId) extensionId = message.extensionId;
    if (message.token !== undefined) authToken = message.token || null;
    if (message.deviceId !== undefined) deviceId = message.deviceId || null;
    if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
        ws = null;
      }
      stopHeartbeat();
      stopGateway();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => {
          console.error("[bmcp-offscreen] reconnect failed:", err);
          sendResponse({ ok: true }); // still ok — reconnect will auto-retry
        });
    return true; // async response
  }

  if (message.type === "disconnect") {
    console.log("[bmcp-offscreen] disconnect requested");
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
      ws = null;
    }
    stopHeartbeat();
    stopGateway();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    chrome.runtime.sendMessage({ source: "offscreen", type: "connection-status", connected: false }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // Read a local file and return it as base64 (direct gateway mode: no server to upload to).
  // The service worker cannot fetch file:// URLs, but the offscreen document can.
  if (message.type === "read-file") {
    (async () => {
      try {
        const { filePath, maxBytes } = message;
        let fileUrl;
        if (/^[A-Za-z]:/.test(filePath)) {
          fileUrl = "file:///" + filePath.replace(/\\/g, "/");
        } else {
          fileUrl = "file://" + filePath;
        }
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error("Cannot read file: " + filePath);
        const blob = await response.blob();
        const cap = maxBytes || 512 * 1024;
        if (blob.size > cap) throw new Error("File too large for inline read (" + blob.size + " bytes, max " + cap + ")");
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        const parts = [];
        const chunkSize = 32768;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
        }
        const name = filePath.split(/[\\/]/).pop() || "download";
        sendResponse({ ok: true, base64: btoa(parts.join("")), mime: blob.type, size: blob.size, name });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // Read local file and upload to chat server (offscreen can access file:// URLs, service worker cannot)
  if (message.type === "upload-file") {
    (async () => {
      try {
        const { filePath, mime, uploadUrl } = message;
        // Normalize Windows paths (C:\... -> file:///C:/...)
        let fileUrl;
        if (/^[A-Za-z]:/.test(filePath)) {
          fileUrl = `file:///${filePath.replace(/\\/g, "/")}`;
        } else {
          fileUrl = `file://${filePath}`;
        }
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`Cannot read file: ${filePath}`);
        const blob = await response.blob();
        if (blob.size > 500 * 1024 * 1024) {
          throw new Error(`File too large (${(blob.size / 1024 / 1024).toFixed(1)} MiB). Max 500 MiB.`);
        }
        let filename = filePath.split(/[/\\]/).pop() || "download";
        // Strip Chrome's temp download suffix if present (.crdownload fallback path)
        if (filename.endsWith(".crdownload")) {
          filename = filename.slice(0, -".crdownload".length) || "download";
        }
        const file = new File([blob], filename, { type: mime || "application/octet-stream" });
        const formData = new FormData();
        formData.append("file", file);
        const uploadResp = await fetch(uploadUrl, { method: "POST", body: formData });
        if (!uploadResp.ok) {
          const text = await uploadResp.text().catch(() => "");
          throw new Error(`Upload failed (HTTP ${uploadResp.status}): ${text.slice(0, 200)}`);
        }
        const result = await uploadResp.json();
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // async response
  }

  return false;
});

// ============================================================================
// Initialize
// ============================================================================

keepAlive();
// Small delay to let extensionId IIFE finish; read saved config first so the
// gateway link (device ID + token) survives offscreen/SW restarts.
setTimeout(() => {
  loadConfigAndConnect().catch((err) => console.error("[bmcp-offscreen] Initial connect failed:", err));
}, 100);
