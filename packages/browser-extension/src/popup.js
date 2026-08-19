/**
 * Popup Script - minimal black/white UI.
 *
 * Two fields configure the connection:
 *   ID    - device ID used for the code-mcp-gateway registration (wss://code-mcp.tuanm.dev/ws/<id>)
 *   Token - shared secret the gateway uses to authenticate to this server (/mcp ?token=)
 *
 * The extension always connects to the LOCAL server (ws://localhost:7777/browser/ws);
 * the server uses the ID + Token to link up with the gateway. See code-mcp for the
 * gateway protocol (register / keepalive / watchdog).
 */

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const deviceIdInput = document.getElementById("deviceId");
const tokenInput = document.getElementById("authToken");
const connectBtn = document.getElementById("connectBtn");

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
    setStatus(response?.connected || false, response?.lastError ? "Disconnected: " + response.lastError : "");
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

  // Persist; the local server uses these for the gateway link
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
    // If still disconnected, point the user at the missing local server.
    if (connectBtn.dataset.connected !== "true") {
      statusText.textContent = "Disconnected - is the local server running? Start it with: bun browser-mcp.ts (ws://localhost:7777)";
    }
  }, 5000);
});

// Listen for status updates from offscreen
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "connection-status") {
    setStatus(message.connected, message.connected ? "" : "Disconnected");
  }
});

function setStatus(connected, detail) {
  dot.className = connected ? "dot on" : "dot off";
  statusText.textContent = connected ? "Connected" : (detail || "Disconnected");
  connectBtn.textContent = connected ? "Disconnect" : "Connect";
  connectBtn.classList.toggle("off", connected);
  connectBtn.dataset.connected = connected ? "true" : "false";
  // MCP mark: green when connected, black when disconnected
  const headerIcon = document.getElementById("headerIcon");
  if (headerIcon) {
    headerIcon.src = connected ? "../icons/connected-128.png" : "../icons/app-icon-128.png";
  }
}
