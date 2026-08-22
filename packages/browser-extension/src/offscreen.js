/**
 * Browser MCP Offscreen Document — Persistent WebSocket bridge.
 *
 * Connects either to the local Browser MCP server (ws://localhost:7777/browser/ws)
 * or, when a device ID is configured, directly to the code-mcp gateway
 * (wss://code-mcp.tuanm.dev/ws/<id>) and relays MCP requests to the service
 * worker, which answers them in place (extension = MCP server).
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
  const scheme = /^(localhost|127\.|192\.168\.|10\.|172\.16\.)/.test(host.replace(/^wss?:\/\//, "").split("/")[0])
    ? "ws"
    : "wss";
  const url =
    scheme + "://" + host.replace(/^wss?:\/\//, "").replace(/\/$/, "") + "/ws/" + encodeURIComponent(deviceId);
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
      try {
        gen.close();
      } catch {}
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
        try {
          gen.send(JSON.stringify({ type: "keepalive" }));
        } catch {}
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
        gen.send(
          JSON.stringify({
            id: data.id,
            response: { jsonrpc: "2.0", id: data.id, error: { code: -32001, message: "token mismatch" } },
          }),
        );
        return;
      }
      try {
        const response = await chrome.runtime.sendMessage({
          source: "offscreen",
          type: "mcp-request",
          id: data.id,
          request: data.request,
        });
        let inner = response && response.response;
        if (inner && inner.id == null) {
          // Notifications have no request id. Strict clients (codex/pi) reject a
          // response with id:null, so echo the gateway's tunnel id instead.
          inner = Object.assign({}, inner, { id: data.id });
        }
        if (gen && gen.readyState === WebSocket.OPEN) {
          gen.send(JSON.stringify({ id: data.id, response: inner }));
        }
      } catch (err) {
        if (gen && gen.readyState === WebSocket.OPEN) {
          gen.send(
            JSON.stringify({
              id: data.id,
              response: {
                jsonrpc: "2.0",
                id: data.id,
                error: { code: -32000, message: "extension error: " + (err.message || err) },
              },
            }),
          );
        }
      }
    } catch {}
  };
}

function scheduleGatewayReconnect() {
  if (gatewayReconnectTimer) return;
  const delay =
    Math.min(GW_MAX_DELAY_MS, GW_BASE_DELAY_MS * Math.pow(2, Math.min(gatewayRetries, 6))) +
    Math.floor(Math.random() * 500);
  console.log("[bmcp-offscreen] Scheduling gateway reconnect in " + delay + "ms");
  gatewayReconnectTimer = setTimeout(() => {
    gatewayReconnectTimer = null;
    connect().catch(() => {});
  }, delay);
}

function stopGateway() {
  if (gatewayWatchdogTimer) {
    clearTimeout(gatewayWatchdogTimer);
    gatewayWatchdogTimer = null;
  }
  if (gatewayKeepaliveTimer) {
    clearInterval(gatewayKeepaliveTimer);
    gatewayKeepaliveTimer = null;
  }
  if (gatewayReconnectTimer) {
    clearTimeout(gatewayReconnectTimer);
    gatewayReconnectTimer = null;
  }
  if (gatewayWs) {
    gatewayWs.onclose = null;
    gatewayWs.onerror = null;
    gatewayWs.onmessage = null;
    try {
      gatewayWs.close();
    } catch {}
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

// ============================================================================
// Screen / Tab Recording (MediaRecorder in the offscreen document)
// ============================================================================
//
// Tab recording: the service worker calls chrome.tabCapture.getMediaStreamId()
// and sends the streamId here; we attach getUserMedia with chromeMediaSource
// "tab" and record with MediaRecorder (WebM).
// Window/screen recording: getDisplayMedia() shows the user a picker; after
// they choose, we record the returned stream the same way.
// The recorded WebM is kept in memory (chunks) until 'record-stop', then the
// bytes are handed back to the service worker which saves them to the user's
// device (chrome.downloads) and/or uploads them to the local server.

let recorder = null;
let recorderStream = null;
let recorderChunks = [];
let recorderStartTime = 0;
let recorderMode = null; // "tab" | "window" | "screen"

/**
 * Shared REC badge painter (red dot + "REC mm:ss" + optional tab id).
 * Used by the overlay pipeline, the session canvas, and per-frame painting.
 */
function paintRecBadge(ctx, canvas, tabId, startTime) {
  try {
    const pad = 14;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    const label = "REC " + mm + ":" + ss + (tabId ? "  tab " + tabId : "");
    ctx.font = "bold 18px ui-monospace, SFMono-Regular, Menlo, monospace";
    const w = ctx.measureText(label).width;
    const x = canvas.width - w - pad * 2;
    const y = pad;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - pad, y - pad, w + pad * 2, 30, 6);
    else ctx.rect(x - pad, y - pad, w + pad * 2, 30);
    ctx.fill();
    ctx.fillStyle = "#ff3b30";
    ctx.beginPath();
    ctx.arc(x - pad + 9, y + 6, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x + 4, y + 14);
  } catch {}
}

function pickMimeType() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c))
      return c;
  }
  return "video/webm";
}

// ============================================================================
// Shared REC overlay: routes any capture stream through a canvas that draws a
// red REC badge + live elapsed time + current tab id, so EVERY recording mode
// (single tab, window/screen, session) shows the same indicator in the video.
// ============================================================================

let overlayCanvas = null;
let overlayCtx = null;
let overlayVideo = null;
let overlayVideoTrack = null;
let overlayRaf = null;
let overlayTimer = null;
let overlayStart = 0;
let overlayTabId = null;

/** Stop the overlay pipeline (does NOT stop the source stream tracks). */
function stopRecOverlay() {
  if (overlayRaf) cancelAnimationFrame(overlayRaf);
  overlayRaf = null;
  if (overlayTimer) clearInterval(overlayTimer);
  overlayTimer = null;
  if (overlayVideo) {
    try {
      overlayVideo.srcObject = null;
    } catch {}
    overlayVideo = null;
  }
  if (overlayVideoTrack) {
    try {
      overlayVideoTrack.stop();
    } catch {}
    overlayVideoTrack = null;
  }
  overlayCanvas = null;
  overlayCtx = null;
  overlayStart = 0;
  overlayTabId = null;
}

/**
 * Wrap a source MediaStream so the recording includes the REC badge overlay.
 * Returns a NEW MediaStream (canvas video + source audio); call stopRecOverlay()
 * on stop. The source stream itself is left untouched (caller owns its tracks).
 */
function withRecOverlay(sourceStream, tabId) {
  stopRecOverlay();
  overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = 1280;
  overlayCanvas.height = 720;
  overlayCtx = overlayCanvas.getContext("2d");
  overlayStart = Date.now();
  overlayTabId = tabId || null;

  overlayVideo = document.createElement("video");
  overlayVideo.muted = true;
  overlayVideo.playsInline = true;
  overlayVideo.srcObject = sourceStream;
  overlayVideo.play().catch(() => {});

  // NOTE: offscreen documents are HIDDEN pages - requestAnimationFrame is
  // throttled/paused there, so a rAF-only paint loop leaves the canvas blank
  // and canvas.captureStream() emits no frames -> 0-byte recordings.
  // Drive the paint with setInterval instead; rAF is only an optional bonus.
  const capStream = overlayCanvas.captureStream(30);
  overlayVideoTrack = capStream.getVideoTracks()[0];

  const draw = () => {
    if (!overlayCtx || !overlayCanvas) return;
    try {
      const vw = overlayVideo.videoWidth;
      const vh = overlayVideo.videoHeight;
      if (vw && vh) {
        // Scale to canvas without resizing (resizing a canvas with an active
        // captureStream can stall frame production in some Chrome versions).
        const scale = Math.min(overlayCanvas.width / vw, overlayCanvas.height / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        const dx = (overlayCanvas.width - dw) / 2;
        const dy = (overlayCanvas.height - dh) / 2;
        overlayCtx.fillStyle = "#000";
        overlayCtx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        overlayCtx.drawImage(overlayVideo, dx, dy, dw, dh);
      } else {
        overlayCtx.fillStyle = "#111";
        overlayCtx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      }
    } catch {}
    paintRecBadge(overlayCtx, overlayCanvas, overlayTabId, overlayStart);
  };
  overlayRaf = requestAnimationFrame(draw);
  overlayTimer = setInterval(draw, 50); // ~20fps guaranteed paint -> real bytes

  const tracks = [overlayVideoTrack];
  const audioTracks = sourceStream.getAudioTracks();
  if (audioTracks.length) tracks.push(...audioTracks);
  return new MediaStream(tracks);
}

async function startRecording(streamId, includeAudio, mode, targetTabId) {
  try {
    if (recorder) throw new Error("A recording is already in progress. Stop it first (record action=stop).");
    let stream;
    if (mode === "tab" && streamId) {
      // Tab capture via a streamId obtained in the service worker (the
      // documented pattern). chrome.tabCapture itself is unavailable in the
      // offscreen document and is gesture-gated in a SW, so the SW acquires the
      // streamId after the user has invoked the extension on that tab.
      const base = { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } };
      stream = await navigator.mediaDevices.getUserMedia({
        audio: includeAudio ? base : false,
        video: base,
      });
    } else {
      // window / screen (or tab fallback): show the user Chrome's share picker.
      // preferCurrentTab preselects the current tab for the tab-capture fallback.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: includeAudio,
        preferCurrentTab: mode === "tab",
      });
    }
    // Route the capture through the shared REC overlay so the video shows the
    // red REC badge + live elapsed time + tab id (all recording modes).
    const recStream = withRecOverlay(stream, mode === "tab" ? targetTabId : null);
    const mime = pickMimeType();
    const r = new MediaRecorder(recStream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    recorderChunks = [];
    r.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recorderChunks.push(e.data);
    };
    r.onstop = () => {
      stopRecOverlay();
      // Stop tracks so the tab indicator clears / camera light goes off
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
    r.start(250); // collect chunks every 250ms so we can report size live
    recorder = r;
    recorderStream = stream;
    recorderStartTime = Date.now();
    recorderMode = mode;
    return { ok: true, mode, mime };
  } catch (err) {
    stopRecOverlay();
    console.error("[bmcp-offscreen] startRecording failed:", err);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!recorder) {
      resolve({ ok: false, error: "No recording in progress" });
      return;
    }
    const r = recorder;
    recorder = null;
    const chunks = recorderChunks;
    recorderChunks = [];
    const mode = recorderMode;
    recorderMode = null;
    const startedAt = recorderStartTime;
    recorderStartTime = 0;
    r.onstop = async () => {
      if (recorderStream) {
        recorderStream.getTracks().forEach((t) => t.stop());
        recorderStream = null;
      }
      const blob = new Blob(chunks, { type: r.mimeType || "video/webm" });
      // Blob URLs are same-origin for every extension context, so the service
      // worker can fetch() this URL (or hand it to chrome.downloads.download).
      const blobUrl = URL.createObjectURL(blob);
      resolve({ ok: true, blobUrl, mime: blob.type, size: blob.size, mode, elapsedMs: Date.now() - startedAt });
    };
    try {
      r.stop();
    } catch (err) {
      resolve({ ok: false, error: String(err) });
    }
  });
}

function recordingStatus() {
  if (!recorder) return { recording: false };
  const size = recorderChunks.reduce((s, c) => s + c.size, 0);
  return {
    recording: true,
    mode: recorderMode,
    elapsed_ms: Date.now() - recorderStartTime,
    size_bytes: size,
    mime: recorder ? recorder.mimeType : null,
  };
}

// ============================================================================
// Multi-Tab Session Recording (continuous single-file recording)
// ============================================================================
//
// Instead of recording N tabs as N separate WebM files and concatenating them
// (fragile - WebM cluster timestamps), we record ONE continuous video: a
// virtual <canvas> is the video source of a single MediaRecorder, and the
// agent switches which tab's stream is drawn onto it (record action=tab
// tab_id=X). Audio follows the current tab via WebAudio. The result is a
// single seamless WebM covering all steps across all tabs - no concatenation.
// Tab streams come from chrome.tabCapture (invocation-gated once per session;
// after the user clicks the toolbar / "Record this tab" once, arbitrary tabs
// with host permissions can be captured without the screen picker).

let sessionActive = false;
let sessionRecorder = null;
let sessionCanvas = null;
let sessionCanvasStream = null;
let sessionAudioCtx = null;
let sessionAudioDest = null;
let sessionVideoEl = null;
let sessionStream = null;
let sessionChunks = [];
let sessionStartTime = 0;
let sessionRafId = null;
let sessionTimer = null;
let sessionLastFrame = null; // Image of the most recent screencast frame
let sessionCurrentTabId = null;

function sessionPickMime() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c))
      return c;
  }
  return "video/webm";
}

async function sessionStart(initialTabId, includeAudio) {
  try {
    if (sessionActive) throw new Error("A session recording is already active. Use record action=session_stop first.");
    // Virtual canvas: 16:9; frames are painted by record-session-frame messages
    // (CDP screencast from the SW) - no tab stream / permission prompt needed.
    sessionCanvas = document.createElement("canvas");
    sessionCanvas.width = 1280;
    sessionCanvas.height = 720;
    sessionCanvasStream = sessionCanvas.captureStream(30);

    // Narration audio channel: the SW's speak tool can inject TTS audio here so
    // the agent's spoken explanations are captured in the session recording.
    sessionAudioCtx = new AudioContext();
    sessionAudioDest = sessionAudioCtx.createMediaStreamDestination();
    sessionNarrationGain = sessionAudioCtx.createGain();
    sessionNarrationGain.gain.value = 1;
    sessionNarrationGain.connect(sessionAudioDest);

    const tracks = [...sessionCanvasStream.getVideoTracks(), ...sessionAudioDest.stream.getAudioTracks()];
    const mime = sessionPickMime();
    sessionRecorder = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    sessionChunks = [];
    sessionRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) sessionChunks.push(e.data);
    };
    sessionRecorder.start(250);
    sessionActive = true;
    sessionStartTime = Date.now();
    sessionCurrentTabId = null;
    sessionLastFrame = null;
    // Drive the paint loop with setInterval, not rAF: offscreen docs are hidden
    // pages where rAF is throttled/paused. Without periodic paints the canvas
    // stays blank and captureStream emits no frames -> 0-byte recordings.
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = setInterval(sessionDrawLoop, 50); // ~20fps guaranteed paint
    return { ok: true, mime };
  } catch (err) {
    console.error("[bmcp-offscreen] sessionStart failed:", err);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** Draw the current tab's video (or last screencast frame) + REC badge. */
function sessionDrawLoop() {
  if (!sessionActive || !sessionCanvas) return;
  try {
    const ctx = sessionCanvas.getContext("2d");
    if (sessionVideoEl && sessionVideoEl.videoWidth && sessionVideoEl.videoHeight) {
      const vw = sessionVideoEl.videoWidth,
        vh = sessionVideoEl.videoHeight;
      // Scale without resizing (resizing a canvas with an active captureStream
      // can stall frame production).
      const scale = Math.min(sessionCanvas.width / vw, sessionCanvas.height / vh);
      const dw = vw * scale,
        dh = vh * scale;
      const dx = (sessionCanvas.width - dw) / 2,
        dy = (sessionCanvas.height - dh) / 2;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, sessionCanvas.width, sessionCanvas.height);
      ctx.drawImage(sessionVideoEl, dx, dy, dw, dh);
    } else if (sessionLastFrame && sessionLastFrame.width) {
      // Repaint the most recent screencast frame (keeps the canvas producing
      // frames between screencast frames / on static pages).
      const vw = sessionLastFrame.width,
        vh = sessionLastFrame.height;
      const scale = Math.min(sessionCanvas.width / vw, sessionCanvas.height / vh);
      const dw = vw * scale,
        dh = vh * scale;
      const dx = (sessionCanvas.width - dw) / 2,
        dy = (sessionCanvas.height - dh) / 2;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, sessionCanvas.width, sessionCanvas.height);
      ctx.drawImage(sessionLastFrame, dx, dy, dw, dh);
    } else {
      // No tab stream yet: fill with a neutral background so the file is valid.
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, sessionCanvas.width, sessionCanvas.height);
    }
    paintRecBadge(ctx, sessionCanvas, sessionCurrentTabId, sessionStartTime);
  } catch {}
}

/** Switch the session to a different tab (captures its stream via streamId). */
async function sessionSwitchTab(tabId, includeAudio) {
  try {
    if (!sessionActive) throw new Error("No active session. Start one with record action=session_start first.");
    if (tabId === sessionCurrentTabId) return { ok: true, switched: false, tab_id: tabId };
    // Tear down the previous tab's stream.
    if (sessionStream) {
      sessionStream.getTracks().forEach((t) => t.stop());
      sessionStream = null;
    }
    // Get the tab stream from the SW-provided streamId (chrome.tabCapture, gesture-gated).
    const streamId = await chrome.runtime.sendMessage({ type: "tabcapture-stream", tabId }).catch(() => null);
    if (!streamId)
      throw new Error(
        "Could not acquire tab capture for tab " +
          tabId +
          ". Click the toolbar icon once to invoke the extension (tab capture permission).",
      );
    const base = { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } };
    sessionStream = await navigator.mediaDevices.getUserMedia({
      audio: includeAudio ? base : false,
      video: base,
    });
    // Feed audio into the session's audio destination.
    if (includeAudio && sessionStream.getAudioTracks().length) {
      const src = sessionAudioCtx.createMediaStreamSource(sessionStream);
      src.connect(sessionAudioDest);
    }
    sessionVideoEl.srcObject = sessionStream;
    await sessionVideoEl.play().catch(() => {});
    sessionCurrentTabId = tabId;
    return { ok: true, switched: true, tab_id: tabId };
  } catch (err) {
    console.error("[bmcp-offscreen] sessionSwitchTab failed:", err);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function sessionStatus() {
  if (!sessionActive) return { recording: false };
  return {
    recording: true,
    mode: "session",
    current_tab_id: sessionCurrentTabId,
    elapsed_ms: Date.now() - sessionStartTime,
    size_bytes: sessionChunks.reduce((s, c) => s + c.size, 0),
    mime: sessionRecorder ? sessionRecorder.mimeType : null,
  };
}

function sessionStop() {
  return new Promise((resolve) => {
    if (!sessionActive) {
      resolve({ ok: false, error: "No active session recording" });
      return;
    }
    if (sessionRafId) cancelAnimationFrame(sessionRafId);
    sessionRafId = null;
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = null;
    sessionLastFrame = null;
    const r = sessionRecorder;
    sessionActive = false;
    sessionRecorder = null;
    const chunks = sessionChunks;
    sessionChunks = [];
    const tabId = sessionCurrentTabId;
    sessionCurrentTabId = null;
    const startedAt = sessionStartTime;
    sessionStartTime = 0;
    r.onstop = async () => {
      if (sessionStream) {
        sessionStream.getTracks().forEach((t) => t.stop());
        sessionStream = null;
      }
      if (sessionVideoEl) {
        sessionVideoEl.srcObject = null;
        sessionVideoEl = null;
      }
      try {
        if (sessionAudioCtx) sessionAudioCtx.close();
      } catch {}
      sessionAudioCtx = null;
      sessionAudioDest = null;
      const realChunks = chunks.filter(
        (c) => c && typeof c.size === "number" && c.size > 0 && typeof c.slice === "function" && c.type,
      );
      const blob = new Blob(realChunks, { type: r.mimeType || "video/webm" });
      const blobUrl = URL.createObjectURL(blob);
      resolve({
        ok: true,
        blobUrl,
        mime: blob.type,
        size: blob.size,
        mode: "session",
        elapsedMs: Date.now() - startedAt,
        tabs: tabId ? [tabId] : [],
      });
    };
    try {
      r.stop();
    } catch (err) {
      resolve({ ok: false, error: String(err) });
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[bmcp-offscreen] Received message:", message.type);

  if (message.type === "record-start") {
    startRecording(message.streamId, message.includeAudio !== false, message.mode || "tab", message.targetTabId).then(
      (r) => sendResponse(r),
    );
    return true;
  }

  if (message.type === "record-start-display") {
    startRecording(null, message.includeAudio !== false, message.mode || "window").then((r) => sendResponse(r));
    return true;
  }

  if (message.type === "record-stop") {
    stopRecording().then((r) => sendResponse(r));
    return true;
  }

  if (message.type === "record-status") {
    sendResponse(recordingStatus());
    return false;
  }

  // Multi-tab session recording
  if (message.type === "record-session-start") {
    sessionStart(message.tabId || null, message.includeAudio !== false).then((r) => sendResponse(r));
    return true;
  }
  if (message.type === "record-session-tab") {
    sessionSwitchTab(message.tabId, message.includeAudio !== false).then((r) => sendResponse(r));
    return true;
  }
  if (message.type === "record-session-status") {
    sendResponse(sessionStatus());
    return false;
  }
  if (message.type === "record-session-stop") {
    sessionStop().then((r) => sendResponse(r));
    return true;
  }
  if (message.type === "record-session-narrate") {
    // Play agent narration into the session audio so it is captured.
    try {
      if (!sessionActive || !sessionAudioCtx) {
        sendResponse({ ok: false, error: "No active session" });
        return false;
      }
      if (!("speechSynthesis" in window)) {
        sendResponse({ ok: false, error: "speechSynthesis unavailable" });
        return false;
      }
      const u = new SpeechSynthesisUtterance(String(message.text || "").slice(0, 2000));
      const voices = window.speechSynthesis.getVoices();
      const en = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("en")) || voices[0];
      if (en) u.voice = en;
      u.rate = 1;
      u.pitch = 1;
      // Route the utterance into the narration gain -> session audio dest.
      // (speechSynthesis outputs to the system speakers by default; for capture
      // we rely on getDisplayMedia-style system audio, or we fall back to
      // playing an Audio element. See note below.)
      u.onend = () => sendResponse({ ok: true, spoken: String(message.text).slice(0, 80) });
      u.onerror = (e) => sendResponse({ ok: false, error: String((e && e.error) || "tts error") });
      window.speechSynthesis.speak(u);
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }
  if (message.type === "record-session-frame") {
    // Draw a screencast JPEG frame (base64 dataURL) onto the session canvas.
    try {
      if (!sessionActive || !sessionCanvas) {
        sendResponse({ ok: false });
        return false;
      }
      const img = new Image();
      img.onload = () => {
        try {
          sessionLastFrame = img;
          // Draw immediately so the frame appears even before the next paint
          // tick; the interval loop keeps repainting it + the REC badge.
          const ctx = sessionCanvas.getContext("2d");
          const vw = img.width,
            vh = img.height;
          const scale = Math.min(sessionCanvas.width / vw, sessionCanvas.height / vh);
          const dw = vw * scale,
            dh = vh * scale;
          const dx = (sessionCanvas.width - dw) / 2,
            dy = (sessionCanvas.height - dh) / 2;
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, sessionCanvas.width, sessionCanvas.height);
          ctx.drawImage(img, dx, dy, dw, dh);
          paintRecBadge(ctx, sessionCanvas, sessionCurrentTabId, sessionStartTime);
          // Track live size: frames are not MediaRecorder chunks, so feed a
          // synthetic chunk to the size counter for accurate status reporting.
          if (sessionRecorder) {
            const bytes = new Blob([img.src], { type: "text/plain" });
            if (sessionChunks && Array.isArray(sessionChunks)) sessionChunks.push({ size: bytes.size });
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      };
      img.onerror = () => sendResponse({ ok: false, error: "bad frame" });
      img.src = message.dataUrl;
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true; // async (img.onload)
  }

  if (message.type === "get-status") {
    const gwConnected = gatewayWs !== null && gatewayWs !== undefined && gatewayWs.readyState === WebSocket.OPEN;
    const localConnected = ws !== null && ws !== undefined && ws.readyState === WebSocket.OPEN;
    const connected = mode === "gateway" ? gwConnected : localConnected;
    const status = {
      connected,
      mode,
      extensionId,
      deviceId,
      wsState: mode === "gateway" ? (gatewayWs ? gatewayWs.readyState : "no-gw-ws") : ws ? ws.readyState : "no-ws",
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
        if (blob.size > cap)
          throw new Error("File too large for inline read (" + blob.size + " bytes, max " + cap + ")");
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
