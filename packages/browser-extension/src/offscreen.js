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

// ============================================================================
// State
// ============================================================================

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let extensionId = crypto.randomUUID().slice(0, 8);
let serverUrl = DEFAULT_URL;
let authToken = null;
let deviceId = null; // gateway device ID (from popup) - passed to the local server
let connectAttempts = 0;
let lastError = null;

/**
 * Load persistent config (server URL, gateway device ID, token) from storage.
 * chrome.storage is available to offscreen documents, so the config survives
 * offscreen/service-worker restarts (the SW also writes it on popup Connect).
 */
async function loadConfigIntoState() {
  try {
    const cfg = await chrome.storage.local.get(["serverUrl", "deviceId", "authToken"]);
    if (cfg.serverUrl) serverUrl = cfg.serverUrl;
    if (cfg.deviceId !== undefined) deviceId = cfg.deviceId || null;
    if (cfg.authToken !== undefined) authToken = cfg.authToken || null;
  } catch {}
}

/** Apply config from storage, then (re)connect. */
async function loadConfigAndConnect() {
  await loadConfigIntoState();
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

async function connect() {
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
    const connected = ws !== null && ws.readyState === WebSocket.OPEN;
    const status = {
      connected,
      extensionId,
      deviceId,
      wsState: ws ? ws.readyState : "no-ws",
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
    // Storage is the source of truth for persistent config (survives restarts).
    loadConfigIntoState().then(() => {
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
        ws = null;
      }
      stopHeartbeat();
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
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connected = false;
    chrome.runtime.sendMessage({ source: "offscreen", type: "connection-status", connected: false }).catch(() => {});
    sendResponse({ ok: true });
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
