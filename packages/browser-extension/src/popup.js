/**
 * Popup Script - minimal black/white UI.
 *
 * Two fields configure the connection:
 *   ID    - device ID for the code-mcp-gateway registration (wss://code-mcp.tuanm.workers.dev/ws/<id>)
 *   Token - shared secret the gateway sends with each request; the extension
 *           verifies it before answering (defense in depth).
 *
 * Entering an ID makes the extension the MCP server: it connects to the gateway
 * directly and answers MCP requests in place - no local server required.
 */

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const deviceIdInput = document.getElementById("deviceId");
const tokenInput = document.getElementById("authToken");
const connectBtn = document.getElementById("connectBtn");

// Show the build version (git hash injected as version_name at zip time).
const manifest = chrome.runtime.getManifest();
const versionTag = document.getElementById("versionTag");
if (versionTag) versionTag.textContent = manifest.version_name || manifest.version;

/** Mask a token: never reveal more than ~50% of chars. */
function maskToken(token) {
  if (!token) return "";
  if (token.length <= 5) return "***";
  if (token.length <= 8) return token.slice(0, 1) + "***" + token.slice(-1);
  if (token.length <= 12) return token.slice(0, 2) + "***" + token.slice(-2);
  return token.slice(0, 3) + "***" + token.slice(-3);
}

// Track whether the token input is showing a masked value
let tokenMasked = false;
let realToken = "";

tokenInput.addEventListener("focus", () => {
  if (tokenMasked) {
    tokenInput.value = "";
    tokenInput.type = "password";
    tokenMasked = false;
    tokenInput.dataset.wasCleared = "1";
  }
});

tokenInput.addEventListener("blur", () => {
  if (tokenInput.dataset.wasCleared === "1" && !tokenInput.value.trim()) {
    if (realToken) {
      tokenInput.type = "text";
      tokenInput.value = maskToken(realToken);
      tokenMasked = true;
    }
  }
  delete tokenInput.dataset.wasCleared;
});

// Load saved config
chrome.storage.local.get(["deviceId", "authToken"]).then((config) => {
  deviceIdInput.value = config.deviceId || "";
  if (config.authToken) {
    realToken = config.authToken;
    tokenInput.type = "text";
    tokenInput.value = maskToken(config.authToken);
    tokenMasked = true;
  }
});

// Check connection status
function checkStatus() {
  chrome.runtime.sendMessage({ type: "get-status" }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus(false, "Disconnected (no response - retrying)");
      return;
    }
    setStatus(
      response?.connected || false,
      response?.lastError ? "Disconnected: " + response.lastError : "",
      response?.mode,
    );
  });
}

checkStatus();

// Connect / Disconnect
connectBtn.addEventListener("click", () => {
  if (connectBtn.dataset.connected === "true") {
    statusText.textContent = "Disconnecting...";
    connectBtn.disabled = true;
    chrome.runtime.sendMessage({ type: "disconnect" }, () => {
      connectBtn.disabled = false;
      setTimeout(checkStatus, 500);
    });
    return;
  }

  const deviceId = deviceIdInput.value.trim();
  const token = tokenMasked ? realToken : tokenInput.value.trim();
  if (!deviceId) {
    statusText.textContent = "Enter a device ID";
    return;
  }

  statusText.textContent = "Connecting...";
  connectBtn.disabled = true;

  // Persist so the extension reconnects with the same identity.
  const data = { deviceId };
  if (token) data.authToken = token;
  else delete data.authToken;
  chrome.storage.local.set(data).then(() => {
    if (!token) chrome.storage.local.remove("authToken");
  });

  chrome.runtime.sendMessage({ type: "reconnect", deviceId, token: token || undefined }, (response) => {
    connectBtn.disabled = false;
  });

  if (token) {
    realToken = token;
    setTimeout(() => {
      tokenInput.type = "text";
      tokenInput.value = maskToken(token);
      tokenMasked = true;
    }, 300);
  }

  setTimeout(checkStatus, 2000);
  setTimeout(() => {
    checkStatus();
    // If still disconnected, guide the user toward the likely cause.
    if (connectBtn.dataset.connected !== "true") {
      statusText.textContent = "Disconnected - check your Device ID/Token and try again.";
    }
  }, 5000);
});

// Listen for status updates from offscreen
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "connection-status") {
    setStatus(message.connected, message.connected ? "" : "Disconnected");
  }
});

function setStatus(connected, detail, mode) {
  dot.className = connected ? "dot on" : "dot off";
  statusText.textContent = connected
    ? mode === "gateway"
      ? "Connected (gateway)"
      : "Connected"
    : detail || "Disconnected";
  connectBtn.textContent = connected ? "Disconnect" : "Connect";
  connectBtn.classList.toggle("off", connected);
  connectBtn.dataset.connected = connected ? "true" : "false";
  // MCP mark: green when connected, black when disconnected
  const headerIcon = document.getElementById("headerIcon");
  if (headerIcon) {
    headerIcon.src = connected ? "../icons/connected-128.png" : "../icons/app-icon-128.png";
  }
}

// ---- Record this tab (picker-free tab recording launcher) ----
// Clicking the toolbar icon invokes the extension on the current tab, which is
// what chrome.tabCapture requires (activeTab-like rule). This button performs
// that invocation and starts recording right away, so the agent can then use
// record action=stop via MCP with no picker and no Save dialog.
const recordBtn = document.getElementById("recordBtn");

function setRecordBtn(enabled) {
  if (!recordBtn) return;
  recordBtn.disabled = !enabled;
  recordBtn.textContent = enabled ? "Record this tab" : "Connect first";
}

function updateRecordBtn(connected) {
  if (!recordBtn) return;
  if (!connected) {
    recordBtn.disabled = true;
    recordBtn.textContent = "Connect first";
    return;
  }
  // Ask the SW whether a recording is already running.
  chrome.runtime.sendMessage({ type: "record-status" }, (resp) => {
    const recording = resp && resp.recording;
    recordBtn.disabled = false;
    recordBtn.textContent = recording ? "Stop recording (save)" : "Record this tab";
    recordBtn.dataset.recording = recording ? "1" : "0";
  });
}

recordBtn.addEventListener("click", async () => {
  if (recordBtn.disabled) return;
  const isRecording = recordBtn.dataset.recording === "1";
  recordBtn.disabled = true;
  try {
    if (isRecording) {
      const resp = await chrome.runtime.sendMessage({ type: "record-stop" });
      if (resp && resp.ok) {
        recordBtn.textContent = "Record this tab";
        recordBtn.dataset.recording = "0";
        setStatus(true, resp.saved_to && resp.saved_to.includes("device") ? "Saved to Downloads" : "Recording saved");
      } else {
        setStatus(true, "Save failed: " + ((resp && resp.error) || "unknown"));
      }
    } else {
      const resp = await chrome.runtime.sendMessage({ type: "record-start" });
      if (resp && resp.ok) {
        recordBtn.textContent = "Stop recording (save)";
        recordBtn.dataset.recording = "1";
        setStatus(true, "Recording tab");
      } else {
        setStatus(true, "Start failed: " + ((resp && resp.error) || "unknown"));
      }
    }
  } finally {
    recordBtn.disabled = false;
  }
  window.close();
});

// Hook into existing connect/disconnect flow: after setStatus, update the button.
const origSetStatus = setStatus;
setStatus = function (connected, detail, mode) {
  origSetStatus(connected, detail, mode);
  updateRecordBtn(connected);
};
