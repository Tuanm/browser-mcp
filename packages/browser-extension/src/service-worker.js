/**
 * Browser MCP Extension — Service Worker (MV3)
 *
 * Handles commands from the Browser MCP server (via offscreen document WebSocket)
 * and dispatches them to browser APIs (tabs, debugger, scripting).
 */

// ============================================================================
// State
// ============================================================================

let offscreenReady = false;
const debuggerAttached = new Set(); // Set of tabIds with debugger attached
const debuggerPending = new Map(); // tabId -> Promise (serializes attachment)
const cdpDomainEnabled = new Map(); // tabId -> Set<domainName> — tracks which CDP domains are enabled per tab

// Session-random prefix for DOM identifiers injected by content script.
// Prevents anti-bot fingerprinting via known identifier patterns like "__bmcp-*".
const SESSION_PREFIX = "_x" + Math.random().toString(36).slice(2, 8);

// Toolbar icon reflects connection state: gray (disconnected) or green (connected).
const ICON_DISCONNECTED = {
  "16": "icons/app-icon-16.png",
  "48": "icons/app-icon-48.png",
  "128": "icons/app-icon-128.png",
};
const ICON_CONNECTED = {
  "16": "icons/connected-16.png",
  "48": "icons/connected-48.png",
  "128": "icons/connected-128.png",
};

async function setActionIcon(connected) {
  try {
    await chrome.action.setIcon({ path: connected ? ICON_CONNECTED : ICON_DISCONNECTED });
  } catch {}
} // "__bmcp-*" style prefix
const activeTabCommands = new Map(); // tabId -> active command count (for glow indicator)
const frameContexts = new Map(); // `${tabId}:${frameId}` -> executionContextId
const tabEmulation = new Map(); // tabId -> {metrics, hasTouch, userAgent} for screenshot restore
const pendingAuth = new Map(); // requestId -> { tabId, url, scheme, realm }
const pendingAuthByTab = new Map(); // tabId -> Set<requestId>  (for status lookup)
const recentDownloads = []; // Recent download events (from CDP Browser.downloadWillBegin), max 20
const cdpCompletedUrls = new Map(); // url -> timestamp — CDP-confirmed download completions (separate from recentDownloads to survive consumeRecentDownload splice)

// Clean up debugger state on detach (registered once at module scope)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    debuggerAttached.delete(source.tabId);
    cdpDomainEnabled.delete(source.tabId);
    pendingDialogs.delete(source.tabId);
    pendingFileChoosers.delete(source.tabId);
    tabEmulation.delete(source.tabId);
    // Clean up auth state for detached tab
    const reqIds = pendingAuthByTab.get(source.tabId);
    if (reqIds) {
      for (const rid of reqIds) pendingAuth.delete(rid);
      pendingAuthByTab.delete(source.tabId);
    }
    // Invalidate stale frame contexts
    for (const key of frameContexts.keys()) {
      if (key.startsWith(`${source.tabId}:`)) frameContexts.delete(key);
    }
    // Clear capture buffers for detached tab
    consoleLogs.delete(source.tabId);
    pageErrors.delete(source.tabId);
    networkLogs.delete(source.tabId);
    inFlightRequests.delete(source.tabId);
  }
});

// ============================================================================
// Offscreen Document Management
// ============================================================================

async function ensureOffscreen() {
  // Always verify — offscreen doc can crash under memory pressure
  const existing = await chrome.offscreen.hasDocument();
  if (existing) {
    offscreenReady = true;
    return;
  }
  offscreenReady = false;
  await chrome.offscreen.createDocument({
    url: "src/offscreen.html",
    reasons: ["WORKERS"],
    justification: "WebSocket connection to local Browser MCP server",
  });
  // Send saved config to offscreen (it can't access chrome.storage)
  try {
    const config = await chrome.storage.local.get(["serverUrl", "extensionId", "authToken"]);
    if (config.serverUrl || config.extensionId) {
      setTimeout(() => {
        chrome.runtime
          .sendMessage({
            type: "reconnect",
            url: config.serverUrl,
            extensionId: config.extensionId,
            token: config.authToken || undefined,
          })
          .catch(() => {});
      }, 200);
    }
  } catch {}
  offscreenReady = true;
}

// ============================================================================
// Keep-Alive (MV3 service workers idle-timeout after 30s)
// ============================================================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "keepalive") {
    // Offscreen doc pings us to prevent idle shutdown
    // Don't clear offscreenReady on planned disconnect cycles
  }
});

// ============================================================================
// Message Router — commands from offscreen (WebSocket) or content scripts
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ensure offscreen exists on every non-offscreen message (handles SW restarts)
  if (!message.source || message.source !== "offscreen") {
    ensureOffscreen().catch(() => {});
  }

  // Commands from offscreen (WebSocket relay)
  if (message.source === "offscreen" && message.type === "command") {
    handleCommand(message.id, message.method, message.params)
      .then((result) => sendResponse({ id: message.id, result }))
      .catch((err) => sendResponse({ id: message.id, error: { message: err.message } }));
    return true; // async response
  }

  // Connection status broadcast from offscreen — flip toolbar icon + let popup hear it
  if (message.source === "offscreen" && message.type === "connection-status") {
    setActionIcon(!!message.connected);
    return false;
  }

  // Messages from popup meant for offscreen — don't intercept, let offscreen handle
  if (
    message.type === "get-status" ||
    message.type === "set-server-url" ||
    message.type === "reconnect" ||
    message.type === "disconnect"
  ) {
    // Don't call sendResponse — offscreen document handles these
    return false;
  }

  if (message.source === "content-script" && message.type === "dom-result") {
    sendResponse({ received: true });
  }

  return false;
});

// ============================================================================
// Command Handlers
// ============================================================================

async function handleCommand(id, method, params) {
  // Show glow indicator on target tab
  let indicatorTab = params?.tabId || null;
  if (!indicatorTab) {
    try {
      indicatorTab = await getActiveTabId();
    } catch {}
  }
  if (indicatorTab) await showAgentIndicator(indicatorTab);
  // Show persistent Browser MCP icon during long-running download/upload operations
  const showActivity = method === "download" || method === "file_upload";
  if (showActivity && indicatorTab) showActivityCursor(indicatorTab);
  try {
    return await dispatchCommand(method, params);
  } finally {
    if (showActivity && indicatorTab) hideActivityCursor(indicatorTab);
    if (indicatorTab) hideAgentIndicator(indicatorTab);
  }
}

async function dispatchCommand(method, params) {
  // Stealth mode: use chrome.scripting instead of CDP to avoid bot detection
  if (params?.stealth) return dispatchStealthCommand(method, params);
  switch (method) {
    case "navigate":
      return handleNavigate(params);
    case "screenshot":
      return handleScreenshot(params);
    case "click":
      return handleClick(params);
    case "type":
      return handleType(params);
    case "extract":
      return handleExtract(params);
    case "tabs":
      return handleTabs(params);
    case "execute":
      return handleExecute(params);
    case "scroll":
      return handleScroll(params);
    case "hover":
      return handleHover(params);
    case "mouse_move":
      return handleMouseMove(params);
    case "drag":
      return handleDrag(params);
    case "keypress":
      return handleKeypress(params);
    case "wait_for":
      return handleWaitFor(params);
    case "select":
      return handleSelect(params);
    case "dialog":
      return handleDialog(params);
    case "history":
      return handleHistory(params);
    case "file_upload":
      return handleFileUpload(params);
    case "frames":
      return handleFrames(params);
    case "touch":
      return handleTouch(params);
    case "emulate":
      return handleEmulate(params);
    case "download":
      return handleDownload(params);
    case "auth":
      return handleAuth(params);
    case "permissions":
      return handlePermissions(params);
    case "store":
      return handleStore(params);
    case "cookies":
      return handleCookies(params);
    case "snapshot":
      return handleSnapshot(params);
    case "find":
      return handleFind(params);
    case "get_element":
      return handleGetElement(params);
    case "is_element":
      return handleIsElement(params);
    case "fill":
      return handleFill(params);
    case "check":
      return handleCheck(params);
    case "uncheck":
      return handleUncheck(params);
    case "focus":
      return handleFocus(params);
    case "dblclick":
      return handleDblClick(params);
    case "reload":
      return handleReload(params);
    case "back":
      return handleBack(params);
    case "forward":
      return handleForward(params);
    case "close":
      return handleCloseTab(params);
    case "storage":
      return handleStorage(params);
    case "pdf":
      return handlePdf(params);
    case "set":
      return handleSet(params);
    case "highlight":
      return handleHighlight(params);
    case "window":
      return handleWindow(params);
    case "console":
      return handleConsole(params);
    case "errors":
      return handleErrors(params);
    case "network":
      return handleNetwork(params);
    case "wait":
      return handleWait(params);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// --- Navigate ---

async function handleNavigate({ url, tabId, waitFor }) {
  let tab;
  if (tabId) {
    tab = await chrome.tabs.update(tabId, { url });
  } else {
    tab = await chrome.tabs.create({ url });
  }

  // Wait for page load
  const preNavTs = Date.now();
  await waitForTab(tab.id, waitFor || "load");
  tab = await chrome.tabs.get(tab.id);

  const result = { tabId: tab.id, url: tab.url, title: tab.title };
  // Check if navigation triggered a file download (use preNavTs to cover the entire wait window)
  const dl = consumeRecentDownload(tab.id, Date.now() - preNavTs + 2000);
  if (dl)
    result.download_triggered = {
      url: dl.url,
      filename: dl.suggestedFilename,
      hint: "A file download was triggered. Use browser_download action=wait to capture it.",
    };
  return result;
}

// --- Screenshot ---

async function handleScreenshot({ tabId, selector, fullPage }) {
  const tid = tabId || (await getActiveTabId());

  if (selector || fullPage || tabId) {
    // Use chrome.debugger for element/full-page/tab-specific screenshots
    await ensureDebugger(tid);

    if (fullPage) {
      // Get full page metrics
      const metrics = await sendDebuggerCommand(tid, "Page.getLayoutMetrics");
      const { width, height } = metrics.contentSize;

      // Set device metrics to full page size
      await sendDebuggerCommand(tid, "Emulation.setDeviceMetricsOverride", {
        width: Math.ceil(width),
        height: Math.ceil(height),
        deviceScaleFactor: 1,
        mobile: false,
      });

      try {
        const result = await sendDebuggerCommand(tid, "Page.captureScreenshot", {
          format: "jpeg",
          quality: 60,
        });

        return {
          tabId: tid,
          dataUrl: `data:image/jpeg;base64,${result.data}`,
          width: Math.ceil(width),
          height: Math.ceil(height),
        };
      } finally {
        // Restore active emulation for this specific tab, otherwise clear
        const emu = tabEmulation.get(tid);
        if (emu?.metrics) {
          await sendDebuggerCommand(tid, "Emulation.setDeviceMetricsOverride", emu.metrics).catch(() => {});
          if (emu.hasTouch !== undefined) {
            await sendDebuggerCommand(tid, "Emulation.setTouchEmulationEnabled", {
              enabled: emu.hasTouch,
            }).catch(() => {});
          }
          if (emu.userAgent) {
            await sendDebuggerCommand(tid, "Emulation.setUserAgentOverride", {
              userAgent: emu.userAgent,
            }).catch(() => {});
          }
        } else {
          await sendDebuggerCommand(tid, "Emulation.clearDeviceMetricsOverride").catch(() => {});
        }
      }
    }

    if (selector) {
      // Get element bounding box via CDP
      const doc = await sendDebuggerCommand(tid, "DOM.getDocument");
      const node = await sendDebuggerCommand(tid, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      });
      if (!node.nodeId) throw new Error(`Element not found: ${selector}`);

      const box = await sendDebuggerCommand(tid, "DOM.getBoxModel", { nodeId: node.nodeId });
      const quad = box.model.border;
      const clip = {
        x: quad[0],
        y: quad[1],
        width: quad[2] - quad[0],
        height: quad[5] - quad[1],
        scale: 1,
      };

      const result = await sendDebuggerCommand(tid, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 60,
        clip,
      });

      return {
        tabId: tid,
        dataUrl: `data:image/jpeg;base64,${result.data}`,
        width: Math.ceil(clip.width),
        height: Math.ceil(clip.height),
      };
    }

    // Tab-specific viewport screenshot via CDP (not captureVisibleTab which ignores tabId)
    const result = await sendDebuggerCommand(tid, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 60,
    });
    return { tabId: tid, dataUrl: `data:image/jpeg;base64,${result.data}`, width: null, height: null };
  }

  // Simple viewport screenshot of active visible tab via tabs API
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 60 });
  return { tabId: tid, dataUrl, width: null, height: null };
}

// --- Click ---

async function handleClick({ selector, x, y, tabId, button, clickCount: count, pierce, intercept_file_chooser }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  let clickX = x;
  let clickY = y;

  if (selector) {
    const coords = pierce ? await resolveElementCoords(tid, selector) : await getElementCenter(tid, selector);
    clickX = coords.x;
    clickY = coords.y;
  } else if (clickX === undefined || clickY === undefined) {
    throw new Error("Click requires either 'selector' or both 'x' and 'y' coordinates");
  }

  // Enable file chooser interception on-demand (only when agent expects an upload dialog)
  if (intercept_file_chooser) {
    pendingFileChoosers.delete(tid); // clear any stale entry
    await sendDebuggerCommand(tid, "Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
  }

  try {
    const buttonMap = { left: "left", right: "right", middle: "middle" };
    const btn = buttonMap[button] || "left";
    const clickCount = count || 1;

    for (let i = 0; i < clickCount; i++) {
      await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: clickX,
        y: clickY,
        button: btn,
        clickCount: i + 1,
      });
      await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: clickX,
        y: clickY,
        button: btn,
        clickCount: i + 1,
      });
    }

    showActionCursor(tid, clickX, clickY);
    // Brief delay to let download/file-chooser events propagate from CDP
    await new Promise((r) => setTimeout(r, 300));
    const dl = consumeRecentDownload(tid);
    const result = { tabId: tid, element: selector || `(${clickX},${clickY})` };
    if (dl)
      result.download_triggered = {
        url: dl.url,
        filename: dl.suggestedFilename,
        hint: "A file download was triggered. Use browser_download action=wait to capture it.",
      };
    // Check if a file chooser dialog was intercepted (only possible when intercept_file_chooser was set)
    if (intercept_file_chooser && pendingFileChoosers.has(tid)) {
      const fc = pendingFileChoosers.get(tid);
      result.file_chooser_opened = {
        mode: fc.mode,
        hint: "A file chooser dialog was intercepted. Use browser_upload_file with file_id to provide the file. No selector needed.",
      };
    } else if (intercept_file_chooser) {
      // No file chooser was triggered — disable interception to avoid interfering with future dialogs
      await sendDebuggerCommand(tid, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
    return result;
  } catch (err) {
    // Clean up interception state on error to prevent leaking
    if (intercept_file_chooser) {
      pendingFileChoosers.delete(tid);
      await sendDebuggerCommand(tid, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
    throw err;
  }
}

// --- Type ---

async function handleType({ text, selector, tabId, clearFirst, pressEnter, pierce }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  let actionCoords = null;
  if (selector) {
    // Focus the element first
    const coords = pierce ? await resolveElementCoords(tid, selector) : await getElementCenter(tid, selector);
    actionCoords = coords;
    await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: coords.x,
      y: coords.y,
      button: "left",
      clickCount: 1,
    });
    await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: coords.x,
      y: coords.y,
      button: "left",
      clickCount: 1,
    });
  }

  if (clearFirst) {
    // Select all + delete
    await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: 2, // Ctrl
    });
    await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
    });
    await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
    });
    await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
    });
  }

  // Type text using CDP insertText (handles React/SPA events correctly)
  await sendDebuggerCommand(tid, "Input.insertText", { text });

  if (pressEnter) {
    await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
    });
    await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
    });
  }

  if (actionCoords) showActionCursor(tid, actionCoords.x, actionCoords.y);
  return { tabId: tid, element: selector || "(focused)" };
}

// --- Extract ---

async function handleExtract({ mode, selector, tabId, frameId }) {
  const tid = tabId || (await getActiveTabId());

  if (mode === "accessibility") {
    await ensureDebugger(tid);
    const result = await sendDebuggerCommand(tid, "Accessibility.getFullAXTree");
    // Filter meaningful nodes first, then truncate
    const nodes = [];
    for (const n of result.nodes || []) {
      const name = n.name?.value;
      const value = n.value?.value;
      if (name || value) {
        nodes.push({ role: n.role?.value, name, value });
        if (nodes.length >= 500) break;
      }
    }
    return { data: nodes };
  }

  // Use content script for DOM extraction
  const target = { tabId: tid };
  if (frameId) target.frameIds = [frameId];
  const results = await chrome.scripting.executeScript({
    target,
    func: extractFromPage,
    args: [mode || "text", selector || null],
  });

  return { data: results[0]?.result || "" };
}

// Content script function injected for extraction
function extractFromPage(mode, selector) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return `Element not found: ${selector}`;

  switch (mode) {
    case "text":
      return root.innerText?.slice(0, 50000) || "";
    case "links":
      return Array.from(root.querySelectorAll("a[href]"))
        .map((a) => ({
          text: a.textContent?.trim().slice(0, 100),
          href: a.href,
        }))
        .slice(0, 200);
    case "forms":
      return Array.from(root.querySelectorAll("input,textarea,select"))
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || "",
          name: el.name || "",
          id: el.id || "",
          value: el.value?.slice(0, 200) || "",
          placeholder: el.placeholder || "",
        }))
        .slice(0, 100);
    case "tables":
      return Array.from(root.querySelectorAll("table"))
        .map((table) => {
          const rows = Array.from(table.querySelectorAll("tr")).slice(0, 50);
          return rows.map((row) =>
            Array.from(row.querySelectorAll("td,th")).map((cell) => cell.textContent?.trim().slice(0, 200)),
          );
        })
        .slice(0, 10);
    case "html":
      return root.outerHTML?.slice(0, 50000) || "";
    default:
      return root.innerText?.slice(0, 50000) || "";
  }
}

// --- Tabs ---

async function handleTabs({ action, tabId }) {
  if (action === "close") {
    if (!tabId) throw new Error("tabId is required for close action");
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  }
  if (action === "activate") {
    if (!tabId) throw new Error("tabId is required for activate action");
    await chrome.tabs.update(tabId, { active: true });
    const tab = await chrome.tabs.get(tabId);
    return { activated: tabId, title: tab.title, url: tab.url };
  }
  // List
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      windowId: t.windowId,
    })),
  };
}

// --- Execute JS ---

async function handleExecute({ code, tabId, frameId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);
  // Runtime.evaluate requires Runtime domain enabled
  await ensureCdpDomain(tid, "Runtime");

  // Determine execution context for frame targeting
  const evalParams = {
    expression: code,
    returnByValue: true,
    awaitPromise: true,
    timeout: 30000,
  };
  if (frameId) {
    const contextId = frameContexts.get(`${tid}:${frameId}`);
    if (!contextId) throw new Error(`No execution context for frame ${frameId}. Call browser_frames first.`);
    evalParams.contextId = contextId;
  }

  // Use CDP Runtime.evaluate — MV3 blocks new Function()/eval in service workers
  const result = await sendDebuggerCommand(tid, "Runtime.evaluate", evalParams);
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Script execution failed",
    );
  }
  return { value: result.result?.value };
}

// --- Scroll ---

async function handleScroll({ x, y, selector, direction, amount, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  // Default to viewport center if no position specified
  let scrollX = x ?? 0;
  let scrollY = y ?? 0;
  if (!selector && x === undefined && y === undefined) {
    // Get viewport size for centering
    const layout = await sendDebuggerCommand(tid, "Page.getLayoutMetrics").catch(() => null);
    if (layout?.cssVisualViewport) {
      scrollX = Math.round(layout.cssVisualViewport.clientWidth / 2);
      scrollY = Math.round(layout.cssVisualViewport.clientHeight / 2);
    }
  }

  if (selector) {
    const coords = await getElementCenter(tid, selector);
    scrollX = coords.x;
    scrollY = coords.y;
  }

  // Calculate delta from direction/amount
  const dist = amount || 300;
  let deltaX = 0;
  let deltaY = 0;
  switch (direction) {
    case "up":
      deltaY = -dist;
      break;
    case "down":
      deltaY = dist;
      break;
    case "left":
      deltaX = -dist;
      break;
    case "right":
      deltaX = dist;
      break;
    default:
      deltaY = dist; // default scroll down
  }

  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: scrollX,
    y: scrollY,
    deltaX,
    deltaY,
  });

  showActionCursor(tid, scrollX, scrollY);

  // Wait for scroll to settle (mouseWheel resolves before DOM updates)
  await new Promise((r) => setTimeout(r, 150));

  return { tabId: tid, direction: direction || "down", amount: dist };
}

// --- Hover ---

async function handleHover({ selector, x, y, tabId, pierce }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  let hoverX = x;
  let hoverY = y;

  if (selector) {
    const coords = pierce ? await resolveElementCoords(tid, selector) : await getElementCenter(tid, selector);
    hoverX = coords.x;
    hoverY = coords.y;
  } else if (hoverX === undefined || hoverY === undefined) {
    throw new Error("Hover requires either 'selector' or both 'x' and 'y' coordinates");
  }

  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: hoverX,
    y: hoverY,
  });

  showActionCursor(tid, hoverX, hoverY);
  return { tabId: tid, element: selector || `(${hoverX},${hoverY})` };
}

// --- Mouse Move ---

async function handleMouseMove({ x, y, tabId, steps }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  if (x === undefined || y === undefined) {
    throw new Error("mouse_move requires both 'x' and 'y' coordinates");
  }

  const numSteps = Math.max(1, steps || 1);
  // CDP doesn't track cursor position, so multi-step interpolation
  // uses small offsets approaching the target to generate mousemove events
  for (let i = 1; i <= numSteps; i++) {
    const ratio = i / numSteps;
    await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      // For single step, jump directly to target
      // For multi-step, approach from slight offset to generate events
      x: numSteps === 1 ? x : Math.round(x + (1 - ratio) * -20),
      y: numSteps === 1 ? y : Math.round(y + (1 - ratio) * -10),
    });
    if (numSteps > 1 && i < numSteps) await new Promise((r) => setTimeout(r, 10));
  }

  // Final position is always exact target
  if (numSteps > 1) {
    await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
  }

  showActionCursor(tid, x, y);
  return { tabId: tid, position: { x, y }, steps: numSteps };
}

// --- Drag ---

async function handleDrag({ fromSelector, fromX, fromY, toSelector, toX, toY, tabId, steps }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  let startX = fromX;
  let startY = fromY;
  let endX = toX;
  let endY = toY;

  if (fromSelector) {
    const coords = await getElementCenter(tid, fromSelector);
    startX = coords.x;
    startY = coords.y;
  }
  if (toSelector) {
    const coords = await getElementCenter(tid, toSelector);
    endX = coords.x;
    endY = coords.y;
  }

  if (startX === undefined || startY === undefined || endX === undefined || endY === undefined) {
    throw new Error("Drag requires from/to coordinates or selectors");
  }

  const numSteps = steps || 10;

  // Press at start
  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: startX,
    y: startY,
    button: "left",
    clickCount: 1,
  });

  // Move in steps
  for (let i = 1; i <= numSteps; i++) {
    const ratio = i / numSteps;
    await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: startX + (endX - startX) * ratio,
      y: startY + (endY - startY) * ratio,
      button: "left",
    });
  }

  showActionCursor(tid, startX, startY);
  // Release at end
  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: endX,
    y: endY,
    button: "left",
    clickCount: 1,
  });

  showActionCursor(tid, endX, endY);
  return { tabId: tid, from: fromSelector || `(${startX},${startY})`, to: toSelector || `(${endX},${endY})` };
}

// --- Keypress ---

async function handleKeypress({ key, modifiers, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  const modifierFlags =
    (modifiers?.includes("alt") ? 1 : 0) |
    (modifiers?.includes("ctrl") ? 2 : 0) |
    (modifiers?.includes("meta") ? 4 : 0) |
    (modifiers?.includes("shift") ? 8 : 0);

  // Map common key names to CDP key/code
  const keyMap = {
    enter: { key: "Enter", code: "Enter" },
    tab: { key: "Tab", code: "Tab" },
    escape: { key: "Escape", code: "Escape" },
    backspace: { key: "Backspace", code: "Backspace" },
    delete: { key: "Delete", code: "Delete" },
    arrowup: { key: "ArrowUp", code: "ArrowUp" },
    arrowdown: { key: "ArrowDown", code: "ArrowDown" },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft" },
    arrowright: { key: "ArrowRight", code: "ArrowRight" },
    home: { key: "Home", code: "Home" },
    end: { key: "End", code: "End" },
    pageup: { key: "PageUp", code: "PageUp" },
    pagedown: { key: "PageDown", code: "PageDown" },
    space: { key: " ", code: "Space" },
    // Digits
    0: { key: "0", code: "Digit0" },
    1: { key: "1", code: "Digit1" },
    2: { key: "2", code: "Digit2" },
    3: { key: "3", code: "Digit3" },
    4: { key: "4", code: "Digit4" },
    5: { key: "5", code: "Digit5" },
    6: { key: "6", code: "Digit6" },
    7: { key: "7", code: "Digit7" },
    8: { key: "8", code: "Digit8" },
    9: { key: "9", code: "Digit9" },
    // Special characters
    "-": { key: "-", code: "Minus" },
    "=": { key: "=", code: "Equal" },
    "[": { key: "[", code: "BracketLeft" },
    "]": { key: "]", code: "BracketRight" },
    "\\": { key: "\\", code: "Backslash" },
    ";": { key: ";", code: "Semicolon" },
    "'": { key: "'", code: "Quote" },
    "`": { key: "`", code: "Backquote" },
    ",": { key: ",", code: "Comma" },
    ".": { key: ".", code: "Period" },
    "/": { key: "/", code: "Slash" },
    // Function keys
    f1: { key: "F1", code: "F1" },
    f2: { key: "F2", code: "F2" },
    f3: { key: "F3", code: "F3" },
    f4: { key: "F4", code: "F4" },
    f5: { key: "F5", code: "F5" },
    f6: { key: "F6", code: "F6" },
    f7: { key: "F7", code: "F7" },
    f8: { key: "F8", code: "F8" },
    f9: { key: "F9", code: "F9" },
    f10: { key: "F10", code: "F10" },
    f11: { key: "F11", code: "F11" },
    f12: { key: "F12", code: "F12" },
  };

  // For single letters, use KeyA-KeyZ; for unmapped, use key as code
  function resolveKey(k) {
    const lower = k.toLowerCase();
    if (keyMap[lower]) return keyMap[lower];
    if (/^[a-z]$/i.test(k)) return { key: k, code: `Key${k.toUpperCase()}` };
    return { key: k, code: k };
  }

  const mapped = resolveKey(key);

  await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: mapped.key,
    code: mapped.code,
    modifiers: modifierFlags,
  });
  await sendDebuggerCommand(tid, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: mapped.key,
    code: mapped.code,
    modifiers: modifierFlags,
  });

  return {
    tabId: tid,
    key: mapped.key,
    modifiers: modifiers || [],
  };
}

// --- Wait For Element ---

async function handleWaitFor({ selector, tabId, timeout, visible, pierce }) {
  const tid = tabId || (await getActiveTabId());
  const maxWait = Math.min(timeout || 5000, 30000);
  const interval = 200;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: (sel, checkVisible, doPierce) => {
          function query(s) {
            let el = document.querySelector(s);
            if (el || !doPierce) return el;
            // Search shadow DOMs
            function searchShadow(root) {
              for (const node of root.querySelectorAll("*")) {
                if (node.shadowRoot) {
                  const found = node.shadowRoot.querySelector(s);
                  if (found) return found;
                  const deep = searchShadow(node.shadowRoot);
                  if (deep) return deep;
                }
              }
              return null;
            }
            el = searchShadow(document);
            if (el) return el;
            // Search same-origin iframes
            for (const iframe of document.querySelectorAll("iframe")) {
              try {
                if (iframe.contentDocument) {
                  const found = iframe.contentDocument.querySelector(s);
                  if (found) return found;
                }
              } catch {}
            }
            return null;
          }
          const el = query(sel);
          if (!el) return null;
          if (checkVisible) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return null;
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return null;
          }
          return { tag: el.tagName.toLowerCase(), text: (el.textContent || "").slice(0, 100) };
        },
        args: [selector, visible !== false, !!pierce],
      });
      if (results[0]?.result) {
        return { found: true, tabId: tid, element: results[0].result, elapsed: Date.now() - start };
      }
    } catch {
      /* page might be navigating */
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`Element "${selector}" not found within ${maxWait}ms`);
}

// --- Select Dropdown ---

async function handleSelect({ selector, value, text, index, tabId }) {
  const tid = tabId || (await getActiveTabId());
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (sel, val, txt, idx) => {
      const el = document.querySelector(sel);
      if (!el) return { error: `Element not found: ${sel}` };
      if (el.tagName.toLowerCase() !== "select") return { error: `Element is not a <select>: ${el.tagName}` };

      let option = null;
      if (val !== null && val !== undefined) {
        option = Array.from(el.options).find((o) => o.value === val);
      } else if (txt !== null && txt !== undefined) {
        option = Array.from(el.options).find((o) => o.text.trim() === txt);
      } else if (idx !== null && idx !== undefined) {
        option = el.options[idx];
      }
      if (!option) return { error: `Option not found (value=${val}, text=${txt}, index=${idx})` };

      const rect = el.getBoundingClientRect();
      el.value = option.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        selected: option.value,
        text: option.text,
        index: option.index,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      };
    },
    args: [selector, value ?? null, text ?? null, index ?? null],
  });
  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  if (result?.x != null && result?.y != null) showActionCursor(tid, result.x, result.y);
  const { x: _x, y: _y, ...rest } = result;
  return { tabId: tid, ...rest };
}

// --- Dialog Handling (alert/confirm/prompt) ---

const pendingDialogs = new Map(); // tabId -> { type, message, defaultPrompt }
const pendingFileChoosers = new Map(); // tabId -> { backendNodeId, mode }

// Listen for JavaScript dialogs and frame execution contexts
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Page.javascriptDialogOpening" && source.tabId) {
    pendingDialogs.set(source.tabId, {
      type: params.type,
      message: params.message,
      defaultPrompt: params.defaultPrompt,
    });
  }
  // Track download events (from Browser.setDownloadBehavior eventsEnabled)
  if (method === "Browser.downloadWillBegin" && source.tabId) {
    recentDownloads.push({
      tabId: source.tabId,
      guid: params.guid,
      url: params.url,
      suggestedFilename: params.suggestedFilename,
      timestamp: Date.now(),
    });
    if (recentDownloads.length > 20) recentDownloads.shift();
  }
  // Track download completion via CDP (more reliable than chrome.downloads for blob: URLs)
  if (method === "Browser.downloadProgress" && params.state === "completed") {
    const rd = recentDownloads.find((d) => d.guid === params.guid);
    if (rd) {
      rd.cdpCompleted = true;
      // Store in separate Map so it survives consumeRecentDownload splice
      cdpCompletedUrls.set(rd.url, Date.now());
      // Auto-expire after 60s to prevent unbounded growth
      setTimeout(() => cdpCompletedUrls.delete(rd.url), 60000);
    }
  }
  // Track file chooser dialogs (intercepted by Page.setInterceptFileChooserDialog)
  if (method === "Page.fileChooserOpened" && source.tabId) {
    pendingFileChoosers.set(source.tabId, {
      backendNodeId: params.backendNodeId,
      mode: params.mode, // "selectSingle" or "selectMultiple"
      frameId: params.frameId,
      timestamp: Date.now(),
    });
  }
  // Track execution contexts for frame targeting
  if (method === "Runtime.executionContextCreated" && source.tabId) {
    const ctx = params.context;
    if (ctx.auxData?.frameId) {
      frameContexts.set(`${source.tabId}:${ctx.auxData.frameId}`, ctx.id);
    }
  }
  if (method === "Runtime.executionContextDestroyed" && source.tabId) {
    for (const [key, ctxId] of frameContexts) {
      if (ctxId === params.executionContextId) {
        frameContexts.delete(key);
        break;
      }
    }
  }
  // Clear all frame contexts on full navigation (Chrome doesn't fire individual destroy events)
  if (method === "Runtime.executionContextsCleared" && source.tabId) {
    const prefix = `${source.tabId}:`;
    for (const key of frameContexts.keys()) {
      if (key.startsWith(prefix)) frameContexts.delete(key);
    }
    // Clear stale file chooser interception on navigation (interception is per-session, survives nav)
    if (pendingFileChoosers.has(source.tabId)) {
      pendingFileChoosers.delete(source.tabId);
      sendDebuggerCommand(source.tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
  }
  // Track HTTP authentication requests (keyed by requestId to avoid blocking other requests)
  if (method === "Fetch.authRequired" && source.tabId) {
    const rid = params.requestId;
    pendingAuth.set(rid, {
      tabId: source.tabId,
      url: params.request?.url,
      scheme: params.authChallenge?.scheme,
      realm: params.authChallenge?.realm,
    });
    if (!pendingAuthByTab.has(source.tabId)) pendingAuthByTab.set(source.tabId, new Set());
    pendingAuthByTab.get(source.tabId).add(rid);
    // Auto-cancel after 60s to prevent indefinite hangs
    setTimeout(() => {
      if (pendingAuth.has(rid)) {
        sendDebuggerCommand(source.tabId, "Fetch.continueWithAuth", {
          requestId: rid,
          authChallengeResponse: { response: "CancelAuth" },
        }).catch(() => {});
        pendingAuth.delete(rid);
        const tabSet = pendingAuthByTab.get(source.tabId);
        if (tabSet) {
          tabSet.delete(rid);
          if (tabSet.size === 0) pendingAuthByTab.delete(source.tabId);
        }
      }
    }, 60000);
  }
  // Auto-continue non-auth paused requests. Skip auth requests (401/407 — will be handled via Fetch.authRequired).
  if (method === "Fetch.requestPaused" && source.tabId) {
    const code = params.responseStatusCode;
    if (code !== 401 && code !== 407) {
      sendDebuggerCommand(source.tabId, "Fetch.continueRequest", {
        requestId: params.requestId,
      }).catch(() => {});
    } else {
      // If Fetch.authRequired doesn't fire within 2s, this is a non-challenge 401/407 (e.g. API response).
      // Continue the request to avoid hanging forever.
      const rid = params.requestId;
      const tabId = source.tabId;
      setTimeout(() => {
        if (!pendingAuth.has(rid)) {
          sendDebuggerCommand(tabId, "Fetch.continueRequest", {
            requestId: rid,
          }).catch(() => {});
        }
      }, 2000);
    }
  }

  // Console / errors / network capture (agent-browser port)
  if (source.tabId) {
    handleCaptureEvent(source.tabId, method, params);
  }
});

async function handleDialog({ action, promptText, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  const dialog = pendingDialogs.get(tid);
  if (!dialog) {
    return { tabId: tid, handled: false, message: "No pending dialog" };
  }

  await sendDebuggerCommand(tid, "Page.handleJavaScriptDialog", {
    accept: action !== "dismiss",
    promptText: promptText || "",
  });

  pendingDialogs.delete(tid);
  return { tabId: tid, handled: true, type: dialog.type, dialogMessage: dialog.message };
}

// --- History (Back/Forward) ---

async function handleHistory({ action, tabId }) {
  const tid = tabId || (await getActiveTabId());
  // Use CDP navigation history: chrome.tabs.goBack/goForward can report an empty
  // history even when entries exist (Chromium quirk), so drive the controller directly.
  await ensureDebugger(tid);
  const hist = await sendDebuggerCommand(tid, "Page.getNavigationHistory");
  const entries = hist.entries || [];
  const current = hist.currentIndex;
  if (action === "back") {
    if (current <= 0 || entries.length < 2) throw new Error("Cannot go back: no previous page in history");
    await sendDebuggerCommand(tid, "Page.navigateToHistoryEntry", { entryId: entries[current - 1].id });
  } else if (action === "forward") {
    if (current >= entries.length - 1) throw new Error("Cannot go forward: no next page in history");
    await sendDebuggerCommand(tid, "Page.navigateToHistoryEntry", { entryId: entries[current + 1].id });
  } else {
    throw new Error(`Unknown history action: ${action}. Use "back" or "forward".`);
  }
  // Bounded poll for the navigation to land (tab.status is unreliable for
  // CDP-driven navigations and must not hang the bridge command).
  const targetEntry = entries[current + (action === "back" ? -1 : 1)];
  const targetUrl = targetEntry ? targetEntry.url : "";
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tid);
    const cur = t.url || "";
    if (targetUrl && (cur === targetUrl || (targetUrl.length > 20 && cur.startsWith(targetUrl.slice(0, 60))))) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const tab = await chrome.tabs.get(tid);
  return { tabId: tid, url: tab.url, title: tab.title, action };
}

// --- File Upload (set files on <input type="file">) ---

// Helper: JS function injected into page to set a file on an input element via DataTransfer
const SET_FILE_JS = `function(base64, fileName, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], fileName, { type: mimeType });
  const dt = new DataTransfer();
  dt.items.add(file);
  this.files = dt.files;
  this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  return fileName;
}`;

async function handleFileUpload({ selector, fileId, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);
  // Runtime needed for Runtime.callFunctionOn (script execution on resolved node)
  await ensureCdpDomain(tid, "Runtime");

  // Track whether a pending file chooser exists at entry — needed for cleanup on early errors
  const hadPendingFC = pendingFileChoosers.has(tid);
  try {
    if (!fileId) throw new Error("fileId is required");

    // Fetch file binary from chat server
    const { baseUrl, authToken } = await getServerBaseUrl();
    const fileUrl = `${baseUrl}/browser/files/${fileId}` + (authToken ? `?token=${encodeURIComponent(authToken)}` : "");
    let resp;
    try {
      resp = await fetch(fileUrl);
    } catch (err) {
      throw new Error(`Failed to reach file server: ${err.message}`);
    }
    if (!resp.ok) throw new Error(`File server returned ${resp.status} for fileId: ${fileId}`);
    let blob;
    try {
      blob = await resp.blob();
    } catch (err) {
      throw new Error(`Failed to download file data: ${err.message}`);
    }
    const contentDisposition = resp.headers.get("Content-Disposition") || "";
    const nameMatch = contentDisposition.match(/filename="([^"]+)"/);
    const fileName = nameMatch ? nameMatch[1] : `upload_${fileId}`;
    const mimeType = blob.type || "application/octet-stream";

    // Guard against large files that would OOM the service worker during base64 encoding
    const MAX_INJECT_SIZE = 25 * 1024 * 1024; // 25 MiB practical limit for base64 injection
    if (blob.size > MAX_INJECT_SIZE) {
      throw new Error(
        `File too large for browser upload (${(blob.size / 1024 / 1024).toFixed(1)} MiB). Max ${MAX_INJECT_SIZE / 1024 / 1024} MiB.`,
      );
    }

    // Convert to base64 for injection into page context (avoids chrome.downloads entirely)
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const parts = [];
    const chunkSize = 32768; // 32KB — safe for String.fromCharCode.apply (V8 limit ~65K args)
    for (let i = 0; i < bytes.length; i += chunkSize) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    const base64 = btoa(parts.join(""));

    // If a file chooser dialog is pending (from a click with intercept_file_chooser), resolve its element
    const pendingFC = pendingFileChoosers.get(tid);
    if (pendingFC) {
      pendingFileChoosers.delete(tid);
      try {
        // Resolve backendNodeId to a JS object reference
        const resolved = await sendDebuggerCommand(tid, "DOM.resolveNode", {
          backendNodeId: pendingFC.backendNodeId,
        });
        if (!resolved?.object?.objectId) throw new Error("Could not resolve file input element from file chooser");
        const callResult = await sendDebuggerCommand(tid, "Runtime.callFunctionOn", {
          objectId: resolved.object.objectId,
          functionDeclaration: SET_FILE_JS,
          arguments: [{ value: base64 }, { value: fileName }, { value: mimeType }],
          returnByValue: true,
        });
        if (callResult?.exceptionDetails) {
          throw new Error(
            callResult.exceptionDetails.exception?.description ||
              callResult.exceptionDetails.text ||
              "File injection failed in page context",
          );
        }
      } finally {
        // Always disable interception, even on error, to prevent leaking state
        await sendDebuggerCommand(tid, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      }
    } else if (selector) {
      // Direct selector approach — find the input and set files via JS DataTransfer
      const doc = await sendDebuggerCommand(tid, "DOM.getDocument");
      const node = await sendDebuggerCommand(tid, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      });
      if (!node.nodeId) throw new Error(`File input not found: ${selector}`);
      const resolved = await sendDebuggerCommand(tid, "DOM.resolveNode", { nodeId: node.nodeId });
      if (!resolved?.object?.objectId) throw new Error(`Could not resolve file input: ${selector}`);
      const callResult = await sendDebuggerCommand(tid, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: SET_FILE_JS,
        arguments: [{ value: base64 }, { value: fileName }, { value: mimeType }],
        returnByValue: true,
      });
      if (callResult?.exceptionDetails) {
        throw new Error(
          callResult.exceptionDetails.exception?.description ||
            callResult.exceptionDetails.text ||
            "File injection failed in page context",
        );
      }
    } else {
      throw new Error(
        "No pending file chooser and no selector provided. Click the upload button with intercept_file_chooser=true first, then call browser_upload_file.",
      );
    }

    return { tabId: tid, selector: selector || "(file chooser)", fileId, fileName };
  } catch (err) {
    // Clean up file chooser interception state if an early error occurred before the pendingFC branch handled it
    if (hadPendingFC && pendingFileChoosers.has(tid)) {
      pendingFileChoosers.delete(tid);
      await sendDebuggerCommand(tid, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
    throw err;
  }
}

// --- Frames (list iframes) ---

async function handleFrames({ tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  // Runtime domain needed for execution context tracking (frame targeting)
  await ensureCdpDomain(tid, "Runtime");

  const result = await sendDebuggerCommand(tid, "Page.getFrameTree");

  function flattenFrames(frameTree, depth = 0) {
    const frames = [];
    const frame = frameTree.frame;
    frames.push({
      frameId: frame.id,
      parentFrameId: frame.parentId || null,
      url: frame.url,
      name: frame.name || "",
      securityOrigin: frame.securityOrigin,
      depth,
    });
    if (frameTree.childFrames) {
      for (const child of frameTree.childFrames) {
        frames.push(...flattenFrames(child, depth + 1));
      }
    }
    return frames;
  }

  return { tabId: tid, frames: flattenFrames(result.frameTree) };
}

// --- Touch Events ---

async function handleTouch({ action, x, y, selector, endX, endY, scale, tabId, duration }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  let touchX = x;
  let touchY = y;
  if (selector) {
    const coords = await getElementCenter(tid, selector);
    touchX = coords.x;
    touchY = coords.y;
  }
  if (touchX === undefined || touchY === undefined) {
    throw new Error("Touch requires selector or x,y coordinates");
  }

  if (action === "tap") {
    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: touchX, y: touchY }],
    });
    await new Promise((r) => setTimeout(r, 50));
    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    showActionCursor(tid, touchX, touchY);
    return { tabId: tid, action: "tap", x: touchX, y: touchY };
  }

  if (action === "swipe") {
    const eX = endX ?? touchX;
    const eY = endY ?? touchY;
    const steps = 10;

    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: touchX, y: touchY }],
    });

    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: touchX + (eX - touchX) * ratio,
            y: touchY + (eY - touchY) * ratio,
          },
        ],
      });
      await new Promise((r) => setTimeout(r, 20));
    }

    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    showActionCursor(tid, touchX, touchY);
    return { tabId: tid, action: "swipe", from: { x: touchX, y: touchY }, to: { x: eX, y: eY } };
  }

  if (action === "long-press") {
    const holdMs = duration || 500;
    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: touchX, y: touchY }],
    });
    await new Promise((r) => setTimeout(r, holdMs));
    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    showActionCursor(tid, touchX, touchY);
    return { tabId: tid, action: "long-press", x: touchX, y: touchY, duration: holdMs };
  }

  if (action === "pinch") {
    const pinchScale = scale ?? 0.5;
    const halfGap = 50; // initial half-distance between fingers
    const centerX = touchX + halfGap;
    const centerY = touchY;
    const steps = 10;

    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: centerX - halfGap, y: centerY, id: 0 },
        { x: centerX + halfGap, y: centerY, id: 1 },
      ],
    });

    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      const currentHalf = halfGap * (1 + (pinchScale - 1) * ratio);
      await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: centerX - currentHalf, y: centerY, id: 0 },
          { x: centerX + currentHalf, y: centerY, id: 1 },
        ],
      });
      await new Promise((r) => setTimeout(r, 20));
    }

    await sendDebuggerCommand(tid, "Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    showActionCursor(tid, centerX, centerY);
    return { tabId: tid, action: "pinch", center: { x: centerX, y: centerY }, scale: pinchScale };
  }

  throw new Error(`Unknown touch action: ${action}. Use "tap", "swipe", "long-press", or "pinch".`);
}

// --- Device Emulation ---

async function handleEmulate({ action, width, height, deviceScaleFactor, isMobile, hasTouch, userAgent, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  if (action === "clear") {
    await sendDebuggerCommand(tid, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    await sendDebuggerCommand(tid, "Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    await sendDebuggerCommand(tid, "Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => {});
    tabEmulation.delete(tid);
    return { tabId: tid, emulation: "cleared" };
  }

  if (width && height) {
    const metrics = {
      width,
      height,
      deviceScaleFactor: deviceScaleFactor || 1,
      mobile: isMobile || false,
    };
    await sendDebuggerCommand(tid, "Emulation.setDeviceMetricsOverride", metrics);
    tabEmulation.set(tid, { metrics });
  }

  if (hasTouch !== undefined) {
    await sendDebuggerCommand(tid, "Emulation.setTouchEmulationEnabled", {
      enabled: !!hasTouch,
    });
    const emu = tabEmulation.get(tid);
    if (emu) emu.hasTouch = !!hasTouch;
  }

  if (userAgent) {
    await sendDebuggerCommand(tid, "Emulation.setUserAgentOverride", { userAgent });
    const emu = tabEmulation.get(tid);
    if (emu) emu.userAgent = userAgent;
  }

  return {
    tabId: tid,
    emulation: {
      width,
      height,
      deviceScaleFactor: deviceScaleFactor || 1,
      mobile: isMobile || false,
      touch: !!hasTouch,
      userAgent: userAgent || null,
    },
  };
}

// --- Download Handling ---

const MAX_BROWSER_FILE_BYTES = 500 * 1024 * 1024; // 500 MiB

async function getServerBaseUrl() {
  const config = await chrome.storage.local.get(["serverUrl", "authToken"]);
  const wsUrl = config.serverUrl || "ws://localhost:7777/browser/ws";
  // Convert ws:// to http://, wss:// to https://, strip path
  const httpUrl = wsUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/browser\/ws.*$/, "");
  return { baseUrl: httpUrl, authToken: config.authToken || null };
}

async function uploadFileToChatServer(filePath, mime) {
  const { baseUrl, authToken } = await getServerBaseUrl();
  const uploadUrl = `${baseUrl}/browser/files/upload` + (authToken ? `?token=${encodeURIComponent(authToken)}` : "");

  // Route through offscreen document — MV3 service workers cannot fetch file:// URLs
  await ensureOffscreen();

  // Try primary path first, then .crdownload fallback (for stuck blob: downloads)
  let resp = await chrome.runtime.sendMessage({
    type: "upload-file",
    filePath,
    mime: mime || "application/octet-stream",
    uploadUrl,
  });

  if (!resp || !resp.ok) {
    // Fallback: try the .crdownload path (Chrome's temp download file extension)
    // This handles downloads stuck in "in_progress" where all bytes are received but
    // Chrome hasn't finalized the file (common with blob:null URLs from sites like Gemini)
    const crdownloadPath = filePath + ".crdownload";
    const fallbackResp = await chrome.runtime.sendMessage({
      type: "upload-file",
      filePath: crdownloadPath,
      mime: mime || "application/octet-stream",
      uploadUrl,
    });
    if (fallbackResp?.ok) {
      resp = fallbackResp;
    } else {
      throw new Error(
        `Upload failed for ${filePath}: ${resp?.error || "file not found"}` +
          (fallbackResp?.error ? ` (.crdownload fallback also failed: ${fallbackResp.error})` : ""),
      );
    }
  }

  const result = resp.result;
  if (!result.ok) throw new Error(result.error || "Upload failed");
  return result.file;
}

async function handleDownload({ action, timeout }) {
  if (action === "list") {
    const items = await chrome.downloads.search({ limit: 20, orderBy: ["-startTime"] });
    return {
      downloads: items.map((d) => ({
        id: d.id,
        filename: d.filename,
        url: d.url,
        state: d.state,
        totalBytes: d.totalBytes,
        bytesReceived: d.bytesReceived,
        startTime: d.startTime,
        endTime: d.endTime,
        mime: d.mime,
      })),
    };
  }

  if (action === "wait") {
    const maxWait = Math.min(timeout || 30000, 120000);
    const downloadInfo = await new Promise((resolve, reject) => {
      // First check for downloads that already completed recently (within 10s)
      chrome.downloads.search({ limit: 5, orderBy: ["-startTime"] }, (items) => {
        const now = Date.now();
        const recent = items?.find((d) => {
          if (d.state === "complete" && d.endTime) {
            const endTs = new Date(d.endTime).getTime();
            return now - endTs < 10000;
          }
          return false;
        });
        if (recent) {
          resolve(recent);
          return;
        }

        // Check for recently interrupted downloads — fail fast instead of waiting maxWait
        const interrupted = items?.find((d) => {
          if (d.state === "interrupted" && d.endTime) {
            const endTs = new Date(d.endTime).getTime();
            return now - endTs < 10000;
          }
          return false;
        });
        if (interrupted) {
          reject(new Error(`Download interrupted: ${interrupted.error || "unknown reason"}`));
          return;
        }

        // Check for stuck downloads (all bytes received but state still in_progress, e.g. blob: URLs)
        const stuck = items?.find(
          (d) => d.state === "in_progress" && d.totalBytes > 0 && d.bytesReceived >= d.totalBytes,
        );
        if (stuck) {
          // Check if CDP already confirmed completion (survives consumeRecentDownload splice)
          if (cdpCompletedUrls.has(stuck.url)) {
            cdpCompletedUrls.delete(stuck.url);
            resolve(stuck);
            return;
          }
          // Brief poll — give Chrome a chance to finalize before resolving with stuck state
          let pollCount = 0;
          const pollTimer = setInterval(() => {
            pollCount++;
            // Check CDP signal first (fires before chrome.downloads transitions for blob: URLs)
            if (cdpCompletedUrls.has(stuck.url)) {
              cdpCompletedUrls.delete(stuck.url);
              clearInterval(pollTimer);
              resolve(stuck);
              return;
            }
            chrome.downloads.search({ id: stuck.id }, (updated) => {
              const state = updated?.[0]?.state;
              if (state === "complete") {
                clearInterval(pollTimer);
                resolve(updated[0]);
              } else if (state === "interrupted") {
                // User cancelled or download failed during polling
                clearInterval(pollTimer);
                reject(new Error(`Download interrupted: ${updated?.[0]?.error || "unknown reason"}`));
              } else if (pollCount >= 10) {
                // 5 seconds — download is truly stuck (common for blob:null URLs)
                clearInterval(pollTimer);
                resolve({ ...stuck, _stuck: true });
              }
            });
          }, 500);
          return;
        }

        // No recent completion found — listen for future events
        const timer = setTimeout(() => {
          chrome.downloads.onChanged.removeListener(listener);
          // Last-resort: check for completed or stuck downloads
          chrome.downloads.search({ limit: 5, orderBy: ["-startTime"] }, (final) => {
            const completed = final?.find(
              (d) => d.state === "complete" && d.endTime && Date.now() - new Date(d.endTime).getTime() < maxWait + 5000,
            );
            if (completed) {
              resolve(completed);
              return;
            }
            // Also check for stuck downloads at timeout
            const stuckAtEnd = final?.find(
              (d) => d.state === "in_progress" && d.totalBytes > 0 && d.bytesReceived >= d.totalBytes,
            );
            if (stuckAtEnd) {
              resolve({ ...stuckAtEnd, _stuck: true });
              return;
            }
            // Check for interrupted downloads — provide specific error instead of generic timeout
            const interruptedAtEnd = final?.find(
              (d) =>
                d.state === "interrupted" && d.endTime && Date.now() - new Date(d.endTime).getTime() < maxWait + 5000,
            );
            if (interruptedAtEnd) {
              reject(new Error(`Download interrupted: ${interruptedAtEnd.error || "unknown reason"}`));
              return;
            }
            reject(new Error(`No download completed within ${maxWait / 1000}s`));
          });
        }, maxWait);

        function listener(delta) {
          if (delta.state && delta.state.current === "complete") {
            clearTimeout(timer);
            chrome.downloads.onChanged.removeListener(listener);
            chrome.downloads.search({ id: delta.id }, (found) => {
              if (found && found.length > 0) {
                resolve(found[0]);
              } else {
                resolve({ id: delta.id });
              }
            });
          } else if (delta.state && delta.state.current === "interrupted") {
            clearTimeout(timer);
            chrome.downloads.onChanged.removeListener(listener);
            chrome.downloads.search({ id: delta.id }, (found) => {
              reject(new Error(`Download interrupted: ${found?.[0]?.error || "unknown reason"}`));
            });
          }
        }
        chrome.downloads.onChanged.addListener(listener);
      });
    });
    // Auto-upload to chat server
    if (downloadInfo.filename) {
      try {
        const file = await uploadFileToChatServer(downloadInfo.filename, downloadInfo.mime);
        return {
          file_id: file.id,
          filename: file.name,
          mime: downloadInfo.mime,
          size: file.size,
          source_url: downloadInfo.url,
        };
      } catch (uploadErr) {
        return {
          filename: downloadInfo.filename,
          url: downloadInfo.url,
          mime: downloadInfo.mime,
          totalBytes: downloadInfo.totalBytes,
          upload_error: uploadErr.message,
        };
      }
    }
    return downloadInfo;
  }

  if (action === "latest") {
    // Only consider downloads from the last 5 minutes
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    let items = await chrome.downloads.search({
      limit: 1,
      orderBy: ["-startTime"],
      state: "complete",
      startedAfter: fiveMinAgo,
    });
    // Fallback: check for stuck downloads (all bytes received, state still in_progress)
    if (items.length === 0) {
      const allRecent = await chrome.downloads.search({ limit: 5, orderBy: ["-startTime"] });
      const stuck = allRecent?.find(
        (d) =>
          d.state === "in_progress" &&
          d.totalBytes > 0 &&
          d.bytesReceived >= d.totalBytes &&
          new Date(d.startTime).toISOString() >= fiveMinAgo,
      );
      if (stuck) items = [stuck];
    }
    if (items.length === 0) throw new Error("No recent completed downloads found (within last 5 minutes)");
    const item = items[0];
    // Auto-upload to chat server
    try {
      const file = await uploadFileToChatServer(item.filename, item.mime);
      return { file_id: file.id, filename: file.name, mime: item.mime, size: file.size, source_url: item.url };
    } catch (uploadErr) {
      return {
        filename: item.filename,
        url: item.url,
        mime: item.mime,
        totalBytes: item.totalBytes,
        upload_error: uploadErr.message,
      };
    }
  }

  throw new Error(`Unknown download action: ${action}. Use "list", "wait", or "latest".`);
}

// --- HTTP Authentication ---

async function handleAuth({ action, username, password, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);
  // Fetch domain needed for HTTP auth interception
  await ensureCdpDomain(tid, "Fetch", { handleAuthRequests: true });

  if (action === "status") {
    const reqIds = pendingAuthByTab.get(tid);
    if (!reqIds || reqIds.size === 0) return { tabId: tid, pending: false };
    // Return first pending auth request
    const rid = reqIds.values().next().value;
    const auth = pendingAuth.get(rid);
    return { tabId: tid, pending: true, request_id: rid, url: auth?.url, scheme: auth?.scheme, realm: auth?.realm };
  }

  if (action === "provide") {
    const reqIds = pendingAuthByTab.get(tid);
    if (!reqIds || reqIds.size === 0) throw new Error("No pending auth request on this tab");
    const rid = reqIds.values().next().value;
    const auth = pendingAuth.get(rid);
    // Remove BEFORE awaiting to prevent timeout from double-continuing
    pendingAuth.delete(rid);
    reqIds.delete(rid);
    if (reqIds.size === 0) pendingAuthByTab.delete(tid);
    await sendDebuggerCommand(tid, "Fetch.continueWithAuth", {
      requestId: rid,
      authChallengeResponse: {
        response: "ProvideCredentials",
        username: username || "",
        password: password || "",
      },
    });
    return { tabId: tid, authenticated: true, url: auth?.url };
  }

  if (action === "cancel") {
    const reqIds = pendingAuthByTab.get(tid);
    if (!reqIds || reqIds.size === 0) throw new Error("No pending auth request on this tab");
    const rid = reqIds.values().next().value;
    // Remove BEFORE awaiting to prevent timeout from double-continuing
    pendingAuth.delete(rid);
    reqIds.delete(rid);
    if (reqIds.size === 0) pendingAuthByTab.delete(tid);
    await sendDebuggerCommand(tid, "Fetch.continueWithAuth", {
      requestId: rid,
      authChallengeResponse: { response: "CancelAuth" },
    });
    return { tabId: tid, cancelled: true };
  }

  throw new Error(`Unknown auth action: ${action}. Use "status", "provide", or "cancel".`);
}

// --- Browser Permissions ---

async function handlePermissions({ action, permissions, origin, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);

  if (!permissions || !permissions.length) throw new Error("permissions array is required");

  // Resolve origin, guard against special URLs
  let permOrigin = origin;
  if (!permOrigin) {
    const tab = await chrome.tabs.get(tid);
    permOrigin = new URL(tab.url).origin;
  }
  // Validate origin regardless of source
  if (permOrigin === "null" || !/^https?:\/\//.test(permOrigin)) {
    throw new Error(`Invalid origin "${permOrigin}" — Browser.setPermission requires an http:// or https:// origin.`);
  }

  const setting = action === "grant" ? "granted" : action === "deny" ? "denied" : action === "reset" ? "prompt" : null;
  if (!setting) throw new Error(`Unknown permissions action: ${action}. Use "grant", "deny", or "reset".`);

  for (const perm of permissions) {
    await sendDebuggerCommand(tid, "Browser.setPermission", {
      permission: { name: perm },
      setting,
      origin: permOrigin,
    });
  }

  const resultKey = { grant: "granted", deny: "denied", reset: "reset" }[action];
  return { tabId: tid, [resultKey]: permissions, origin: permOrigin };
}

// --- Agent Script Storage (per-origin via chrome.storage.local) ---
// Stealth: Uses chrome.storage.local instead of page localStorage.
// This is extension-only IPC storage — completely invisible to page JavaScript
// and all anti-bot detection scripts. No content script injection needed.

async function handleStore({ action, key, value, description, tabId }) {
  const tid = tabId || (await getActiveTabId());
  // Resolve origin for per-site key namespacing
  const tab = await chrome.tabs.get(tid);
  let origin;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    throw new Error(`Cannot determine origin for tab ${tid} (url: ${tab.url})`);
  }
  // Reject opaque origins (file:, data:, about:, chrome:, etc.) which all resolve to "null"
  if (origin === "null") {
    throw new Error(
      `Cannot use store on ${tab.url.split(":")[0]}:// pages — no usable origin. Navigate to an http(s) page first.`,
    );
  }
  // Storage keys are namespaced by origin to isolate per-site data
  const storeKey = `store:${origin}`;
  const metaKey = `meta:${origin}`;

  if (action === "set") {
    if (!key) throw new Error("key is required for store set");
    if (value === undefined || value === null) throw new Error("value is required for store set");
    const data = await chrome.storage.local.get([storeKey, metaKey]);
    const store = data[storeKey] || {};
    const meta = data[metaKey] || {};
    store[key] = value;
    if (description) {
      meta[key] = description;
    } else {
      delete meta[key];
    }
    await chrome.storage.local.set({ [storeKey]: store, [metaKey]: meta });
    return { tabId: tid, stored: true, key };
  }

  if (action === "get") {
    if (!key) throw new Error("key is required for store get");
    const data = await chrome.storage.local.get(storeKey);
    const store = data[storeKey] || {};
    return { tabId: tid, key, value: store[key] ?? null, found: key in store };
  }

  if (action === "list") {
    const data = await chrome.storage.local.get([storeKey, metaKey]);
    const store = data[storeKey] || {};
    const meta = data[metaKey] || {};
    const keys = Object.keys(store);
    const items = keys.map((k) => {
      const val = store[k];
      const isScript = typeof val === "string" && /[;{}()=]|return |function |=>/.test(val);
      return {
        key: k,
        type: isScript ? "script" : typeof val,
        description: meta[k] || null,
        size: typeof val === "string" ? val.length : JSON.stringify(val).length,
      };
    });
    return { tabId: tid, origin, items, count: keys.length };
  }

  if (action === "delete") {
    if (!key) throw new Error("key is required for store delete");
    const data = await chrome.storage.local.get([storeKey, metaKey]);
    const store = data[storeKey] || {};
    const meta = data[metaKey] || {};
    const existed = key in store;
    delete store[key];
    delete meta[key];
    await chrome.storage.local.set({ [storeKey]: store, [metaKey]: meta });
    return { tabId: tid, deleted: existed, key };
  }

  if (action === "clear") {
    await chrome.storage.local.remove([storeKey, metaKey]);
    return { tabId: tid, cleared: true };
  }

  throw new Error(`Unknown store action: ${action}. Use "set", "get", "list", "delete", or "clear".`);
}

// --- Cookie Access (HttpOnly-safe via chrome.cookies API) ---
// Stealth: Uses chrome.cookies IPC — zero page-side detection surface.
// Unlike CDP Network.getCookies, this doesn't require debugger attachment.

async function handleCookies({
  action,
  url,
  domain,
  name,
  value,
  path,
  secure,
  httpOnly,
  sameSite,
  expirationDate,
  tabId,
}) {
  if (action === "getAll") {
    const filter = {};
    if (url) filter.url = url;
    if (domain) filter.domain = domain;
    if (name) filter.name = name;
    // If no explicit URL/domain, resolve from the active tab
    if (!url && !domain) {
      const tid = tabId || (await getActiveTabId());
      const tab = await chrome.tabs.get(tid);
      if (tab.url && /^https?:/.test(tab.url)) {
        filter.url = tab.url;
      } else {
        throw new Error(
          "Cannot determine URL for cookie lookup — navigate to an http(s) page or provide url/domain explicitly.",
        );
      }
    }
    const cookies = await chrome.cookies.getAll(filter);
    return { cookies, count: cookies.length };
  }

  if (action === "get") {
    if (!name) throw new Error("name is required for cookie get");
    let cookieUrl = url;
    if (!cookieUrl) {
      const tid = tabId || (await getActiveTabId());
      const tab = await chrome.tabs.get(tid);
      cookieUrl = tab.url;
    }
    if (!cookieUrl) throw new Error("url is required for cookie get (or provide tabId)");
    const cookie = await chrome.cookies.get({ url: cookieUrl, name });
    return { cookie };
  }

  if (action === "set") {
    if (!url) throw new Error("url is required for cookie set");
    if (!name) throw new Error("name is required for cookie set");
    const details = { url, name, value: value ?? "" };
    if (domain) details.domain = domain;
    if (path) details.path = path;
    if (secure !== undefined) details.secure = secure;
    if (httpOnly !== undefined) details.httpOnly = httpOnly;
    if (sameSite) {
      // Normalize HTTP spec "none" → Chrome API "no_restriction"
      details.sameSite = sameSite.toLowerCase() === "none" ? "no_restriction" : sameSite;
    }
    if (expirationDate) details.expirationDate = expirationDate;
    const cookie = await chrome.cookies.set(details);
    if (!cookie)
      throw new Error(
        `Failed to set cookie "${name}" — the browser rejected it. Check url scheme vs secure flag, sameSite, and domain.`,
      );
    return { cookie };
  }

  if (action === "remove") {
    if (!name) throw new Error("name is required for cookie remove");
    let cookieUrl = url;
    if (!cookieUrl) {
      const tid = tabId || (await getActiveTabId());
      const tab = await chrome.tabs.get(tid);
      cookieUrl = tab.url;
    }
    if (!cookieUrl) throw new Error("url is required for cookie remove (or provide tabId)");
    const details = await chrome.cookies.remove({ url: cookieUrl, name });
    return { removed: !!details, name };
  }

  throw new Error(`Unknown cookies action: ${action}. Use "getAll", "get", "set", or "remove".`);
}


// ============================================================================
// Agent-browser port: element discovery + interaction extras
// ============================================================================


// ---- Snapshot page function (SELF-CONTAINED: chrome.scripting serializes only the function, so all helpers are embedded) ----

const SNAPSHOT_FN = function (opts) {
  function buildSelector(el, root) {
    if (!el || el === document.documentElement) return "html";
    const testId = el.getAttribute && el.getAttribute("data-testid");
    if (testId) return '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
    if (el.id) return "#" + CSS.escape(el.id);
    const path = [];
    let cur = el;
    while (cur && cur !== root && cur !== document.body && path.length < 10) {
      let sel = cur.tagName.toLowerCase();
      const cls = Array.from(cur.classList || []).filter(function (c) { return c && c.trim(); });
      if (cls.length) sel += "." + CSS.escape(cls[0]);
      const parent = cur.parentElement;
      if (parent) {
        const kids = Array.from(parent.children);
        const same = kids.filter(function (s) {
          if (s.tagName !== cur.tagName) return false;
          if (cls.length && !s.classList.contains(cls[0])) return false;
          return true;
        });
        if (same.length > 1) sel += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      path.unshift(sel);
      if (path.length >= 1) {
        try {
          if (document.querySelectorAll(path.join(" > ")).length === 1) break;
        } catch (e) {}
      }
      cur = parent;
    }
    return path.join(" > ");
  }

  function accName(el) {
    if (!el) return "";
    try {
      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) {
        const parts = labelledby.split(/\s+/).map(function (id) {
          const ref = document.getElementById(id);
          return ref ? (ref.textContent || "").trim() : "";
        }).filter(Boolean);
        if (parts.length) return parts.join(" ").slice(0, 120);
      }
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 120);
      const tag = el.tagName.toLowerCase();
      if (tag === "select") return ""; // select name must come from a label/aria, not its options
      if (tag === "input" || tag === "textarea") {
        const id = el.id;
        if (id) {
          const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
          if (lab && (lab.textContent || "").trim()) return lab.textContent.trim().slice(0, 120);
        }
        const wrapLabel = el.closest("label");
        if (wrapLabel && (wrapLabel.textContent || "").trim()) {
          return wrapLabel.textContent.trim().replace(el.value || "", "").trim().slice(0, 120);
        }
        if (tag === "input" || tag === "textarea") {
          const ph = el.getAttribute("placeholder");
          if (ph && ph.trim()) return ph.trim().slice(0, 120);
        }
      }
      if (tag === "img" && el.alt) return el.alt.slice(0, 120);
      const title = el.getAttribute("title");
      if (title && title.trim()) return title.trim().slice(0, 120);
      if (tag === "input" && el.value && /^(button|submit|reset)$/.test(el.type || "")) return el.value.slice(0, 120);
      const txt = (el.textContent || "").trim();
      if (txt) return txt.replace(/\s+/g, " ").slice(0, 120);
      return "";
    } catch (e) { return ""; }
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    return true;
  }

  const results = [];
  const seen = new Set();
  const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary", "details", "option"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox",
    "menuitem", "menuitemcheckbox", "menuitemradio", "option", "slider", "spinbutton", "switch", "tab", "treeitem",
  ]);

  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.href) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "button";
    if (tag === "option") return "option";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "button" || t === "submit" || t === "reset") return "button";
      if (t === "file") return "file";
      if (t === "search") return "searchbox";
      if (/^(text|email|url|tel|password|date|datetime-local|month|week|time|color)$/.test(t)) return "textbox";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "generic";
  }

  function interactive(el) {
    const role = roleOf(el);
    if (INTERACTIVE_ROLES.has(role)) return true;
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const tabIndex = el.getAttribute && el.getAttribute("tabindex");
    if (tabIndex !== null && tabIndex !== "-1") return true;
    if (el.onclick || el.getAttribute("onclick") || el.getAttribute("onkeydown")) return true;
    return false;
  }

  function visit(el) {
    if (!el || el.nodeType !== 1) return false;
    if (seen.has(el)) return false;
    seen.add(el);
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") return false;

    const role = roleOf(el);
    const isHeading = /^h[1-6]$/.test(tag);
    const isInteractive = interactive(el);
    const cursorHit = opts.cursor && !isInteractive && (function () {
      const cs = getComputedStyle(el);
      if (cs.cursor !== "pointer") return false;
      const parent = el.parentElement;
      if (parent && getComputedStyle(parent).cursor === "pointer") return false;
      return true;
    })();

    if ((isInteractive || cursorHit || (opts.includeHeadings && isHeading && (el.textContent || "").trim())) && isVisible(el)) {
      const name = accName(el);
      const value = el.value !== undefined && el.value !== null ? String(el.value) : (el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent.trim() : "");
      const entry = {
        role,
        tag,
        name,
        selector: buildSelector(el, opts.scope ? document.querySelector(opts.scope) : null),
      };
      if (value !== "") entry.value = value.slice(0, 200);
      if (role === "checkbox" || role === "radio") entry.checked = !!el.checked;
      if (tag === "a" && el.href) entry.href = el.href.slice(0, 500);
      if (tag === "input" && el.type) entry.type = (el.type || "text").toLowerCase();
      if (isHeading) entry.level = Number(tag[1]);
      results.push(entry);
      if (results.length >= opts.max) return true;
    }
    let kids = Array.from(el.children || []);
    if (el.shadowRoot) kids = kids.concat(Array.from(el.shadowRoot.children || []));
    for (const k of kids) {
      if (visit(k)) return true;
    }
    if (el.tagName === "IFRAME") {
      try {
        const doc = el.contentDocument;
        if (doc) { for (const k of Array.from(doc.body ? doc.body.children : [])) { if (visit(k)) return true; } }
      } catch (e) {}
    }
    return false;
  }

  const root = opts.scope ? document.querySelector(opts.scope) : document.body;
  if (root) { for (const k of Array.from(root.children)) { if (visit(k)) break; } }
  return results;
};

// ---- Find page function (self-contained) ----

const FIND_FN = function (opts) {
  function accName(el) {
    if (!el) return "";
    try {
      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) {
        const parts = labelledby.split(/\s+/).map(function (id) {
          const ref = document.getElementById(id);
          return ref ? (ref.textContent || "").trim() : "";
        }).filter(Boolean);
        if (parts.length) return parts.join(" ").slice(0, 120);
      }
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 120);
      const tag = el.tagName.toLowerCase();
      if (tag === "select") return ""; // select name must come from a label/aria, not its options
      if (tag === "input" || tag === "textarea") {
        const id = el.id;
        if (id) {
          const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
          if (lab && (lab.textContent || "").trim()) return lab.textContent.trim().slice(0, 120);
        }
        const wrapLabel = el.closest("label");
        if (wrapLabel && (wrapLabel.textContent || "").trim()) {
          return wrapLabel.textContent.trim().replace(el.value || "", "").trim().slice(0, 120);
        }
        if (tag === "input" || tag === "textarea") {
          const ph = el.getAttribute("placeholder");
          if (ph && ph.trim()) return ph.trim().slice(0, 120);
        }
      }
      if (tag === "img" && el.alt) return el.alt.slice(0, 120);
      const title = el.getAttribute("title");
      if (title && title.trim()) return title.trim().slice(0, 120);
      const txt = (el.textContent || "").trim();
      if (txt) return txt.replace(/\s+/g, " ").slice(0, 120);
      return "";
    } catch (e) { return ""; }
  }

  function buildSelector(el) {
    const testId = el.getAttribute && el.getAttribute("data-testid");
    if (testId) return '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
    if (el.id) return "#" + CSS.escape(el.id);
    const path = [];
    let cur = el;
    while (cur && cur !== document.body && path.length < 10) {
      let sel = cur.tagName.toLowerCase();
      const cls = Array.from(cur.classList || []).filter(function (c) { return c && c.trim(); });
      if (cls.length) sel += "." + CSS.escape(cls[0]);
      const parent = cur.parentElement;
      if (parent) {
        const kids = Array.from(parent.children);
        const same = kids.filter(function (s) {
          if (s.tagName !== cur.tagName) return false;
          if (cls.length && !s.classList.contains(cls[0])) return false;
          return true;
        });
        if (same.length > 1) sel += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      path.unshift(sel);
      if (path.length >= 1) {
        try {
          if (document.querySelectorAll(path.join(" > ")).length === 1) break;
        } catch (e) {}
      }
      cur = parent;
    }
    return path.join(" > ");
  }

  const out = [];
  const exact = opts.exact === true; // substring by default; exact only when requested
  function m(s) { if (s == null) return true; return exact ? s === opts[opts.kind] : String(s).toLowerCase().includes(String(opts[opts.kind]).toLowerCase()); }
  const all = document.querySelectorAll("*");
  const cap = Math.min(opts.max || 50, 100);
  for (const el of all) {
    if (out.length >= cap) break;
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    let hit = false;
    if (opts.kind === "selector" && opts.selector) {
      try { hit = el.matches(opts.selector); } catch (e) {}
    } else if (opts.kind === "role") {
      const explicit = el.getAttribute("role");
      const tagRole = { a: "link", button: "button", select: "combobox", textarea: "textbox", input: (el.type === "checkbox" ? "checkbox" : el.type === "radio" ? "radio" : el.type === "range" ? "slider" : "textbox") }[el.tagName.toLowerCase()];
      const role = (explicit || tagRole || "").toLowerCase();
      hit = role === String(opts.role).toLowerCase();
      if (hit && opts.name != null) hit = accName(el) === String(opts.name);
    } else if (opts.kind === "text") {
      const t = (el.textContent || "").trim().replace(/\s+/g, " ");
      hit = m(t);
    } else if (opts.kind === "label") {
      const id = el.id;
      const lab = id && document.querySelector('label[for="' + CSS.escape(id) + '"]');
      hit = lab ? m(lab.textContent) : false;
    } else if (opts.kind === "placeholder") {
      hit = el.getAttribute && el.getAttribute("placeholder") != null && m(el.getAttribute("placeholder"));
    } else if (opts.kind === "title") {
      hit = el.getAttribute && el.getAttribute("title") != null && m(el.getAttribute("title"));
    } else if (opts.kind === "testid") {
      hit = el.getAttribute && el.getAttribute("data-testid") != null && m(el.getAttribute("data-testid"));
    }
    if (hit) {
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (rect && rect.width === 0 && rect.height === 0) continue;
      out.push({
        role: el.getAttribute("role") || (el.tagName.toLowerCase() === "a" ? "link" : el.tagName.toLowerCase()),
        tag: el.tagName.toLowerCase(),
        name: accName(el),
        text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
        value: el.value !== undefined ? String(el.value).slice(0, 200) : "",
        selector: buildSelector(el),
        href: el.tagName === "A" && el.href ? el.href : undefined,
      });
    }
  }
  return out;
};

async function handleSnapshot({ interactive, cursor, max, includeHeadings, scope, tabId }) {
  const tid = tabId || (await getActiveTabId());
  const tab = await chrome.tabs.get(tid);
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    world: "MAIN",
    func: SNAPSHOT_FN,
    args: [{ interactive: interactive !== false, cursor: !!cursor, max: Math.min(max || 300, 500), includeHeadings: !!includeHeadings, scope: scope || null }],
  });
  return { entries: results[0]?.result || [], url: tab.url || "", title: tab.title || "" };
}

async function handleFind({ role, name, text, label, placeholder, title, testid, selector, exact, max, tabId }) {
  const tid = tabId || (await getActiveTabId());
  let kind = null, val = null;
  if (role != null) { kind = "role"; val = role; }
  else if (text != null) { kind = "text"; val = text; }
  else if (label != null) { kind = "label"; val = label; }
  else if (placeholder != null) { kind = "placeholder"; val = placeholder; }
  else if (title != null) { kind = "title"; val = title; }
  else if (testid != null) { kind = "testid"; val = testid; }
  else if (selector != null) { kind = "selector"; val = selector; }
  if (!kind) throw new Error("browser_find requires one of: role, name, text, label, placeholder, title, testid, selector");
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    world: "MAIN",
    func: FIND_FN,
    args: [{ kind, [kind]: val, name: name ?? null, exact: exact === true, max: Math.min(max || 50, 100) }],
  });
  return { matches: results[0]?.result || [] };
}

// ---- Get element info ----

const GET_FN = function (opts) {
  const els = document.querySelectorAll(opts.selector);
  if (opts.property === "count") return { exists: true, count: els.length };
  const el = els[0];
  if (!el) return { exists: false };
  switch (opts.property) {
    case "text": return { exists: true, text: (el.innerText || el.textContent || "").trim().slice(0, 20000) };
    case "html": return { exists: true, html: (el.outerHTML || "").slice(0, 50000) };
    case "value": return { exists: true, value: el.value !== undefined ? String(el.value) : (el.textContent || "").trim() };
    case "attribute": return { exists: true, value: el.getAttribute ? el.getAttribute(opts.attr) : null };
    case "box": {
      const r = el.getBoundingClientRect();
      return { exists: true, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
    }
    case "styles": {
      const cs = getComputedStyle(el);
      if (opts.styleProperty) return { exists: true, value: cs.getPropertyValue(opts.styleProperty) };
      const styles = {};
      for (let i = 0; i < cs.length && i < 60; i++) { const p = cs[i]; styles[p] = cs.getPropertyValue(p); }
      return { exists: true, styles };
    }
    default: return { exists: true, tag: el.tagName.toLowerCase(), id: el.id || null, className: typeof el.className === "string" ? el.className : "", role: el.getAttribute("role"), text: (el.innerText || "").trim().slice(0, 2000), value: el.value !== undefined ? String(el.value).slice(0, 200) : undefined };
  }
};

async function handleGetElement({ selector, property, attr, styleProperty, tabId }) {
  const tid = tabId || (await getActiveTabId());
  if (!selector) throw new Error("get_element requires a selector");
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    world: "MAIN",
    func: GET_FN,
    args: [{ selector, property: property || "info", attr: attr || null, styleProperty: styleProperty || null }],
  });
  const r = results[0]?.result || { exists: false };
  if (!r.exists && property !== "count") throw new Error("Element not found: " + selector);
  return r;
}

// ---- Is (element state) ----

const IS_FN = function (opts) {
  const el = document.querySelector(opts.selector);
  if (!el) return { exists: false };
  const cs = getComputedStyle(el);
  const visible = (function () {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    return true;
  })();
  const disabled = !!el.disabled || el.getAttribute("aria-disabled") === "true";
  const checked = !!(el.checked !== undefined && el.checked);
  const editable = !disabled && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) && !el.readOnly;
  const readonly = !!el.readOnly || el.getAttribute("aria-readonly") === "true";
  const focused = document.activeElement === el;
  const state = { exists: true, visible, hidden: !visible, enabled: !disabled, disabled, checked, unchecked: !checked, editable, readonly, focused };
  return { exists: true, result: !!state[opts.check] };
};

async function handleIsElement({ selector, check, tabId }) {
  const tid = tabId || (await getActiveTabId());
  if (!selector) throw new Error("is_element requires a selector");
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    world: "MAIN",
    func: IS_FN,
    args: [{ selector, check }],
  });
  const r = results[0]?.result;
  if (!r?.exists) throw new Error("Element not found: " + selector);
  return { check, result: r.result };
}

// ---- Fill / Check / Uncheck / Focus / Dblclick ----

async function handleFill({ text, selector, tabId, pressEnter }) {
  // fill = clear + type (agent-browser semantics)
  return handleType({ text, selector, tabId, clearFirst: true, pressEnter });
}

async function handleCheck({ selector, tabId }) {
  const tid = tabId || (await getActiveTabId());
  if (!selector) throw new Error("check requires a selector");
  const st = await chrome.scripting.executeScript({
    target: { tabId: tid },
    world: "MAIN",
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { error: `Element not found: ${sel}` };
      if (el.tagName !== "INPUT" || !/^(checkbox|radio)$/.test(el.type || "")) {
        return { error: `Element is not a checkbox/radio: <${el.tagName} type="${el.type || ""}">` };
      }
      return { checked: !!el.checked };
    },
    args: [selector],
  });
  const r = st[0]?.result;
  if (r?.error) throw new Error(r.error);
  if (r.checked) return { tabId: tid, checked: true, already: true };
  await ensureDebugger(tid);
  const coords = await getElementCenter(tid, selector);
  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", { type: "mousePressed", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", { type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
  showActionCursor(tid, coords.x, coords.y);
  return { tabId: tid, checked: true, already: false };
}

async function handleUncheck({ selector, tabId }) {
  const tid = tabId || (await getActiveTabId());
  if (!selector) throw new Error("uncheck requires a selector");
  const st = await chrome.scripting.executeScript({
    target: { tabId: tid },
    world: "MAIN",
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { error: `Element not found: ${sel}` };
      if (el.tagName !== "INPUT" || !/^(checkbox|radio)$/.test(el.type || "")) {
        return { error: `Element is not a checkbox/radio: <${el.tagName} type="${el.type || ""}">` };
      }
      return { checked: !!el.checked };
    },
    args: [selector],
  });
  const r = st[0]?.result;
  if (r?.error) throw new Error(r.error);
  if (!r.checked) return { tabId: tid, checked: false, already: true };
  await ensureDebugger(tid);
  const coords = await getElementCenter(tid, selector);
  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", { type: "mousePressed", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
  await sendDebuggerCommand(tid, "Input.dispatchMouseEvent", { type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
  showActionCursor(tid, coords.x, coords.y);
  return { tabId: tid, checked: false, already: false };
}

async function handleFocus({ selector, tabId }) {
  const tid = tabId || (await getActiveTabId());
  if (!selector) throw new Error("focus requires a selector");
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    world: "MAIN",
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { error: `Element not found: ${sel}` };
      if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(true);
      else el.scrollIntoView({ block: "center" });
      el.focus();
      const rect = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    },
    args: [selector],
  });
  const r = results[0]?.result;
  if (r?.error) throw new Error(r.error);
  if (r?.x != null) showActionCursor(tid, r.x, r.y);
  return { tabId: tid, focused: true, element: selector };
}

async function handleDblClick(params) {
  // double-click = click with clickCount 2
  return handleClick({ ...params, clickCount: 2 });
}

// ---- Reload / Back / Forward / Close ----

async function handleReload({ tabId, waitFor }) {
  const tid = tabId || (await getActiveTabId());
  await chrome.tabs.reload(tid);
  await waitForTab(tid, waitFor || "load");
  const tab = await chrome.tabs.get(tid);
  return { tabId: tid, url: tab.url, title: tab.title };
}

async function handleBack(params) { return handleHistory({ ...params, action: "back" }); }
async function handleForward(params) { return handleHistory({ ...params, action: "forward" }); }

async function handleCloseTab({ tabId }) {
  const tid = tabId || (await getActiveTabId());
  await chrome.tabs.remove(tid);
  return { closed: tid };
}

// ---- Wait (general conditions) ----

async function handleWait({ mode, selector, text, url, timeout, state, tabId }) {
  const tid = tabId || (await getActiveTabId());
  const maxWait = Math.min(timeout || 10000, 30000);
  const start = Date.now();
  switch (mode || "timeout") {
    case "timeout": {
      await new Promise((r) => setTimeout(r, maxWait));
      return { tabId: tid, waited: maxWait };
    }
    case "load": {
      await waitForTab(tid, state || "load");
      return { tabId: tid, loaded: true };
    }
    case "url": {
      if (!url) throw new Error("url is required for wait mode=url");
      const isRegex = (() => { try { new RegExp(url); return true; } catch { return false; } })();
      while (Date.now() - start < maxWait) {
        const tab = await chrome.tabs.get(tid);
        const match = isRegex ? new RegExp(url).test(tab.url || "") : (tab.url || "").includes(url);
        if (match) return { tabId: tid, url: tab.url, matched: url, elapsed: Date.now() - start };
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("URL did not match within " + maxWait + "ms");
    }
    case "text": {
      if (!text) throw new Error("text is required for wait mode=text");
      while (Date.now() - start < maxWait) {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tid },
          func: (t) => (document.body ? document.body.textContent || "" : "").includes(t),
          args: [text],
        });
        if (res[0]?.result) return { tabId: tid, text, found: true, elapsed: Date.now() - start };
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("Text \"" + text + "\" not found within " + maxWait + "ms");
    }
    case "selector": {
      if (!selector) throw new Error("selector is required for wait mode=selector");
      return handleWaitFor({ selector, tabId: tid, timeout: maxWait });
    }
    default:
      throw new Error("Unknown wait mode: " + mode);
  }
}

// ---- Highlight ----

async function handleHighlight({ selector, duration, tabId }) {
  const tid = tabId || (await getActiveTabId());
  if (!selector) throw new Error("highlight requires a selector");
  await chrome.tabs.sendMessage(tid, { type: "highlight-element", selector, duration: duration || 2000 }).catch(() => {});
  return { tabId: tid, highlighted: selector };
}

// ---- Storage (localStorage / sessionStorage) ----

const STORAGE_FN = function (opts) {
  const store = opts.type === "session" ? window.sessionStorage : window.localStorage;
  try {
    if (opts.action === "get") {
      if (opts.key != null) return { exists: store.getItem(opts.key) !== null, key: opts.key, value: store.getItem(opts.key) };
      const items = {};
      for (let i = 0; i < store.length; i++) { const k = store.key(i); items[k] = store.getItem(k); }
      return { items, count: store.length };
    }
    if (opts.action === "set") {
      if (opts.key == null) return { error: "key is required for set" };
      store.setItem(String(opts.key), String(opts.value ?? ""));
      return { set: true, key: opts.key };
    }
    if (opts.action === "remove") {
      if (opts.key == null) return { error: "key is required for remove" };
      store.removeItem(String(opts.key));
      return { removed: true, key: opts.key };
    }
    if (opts.action === "clear") {
      const n = store.length;
      store.clear();
      return { cleared: true, count: n };
    }
    return { error: "unknown action: " + opts.action };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
};

async function handleStorage({ action, key, value, type, tabId }) {
  const tid = tabId || (await getActiveTabId());
  const t = type === "session" ? "session" : "local";
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    world: "MAIN",
    func: STORAGE_FN,
    args: [{ action: action || "get", key: key ?? null, value: value ?? null, type: t }],
  });
  const r = results[0]?.result || {};
  if (r.error) throw new Error(r.error);
  return r;
}

// ---- PDF export (CDP Page.printToPDF) ----

const PDF_FORMATS = {
  letter: { w: 8.5, h: 11 },
  a4: { w: 8.27, h: 11.69 },
  a3: { w: 11.69, h: 16.54 },
  a5: { w: 5.83, h: 8.27 },
  legal: { w: 8.5, h: 14 },
  tabloid: { w: 11, h: 17 },
};

async function handlePdf({ tabId, format, landscape, printBackground, displayHeaderFooter, headerTemplate, footerTemplate, scale }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);
  const fmt = PDF_FORMATS[String(format || "letter").toLowerCase()] || PDF_FORMATS.letter;
  const params = {
    landscape: !!landscape,
    printBackground: printBackground !== false,
    displayHeaderFooter: !!displayHeaderFooter,
    scale: scale || 1,
    paperWidth: fmt.w,
    paperHeight: fmt.h,
    marginTop: 0.4,
    marginBottom: 0.4,
    marginLeft: 0.4,
    marginRight: 0.4,
    preferCSSPageSize: false,
  };
  if (headerTemplate) params.headerTemplate = headerTemplate;
  if (footerTemplate) params.footerTemplate = footerTemplate;
  const result = await sendDebuggerCommand(tid, "Page.printToPDF", params);
  return { data: result.data, mimeType: "application/pdf" };
}

// ---- Set (browser settings: viewport/device/geo/offline/headers/media) ----

const DEVICE_PRESETS = {
  "desktop chrome": { width: 1280, height: 720, dsf: 1, mobile: false, touch: false, ua: null },
  "iphone 14": { width: 390, height: 844, dsf: 3, mobile: true, touch: true, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" },
  "iphone 13": { width: 390, height: 844, dsf: 3, mobile: true, touch: true, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1" },
  "pixel 5": { width: 393, height: 851, dsf: 2.75, mobile: true, touch: true, ua: "Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36" },
  "ipad pro": { width: 1024, height: 1366, dsf: 2, mobile: true, touch: true, ua: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" },
  "galaxy s21": { width: 360, height: 800, dsf: 3, mobile: true, touch: true, ua: "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36" },
};

async function handleSet({ property, width, height, deviceScaleFactor, isMobile, hasTouch, userAgent, deviceName, latitude, longitude, offline, headers, colorScheme, reducedMotion, tabId }) {
  const tid = tabId || (await getActiveTabId());
  await ensureDebugger(tid);
  const prop = (property || "viewport").toLowerCase();

  if (prop === "viewport" || prop === "window") {
    if (!width || !height) throw new Error("viewport requires width and height");
    await sendDebuggerCommand(tid, "Emulation.setDeviceMetricsOverride", {
      width: Number(width),
      height: Number(height),
      deviceScaleFactor: deviceScaleFactor || 1,
      mobile: !!isMobile,
    });
    if (hasTouch !== undefined) {
      await sendDebuggerCommand(tid, "Emulation.setTouchEmulationEnabled", { enabled: !!hasTouch });
    }
    return { tabId: tid, viewport: { width: Number(width), height: Number(height), deviceScaleFactor: deviceScaleFactor || 1, mobile: !!isMobile, touch: !!hasTouch } };
  }

  if (prop === "device") {
    const preset = DEVICE_PRESETS[String(deviceName || "").toLowerCase()];
    if (!preset) throw new Error("Unknown device: " + deviceName + ". Available: " + Object.keys(DEVICE_PRESETS).join(", "));
    await sendDebuggerCommand(tid, "Emulation.setDeviceMetricsOverride", { width: preset.width, height: preset.height, deviceScaleFactor: preset.dsf, mobile: preset.mobile });
    await sendDebuggerCommand(tid, "Emulation.setTouchEmulationEnabled", { enabled: preset.touch });
    if (preset.ua) await sendDebuggerCommand(tid, "Emulation.setUserAgentOverride", { userAgent: preset.ua });
    return { tabId: tid, device: String(deviceName), viewport: { width: preset.width, height: preset.height } };
  }

  if (prop === "geo" || prop === "geolocation") {
    if (latitude == null || longitude == null) throw new Error("geo requires latitude and longitude");
    await sendDebuggerCommand(tid, "Emulation.setGeolocationOverride", { latitude: Number(latitude), longitude: Number(longitude), accuracy: 1 });
    return { tabId: tid, geolocation: { latitude: Number(latitude), longitude: Number(longitude) } };
  }

  if (prop === "offline") {
    await ensureCdpDomain(tid, "Network");
    const off = !!offline;
    await sendDebuggerCommand(tid, "Network.emulateNetworkConditions", {
      offline: off,
      latency: 0,
      downloadThroughput: off ? 0 : -1,
      uploadThroughput: off ? 0 : -1,
    });
    return { tabId: tid, offline: off };
  }

  if (prop === "headers") {
    if (!headers || typeof headers !== "object") throw new Error("headers requires an object like {\"X-Key\": \"v\"}");
    await ensureCdpDomain(tid, "Network");
    await sendDebuggerCommand(tid, "Network.setExtraHTTPHeaders", { headers });
    return { tabId: tid, headers: Object.keys(headers) };
  }

  if (prop === "media") {
    const features = [];
    if (colorScheme) features.push({ name: "prefers-color-scheme", value: String(colorScheme) });
    if (reducedMotion) features.push({ name: "prefers-reduced-motion", value: String(reducedMotion) });
    if (features.length === 0) throw new Error("media requires colorScheme and/or reducedMotion");
    await sendDebuggerCommand(tid, "Emulation.setEmulatedMedia", { features });
    return { tabId: tid, media: features };
  }

  throw new Error("Unknown set property: " + property + ". Use viewport, device, geo, offline, headers, or media.");
}

// ---- Window management ----

async function handleWindow({ action, url, windowId }) {
  const act = action || "list";
  if (act === "list") {
    const wins = await chrome.windows.getAll({ populate: true });
    return {
      windows: wins.map((w) => ({
        id: w.id,
        focused: w.focused,
        type: w.type,
        tabs: (w.tabs || []).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })),
      })),
    };
  }
  if (act === "create") {
    const win = await chrome.windows.create({ url: url || undefined, focused: true });
    return { windowId: win.id, tabId: win.tabs?.[0]?.id ?? null, url: url || "" };
  }
  if (act === "close") {
    if (!windowId) throw new Error("windowId is required for close");
    await chrome.windows.remove(Number(windowId));
    return { closed: windowId };
  }
  throw new Error("Unknown window action: " + action + ". Use list, create, or close.");
}

// ---- Console / Errors / Network capture (CDP event ring buffers) ----

const consoleLogs = new Map();
const pageErrors = new Map();
const networkLogs = new Map();
const inFlightRequests = new Map();

function safeArgString(val, depth) {
  try {
    if (val === null || val === undefined) return String(val);
    if (typeof val === "string") return val.slice(0, 300);
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    if (val instanceof Error) return val.message.slice(0, 300);
    if (typeof val === "object") {
      if (depth > 2) return "[object]";
      const keys = Object.keys(val);
      if (keys.length === 0) return "{}";
      const parts = keys.slice(0, 8).map((k) => k + ": " + safeArgString(val[k], depth + 1));
      return "{" + parts.join(", ") + (keys.length > 8 ? ", ..." : "") + "}";
    }
    return String(val).slice(0, 300);
  } catch (e) { return "[unserializable]"; }
}

function summarizeConsoleArgs(args) {
  return (args || []).slice(0, 5).map((a) => safeArgString(a && a.value !== undefined ? a.value : a, 0)).join(" ").slice(0, 600);
}

function pushCapped(map, tabId, entry, cap) {
  let arr = map.get(tabId);
  if (!arr) { arr = []; map.set(tabId, arr); }
  arr.push(entry);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

async function handleConsole({ action, tabId, filter, types, clear }) {
  const tid = tabId || (await getActiveTabId());
  if (action === "clear") { consoleLogs.delete(tid); return { cleared: true }; }
  await ensureDebugger(tid);
  await ensureCdpDomain(tid, "Runtime");
  let logs = consoleLogs.get(tid) || [];
  if (Array.isArray(types) && types.length) logs = logs.filter((l) => types.includes(l.type));
  if (filter) logs = logs.filter((l) => l.text.toLowerCase().includes(String(filter).toLowerCase()));
  const captured = logs.length > 0;
  if (clear) consoleLogs.delete(tid);
  const out = logs.slice(-100);
  return {
    count: out.length,
    messages: out,
    note: captured ? "" : "Console capture starts from this call (Runtime domain just enabled) - reload the page to capture early messages.",
  };
}

async function handleErrors({ action, tabId, filter, clear }) {
  const tid = tabId || (await getActiveTabId());
  if (action === "clear") { pageErrors.delete(tid); return { cleared: true }; }
  await ensureDebugger(tid);
  await ensureCdpDomain(tid, "Runtime");
  let errors = pageErrors.get(tid) || [];
  if (filter) errors = errors.filter((e) => e.text.toLowerCase().includes(String(filter).toLowerCase()));
  if (clear) pageErrors.delete(tid);
  return { count: errors.length, errors: errors.slice(-50) };
}

async function handleNetwork({ action, tabId, filter }) {
  const tid = tabId || (await getActiveTabId());
  if (action === "clear") { networkLogs.delete(tid); inFlightRequests.delete(tid); return { cleared: true }; }
  await ensureDebugger(tid);
  await ensureCdpDomain(tid, "Network");
  let logs = networkLogs.get(tid) || [];
  if (filter) logs = logs.filter((l) => (l.url || "").toLowerCase().includes(String(filter).toLowerCase()));
  return { count: logs.length, requests: logs.slice(-200) };
}

// CDP event hooks for console/errors/network (called from chrome.debugger.onEvent)
function handleCaptureEvent(tabId, method, params) {
  if (method === "Runtime.consoleAPICalled") {
    pushCapped(consoleLogs, tabId, { type: params.type || "log", text: summarizeConsoleArgs(params.args), ts: Date.now() }, 100);
    return;
  }
  if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails || {};
    const ex = d.exception && d.exception.description ? d.exception.description : (d.text || "Unknown error");
    pushCapped(pageErrors, tabId, { text: String(ex).slice(0, 500), url: d.url || "", line: d.lineNumber != null ? d.lineNumber : null, column: d.columnNumber != null ? d.columnNumber : null, ts: Date.now() }, 50);
    return;
  }
  if (method === "Network.requestWillBeSent") {
    let m = inFlightRequests.get(tabId);
    if (!m) { m = new Map(); inFlightRequests.set(tabId, m); }
    m.set(params.requestId, { url: params.request ? params.request.url || "" : "", method: params.request ? params.request.method || "" : "", resourceType: params.type || "", startedAt: Date.now(), ts: Date.now() });
    if (m.size > 400) { const first = m.keys().next().value; m.delete(first); }
    return;
  }
  if (method === "Network.responseReceived") {
    const m = inFlightRequests.get(tabId);
    const rec = m && m.get(params.requestId);
    if (rec) {
      rec.status = params.response && params.response.status != null ? params.response.status : null;
      rec.mimeType = params.response ? params.response.mimeType || "" : "";
      rec.statusText = params.response ? params.response.statusText || "" : "";
    }
    return;
  }
  if (method === "Network.loadingFinished") {
    const m = inFlightRequests.get(tabId);
    const rec = m && m.get(params.requestId);
    if (rec) {
      rec.size = params.encodedDataLength != null ? params.encodedDataLength : null;
      rec.duration = Date.now() - rec.startedAt;
      pushCapped(networkLogs, tabId, rec, 200);
      m.delete(params.requestId);
    }
    return;
  }
  if (method === "Network.loadingFailed") {
    const m = inFlightRequests.get(tabId);
    const rec = m && m.get(params.requestId);
    if (rec) {
      rec.errorText = params.errorText || "failed";
      rec.duration = Date.now() - rec.startedAt;
      pushCapped(networkLogs, tabId, rec, 200);
      m.delete(params.requestId);
    }
    return;
  }
}

// ============================================================================
// Stealth Mode — CDP-free handlers using chrome.scripting
// ============================================================================

/**
 * Route commands through stealth handlers that NEVER touch chrome.debugger.
 * Protected sites detect CDP attachment itself, so avoiding ensureDebugger()
 * is the key to staying undetected. Handlers use chrome.scripting.executeScript
 * to inject DOM operations directly.
 */
async function dispatchStealthCommand(method, params) {
  // Warn if CDP was already attached on this tab (stealth may be ineffective)
  const tid = params.tabId || (await getActiveTabId());
  if (debuggerAttached.has(tid)) {
    console.warn(
      `[stealth] Tab ${tid} already has CDP attached — stealth may be ineffective. Use a fresh tab for full stealth.`,
    );
  }
  switch (method) {
    case "click":
      if (params.intercept_file_chooser)
        throw new Error("File chooser interception requires CDP — not available in stealth mode");
      return stealthClick(params);
    case "type":
      return stealthType(params);
    case "keypress":
      return stealthKeypress(params);
    case "scroll":
      return stealthScroll(params);
    case "execute":
      return stealthExecute(params);
    case "hover":
      return stealthHover(params);
    case "screenshot": {
      // Stealth screenshot: captureVisibleTab only (no CDP)
      if (params.tabId) await chrome.tabs.update(tid, { active: true });
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 60 });
      return { tabId: tid, dataUrl, width: null, height: null };
    }
    case "extract":
      if (params.mode === "accessibility") {
        throw new Error("Accessibility extraction requires CDP — not available in stealth mode");
      }
      return handleExtract(params);
    // Already CDP-free handlers — pass through directly
    case "navigate":
      return handleNavigate(params);
    case "tabs":
      return handleTabs(params);
    case "select":
      return handleSelect(params);
    case "wait_for":
      return handleWaitFor(params);
    case "cookies":
      return handleCookies(params);
    case "history":
      return handleHistory(params);
    default:
      throw new Error(`${method} is not available in stealth mode (requires CDP debugger)`);
  }
}

async function stealthClick({ selector, x, y, tabId, button, clickCount }) {
  const tid = tabId || (await getActiveTabId());
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (sel, cx, cy, btn, count) => {
      // Shadow DOM + iframe deep search
      function deepQuery(s, root) {
        const el = (root || document).querySelector(s);
        if (el) return el;
        for (const n of (root || document).querySelectorAll("*")) {
          if (n.shadowRoot) {
            const d = deepQuery(s, n.shadowRoot);
            if (d) return d;
          }
        }
        if (!root || root === document) {
          for (const iframe of document.querySelectorAll("iframe")) {
            try {
              if (iframe.contentDocument) {
                const m = iframe.contentDocument.querySelector(s);
                if (m) return m;
              }
            } catch {}
          }
        }
        return null;
      }

      let el;
      if (sel) {
        el = deepQuery(sel);
        if (!el) return { error: `Element not found: ${sel}` };
        // behavior: "instant" is synchronous in Chromium — no await needed
        if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(true);
        else el.scrollIntoView({ block: "center", behavior: "instant" });
      } else if (cx != null && cy != null) {
        el = document.elementFromPoint(cx, cy);
        if (!el) return { error: `No element at (${cx},${cy})` };
      } else {
        return { error: "Provide selector or x,y coordinates" };
      }

      const rect = el.getBoundingClientRect();
      const px = rect.x + rect.width / 2;
      const py = rect.y + rect.height / 2;
      const buttonNum = btn === "right" ? 2 : btn === "middle" ? 1 : 0;
      const shared = { bubbles: true, cancelable: true, clientX: px, clientY: py, button: buttonNum, view: window };
      const ptrBase = { ...shared, pointerId: 1, pointerType: "mouse" };

      if (btn === "right") {
        el.dispatchEvent(new PointerEvent("pointerdown", { ...ptrBase, buttons: 2 }));
        el.dispatchEvent(new MouseEvent("mousedown", { ...shared, buttons: 2 }));
        el.dispatchEvent(new PointerEvent("pointerup", { ...ptrBase, buttons: 0 }));
        el.dispatchEvent(new MouseEvent("mouseup", { ...shared, buttons: 0 }));
        el.dispatchEvent(new MouseEvent("contextmenu", { ...shared }));
      } else if (btn === "middle") {
        el.dispatchEvent(new PointerEvent("pointerdown", { ...ptrBase, buttons: 4 }));
        el.dispatchEvent(new MouseEvent("mousedown", { ...shared, buttons: 4 }));
        el.dispatchEvent(new PointerEvent("pointerup", { ...ptrBase, buttons: 0 }));
        el.dispatchEvent(new MouseEvent("mouseup", { ...shared, buttons: 0 }));
        el.dispatchEvent(new MouseEvent("click", { ...shared }));
      } else if (count >= 2) {
        for (let i = 0; i < count; i++) {
          el.dispatchEvent(new PointerEvent("pointerdown", { ...ptrBase, buttons: 1 }));
          el.dispatchEvent(new MouseEvent("mousedown", { ...shared, buttons: 1, detail: i + 1 }));
          el.dispatchEvent(new PointerEvent("pointerup", { ...ptrBase, buttons: 0 }));
          el.dispatchEvent(new MouseEvent("mouseup", { ...shared, buttons: 0, detail: i + 1 }));
          el.dispatchEvent(new MouseEvent("click", { ...shared, detail: i + 1 }));
          if (i === 1) el.dispatchEvent(new MouseEvent("dblclick", { ...shared, detail: 2 }));
        }
      } else {
        // Single click: synthetic mousedown/mouseup + trusted el.click()
        el.dispatchEvent(new PointerEvent("pointerdown", { ...ptrBase, buttons: 1 }));
        el.dispatchEvent(new MouseEvent("mousedown", { ...shared, buttons: 1 }));
        el.dispatchEvent(new PointerEvent("pointerup", { ...ptrBase, buttons: 0 }));
        el.dispatchEvent(new MouseEvent("mouseup", { ...shared, buttons: 0 }));
        el.click(); // isTrusted=true — note: coordinates will be (0,0), but most detectors only check isTrusted
      }

      return { x: px, y: py };
    },
    args: [selector || null, x ?? null, y ?? null, button || "left", clickCount || 1],
  });
  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  showActionCursor(tid, result.x, result.y);
  return { tabId: tid, element: selector || `(${x},${y})` };
}

async function stealthType({ text, selector, tabId, clearFirst, pressEnter }) {
  const tid = tabId || (await getActiveTabId());
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (sel, txt, clear, enter) => {
      // Shadow DOM + iframe deep search
      function deepQuery(s, root) {
        const el = (root || document).querySelector(s);
        if (el) return el;
        for (const n of (root || document).querySelectorAll("*")) {
          if (n.shadowRoot) {
            const d = deepQuery(s, n.shadowRoot);
            if (d) return d;
          }
        }
        if (!root || root === document) {
          for (const iframe of document.querySelectorAll("iframe")) {
            try {
              if (iframe.contentDocument) {
                const m = iframe.contentDocument.querySelector(s);
                if (m) return m;
              }
            } catch {}
          }
        }
        return null;
      }

      const el = sel ? deepQuery(sel) : document.activeElement;
      if (sel && !el) return { error: `Element not found: ${sel}` };
      if (!el) return { error: "No focused element" };

      if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(true);
      else el.scrollIntoView({ block: "center", behavior: "instant" });
      el.focus();

      const isTypeable = el.tagName === "INPUT" || el.tagName === "TEXTAREA";

      if (isTypeable) {
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

        if (clear) {
          const prev = el.value;
          if (nativeSetter) nativeSetter.call(el, "");
          else el.value = "";
          // Reset React's _valueTracker so React detects the change
          const tracker = el._valueTracker;
          if (tracker) tracker.setValue(prev);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        }

        const prevValue = el.value;
        const newValue = clear ? txt : el.value + txt;
        if (nativeSetter) nativeSetter.call(el, newValue);
        else el.value = newValue;
        // Reset React's _valueTracker so React detects the change
        const tracker = el._valueTracker;
        if (tracker) tracker.setValue(prevValue);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: txt }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        if (clear) {
          document.execCommand("selectAll", false, null);
          document.execCommand("delete", false, null);
        }
        document.execCommand("insertText", false, txt);
      } else {
        return { error: `Element <${el.tagName.toLowerCase()}> is not a typeable field` };
      }

      if (enter) {
        const enterOpts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        const kd = new KeyboardEvent("keydown", enterOpts);
        el.dispatchEvent(kd);
        el.dispatchEvent(new KeyboardEvent("keypress", enterOpts));
        el.dispatchEvent(new KeyboardEvent("keyup", enterOpts));
        if (!kd.defaultPrevented) {
          const form = el.closest("form");
          if (form) {
            if (form.requestSubmit) form.requestSubmit();
            else form.submit();
          }
        }
      }

      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    },
    args: [selector || null, text, !!clearFirst, !!pressEnter],
  });
  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  if (result?.x != null) showActionCursor(tid, result.x, result.y);
  return { tabId: tid, element: selector || "(focused)" };
}

async function stealthKeypress({ key, modifiers, tabId }) {
  const tid = tabId || (await getActiveTabId());
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (k, mods) => {
      try {
        const el = document.activeElement || document.body;
        const keyMap = {
          enter: "Enter",
          tab: "Tab",
          escape: "Escape",
          backspace: "Backspace",
          delete: "Delete",
          space: " ",
          arrowup: "ArrowUp",
          arrowdown: "ArrowDown",
          arrowleft: "ArrowLeft",
          arrowright: "ArrowRight",
          home: "Home",
          end: "End",
          pageup: "PageUp",
          pagedown: "PageDown",
        };
        const mapped = keyMap[k.toLowerCase()] || k;
        const codeMap = { " ": "Space" };
        const code =
          codeMap[mapped] ||
          (mapped.length === 1
            ? /^[a-z]$/i.test(mapped)
              ? `Key${mapped.toUpperCase()}`
              : /^[0-9]$/.test(mapped)
                ? `Digit${mapped}`
                : mapped
            : mapped);
        const opts = {
          key: mapped,
          code,
          bubbles: true,
          cancelable: true,
          ctrlKey: mods.includes("ctrl"),
          altKey: mods.includes("alt"),
          shiftKey: mods.includes("shift"),
          metaKey: mods.includes("meta"),
        };
        el.dispatchEvent(new KeyboardEvent("keydown", opts));
        // keypress only fires for printable characters (per UI Events spec)
        if (mapped.length === 1 || mapped === "Enter") {
          el.dispatchEvent(new KeyboardEvent("keypress", opts));
        }
        el.dispatchEvent(new KeyboardEvent("keyup", opts));

        // Imperative side-effects for common keys (JS dispatched events don't trigger defaults)
        if (mapped === "Tab" && !mods.includes("ctrl") && !mods.includes("alt")) {
          const focusables = [
            ...document.querySelectorAll(
              'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          ];
          const idx = focusables.indexOf(el);
          const next = mods.includes("shift") ? focusables[idx - 1] : focusables[idx + 1];
          if (next) next.focus();
        } else if (mapped === "Backspace" && "selectionStart" in el) {
          const start = el.selectionStart;
          if (start > 0) {
            el.value = el.value.slice(0, start - 1) + el.value.slice(el.selectionEnd);
            el.selectionStart = el.selectionEnd = start - 1;
            el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
          }
        } else if (mapped === "Escape") {
          el.blur();
        }
        return { ok: true };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },
    args: [key, modifiers || []],
  });
  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  return { tabId: tid, key, modifiers: modifiers || [] };
}

async function stealthScroll({ direction, amount, selector, tabId }) {
  const tid = tabId || (await getActiveTabId());
  const dist = amount || 300;
  let deltaX = 0;
  let deltaY = 0;
  switch (direction) {
    case "up":
      deltaY = -dist;
      break;
    case "down":
      deltaY = dist;
      break;
    case "left":
      deltaX = -dist;
      break;
    case "right":
      deltaX = dist;
      break;
    default:
      deltaY = dist;
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (sel, dx, dy) => {
      if (sel) {
        const el = document.querySelector(sel);
        if (!el) return { error: `Element not found: ${sel}` };
        // Walk up to find nearest scrollable ancestor
        let target = el;
        while (target && target !== document.documentElement) {
          const s = getComputedStyle(target);
          if (
            (dy !== 0 &&
              (s.overflowY === "auto" || s.overflowY === "scroll") &&
              target.scrollHeight > target.clientHeight) ||
            (dx !== 0 &&
              (s.overflowX === "auto" || s.overflowX === "scroll") &&
              target.scrollWidth > target.clientWidth)
          )
            break;
          target = target.parentElement;
        }
        (target || window).scrollBy(dx, dy);
      } else {
        window.scrollBy(dx, dy);
      }
      return { ok: true };
    },
    args: [selector || null, deltaX, deltaY],
  });
  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  await new Promise((r) => setTimeout(r, 150));
  return { tabId: tid, direction: direction || "down", amount: dist };
}

async function stealthExecute({ code, tabId, frameId }) {
  const tid = tabId || (await getActiveTabId());
  const target = { tabId: tid };
  if (frameId) {
    const fid = parseInt(frameId, 10);
    if (isNaN(fid))
      throw new Error(
        "Stealth mode requires Chrome frame IDs (integers). The 'frames' command is not available in stealth mode.",
      );
    target.frameIds = [fid];
  }
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error("Stealth execute timed out (30s)")), 30000);
  });
  try {
    const exec = chrome.scripting.executeScript({
      target,
      world: "MAIN",
      func: async (c) => {
        try {
          const result = await (0, eval)(c); // eslint-disable-line no-eval -- intentional indirect eval for global scope
          // Guard against non-cloneable return values (DOM elements, functions, etc.)
          try {
            structuredClone(result);
            return { value: result };
          } catch {}
          try {
            return { value: JSON.parse(JSON.stringify(result)) };
          } catch {}
          return { value: String(result) };
        } catch (e) {
          const msg = e.message || String(e);
          if (msg.includes("unsafe-eval") || msg.includes("Content Security Policy")) {
            return {
              error: `CSP blocks eval() on this page. Remove stealth:true to use CDP (which bypasses CSP). Original: ${msg}`,
            };
          }
          return { error: msg };
        }
      },
      args: [code],
    });
    const results = await Promise.race([exec, timeout]);
    const result = results[0]?.result;
    if (result?.error) throw new Error(result.error);
    return { value: result?.value };
  } finally {
    clearTimeout(timer);
  }
}

async function stealthHover({ selector, x, y, tabId }) {
  const tid = tabId || (await getActiveTabId());
  if (!selector && (x === undefined || y === undefined)) {
    throw new Error("Stealth hover requires either 'selector' or both 'x' and 'y' coordinates");
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (sel, hx, hy) => {
      // Shadow DOM + iframe deep search
      function deepQuery(s, root) {
        const el = (root || document).querySelector(s);
        if (el) return el;
        for (const n of (root || document).querySelectorAll("*")) {
          if (n.shadowRoot) {
            const d = deepQuery(s, n.shadowRoot);
            if (d) return d;
          }
        }
        if (!root || root === document) {
          for (const iframe of document.querySelectorAll("iframe")) {
            try {
              if (iframe.contentDocument) {
                const m = iframe.contentDocument.querySelector(s);
                if (m) return m;
              }
            } catch {}
          }
        }
        return null;
      }

      let el;
      if (sel) {
        el = deepQuery(sel);
        if (!el) return { error: `Element not found: ${sel}` };
      } else {
        el = document.elementFromPoint(hx, hy);
        if (!el) return { error: `No element at (${hx},${hy})` };
      }
      const rect = el.getBoundingClientRect();
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      // Hover event sequence — NOTE: CSS :hover pseudo-class will NOT activate (only JS listeners fire)
      el.dispatchEvent(new MouseEvent("mouseenter", { clientX: cx, clientY: cy, bubbles: false }));
      el.dispatchEvent(new MouseEvent("mouseover", { clientX: cx, clientY: cy, bubbles: true }));
      el.dispatchEvent(new MouseEvent("mousemove", { clientX: cx, clientY: cy, bubbles: true }));
      return { x: cx, y: cy };
    },
    args: [selector || null, x ?? null, y ?? null],
  });
  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  showActionCursor(tid, result.x, result.y);
  return { tabId: tid, element: selector || `(${x},${y})` };
}

// ============================================================================
// Debugger Helpers
// ============================================================================

/**
 * Attach debugger to a tab (if not already attached).
 *
 * Stealth: This no longer eagerly enables Runtime or Fetch domains.
 * Page.enable is kept eager because dialog detection (Page.javascriptDialogOpening)
 * must capture events regardless of which handler triggers the dialog.
 * Each handler calls ensureCdpDomain() for only the domains it actually needs.
 * This minimises the CDP detection surface:
 *  - Input.dispatch*, DOM.*, Accessibility.* are stateless — no .enable() needed
 *  - Runtime.enable is the riskiest (creates execution-context tracking artifacts)
 *  - Fetch.enable is moderate risk (intercepts all HTTP requests)
 *  - Page.enable is moderate risk but required for dialog/file-chooser event capture
 */
async function ensureDebugger(tabId) {
  if (debuggerAttached.has(tabId)) return;
  // Serialize concurrent attachment attempts for same tab
  if (debuggerPending.has(tabId)) return debuggerPending.get(tabId);

  const promise = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (err) {
      // Handle SW restart where debugger is already attached from prior lifecycle
      if (!err.message?.includes("Already attached")) throw err;
    }
    debuggerAttached.add(tabId);
    // Page.enable kept eager — dialog/file-chooser events must be captured
    // regardless of which handler the agent calls first
    await sendDebuggerCommand(tabId, "Page.enable").catch(() => {});
    let enabled = cdpDomainEnabled.get(tabId);
    if (!enabled) {
      enabled = new Set();
      cdpDomainEnabled.set(tabId, enabled);
    }
    enabled.add("Page");
    // Auto-accept downloads (suppresses Chrome's "Keep/Discard" confirmation popup)
    // Browser.setDownloadBehavior is stateless — no .enable() needed
    await sendDebuggerCommand(tabId, "Browser.setDownloadBehavior", {
      behavior: "allow",
      eventsEnabled: true,
    }).catch(() => {});
    // Suppress Chrome's Downloads bubble/shelf UI so it doesn't obscure page content
    chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});
    // Note: File chooser interception is NOT enabled globally.
    // It's enabled on-demand via handleClick({ intercept_file_chooser: true })
    // to avoid intercepting save/download dialogs (e.g., showSaveFilePicker).
  })();

  debuggerPending.set(tabId, promise);
  try {
    await promise;
  } finally {
    debuggerPending.delete(tabId);
  }
}

/**
 * Lazily enable a CDP domain for a tab.
 * Only sends the .enable() command once per tab per domain.
 * Cleaned up automatically on debugger detach.
 */
async function ensureCdpDomain(tabId, domain, params) {
  let enabled = cdpDomainEnabled.get(tabId);
  if (!enabled) {
    enabled = new Set();
    cdpDomainEnabled.set(tabId, enabled);
  }
  if (enabled.has(domain)) return;
  await sendDebuggerCommand(tabId, `${domain}.enable`, params);
  enabled.add(domain);
}

function sendDebuggerCommand(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function getElementCenter(tabId, selector) {
  const doc = await sendDebuggerCommand(tabId, "DOM.getDocument");
  const node = await sendDebuggerCommand(tabId, "DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!node.nodeId) throw new Error(`Element not found: ${selector}`);

  // Ensure element is in viewport before reading coordinates
  await sendDebuggerCommand(tabId, "DOM.scrollIntoViewIfNeeded", { nodeId: node.nodeId }).catch(() => {});

  const box = await sendDebuggerCommand(tabId, "DOM.getBoxModel", { nodeId: node.nodeId });
  const quad = box.model.content;
  // Average all 4 corners for correct center even with CSS transforms
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  };
}

/**
 * Deep element query — pierces shadow DOM and same-origin iframes.
 * Returns viewport-relative coordinates of the element center.
 */
async function resolveElementCoords(tabId, selector) {
  await ensureDebugger(tabId);
  // Runtime.evaluate needs Runtime domain enabled
  await ensureCdpDomain(tabId, "Runtime");
  const result = await sendDebuggerCommand(tabId, "Runtime.evaluate", {
    expression: `(function() {
      function q(s) {
        let e = document.querySelector(s);
        if (e) return e;
        function f(r) {
          for (const n of r.querySelectorAll("*")) {
            if (n.shadowRoot) {
              const m = n.shadowRoot.querySelector(s);
              if (m) return m;
              const d = f(n.shadowRoot);
              if (d) return d;
            }
          }
          return null;
        }
        e = f(document);
        if (e) return e;
        for (const i of document.querySelectorAll("iframe")) {
          try {
            if (i.contentDocument) {
              const m = i.contentDocument.querySelector(s);
              if (m) return m;
            }
          } catch {}
        }
        return null;
      }
      const e = q(${JSON.stringify(selector)});
      if (!e) return null;
      const r = e.getBoundingClientRect();
      let x = r.x + r.width / 2;
      let y = r.y + r.height / 2;
      let p = e.ownerDocument.defaultView?.frameElement;
      while (p) {
        const pr = p.getBoundingClientRect();
        x += pr.x;
        y += pr.y;
        p = p.ownerDocument.defaultView?.frameElement;
      }
      return { x, y };
    })()`,
    returnByValue: true,
  });
  if (!result.result?.value) throw new Error(`Element not found (deep): ${selector}`);
  return result.result.value;
}

// ============================================================================
// Agent Activity Indicator
// ============================================================================

async function showAgentIndicator(tabId) {
  const count = (activeTabCommands.get(tabId) || 0) + 1;
  activeTabCommands.set(tabId, count);
  if (count === 1) {
    // Ensure content script is injected, then send session prefix & show overlay
    await chrome.scripting
      .executeScript({
        target: { tabId },
        files: ["src/content-script.js"],
      })
      .catch(() => {}); // Already injected or restricted page
    // Send session-random prefix for DOM identifier stealth, then show overlay
    await chrome.tabs.sendMessage(tabId, { type: "set-prefix", prefix: SESSION_PREFIX }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { type: "show-agent-overlay" }).catch(() => {});
  }
}

function hideAgentIndicator(tabId) {
  const count = Math.max(0, (activeTabCommands.get(tabId) || 0) - 1);
  activeTabCommands.set(tabId, count);
  if (count === 0) {
    activeTabCommands.delete(tabId);
    chrome.tabs.sendMessage(tabId, { type: "hide-agent-overlay" }).catch(() => {});
  }
}

/** Show animated Browser MCP cursor at action position (fire-and-forget). */
function showActionCursor(tabId, x, y) {
  if (x === undefined || y === undefined) return;
  chrome.tabs.sendMessage(tabId, { type: "show-action-cursor", x, y }).catch(() => {});
}

/** Show persistent Browser MCP activity cursor during long-running operations (download/upload). */
function showActivityCursor(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "show-activity-cursor" }).catch(() => {});
}

/** Hide persistent Browser MCP activity cursor when operation completes/fails. */
function hideActivityCursor(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "hide-activity-cursor" }).catch(() => {});
}

/** Check if a download was triggered on this tab within the last N ms. Returns download info or null. */
function consumeRecentDownload(tabId, withinMs = 3000) {
  const cutoff = Date.now() - withinMs;
  const idx = recentDownloads.findIndex((d) => d.tabId === tabId && d.timestamp >= cutoff);
  if (idx === -1) return null;
  return recentDownloads.splice(idx, 1)[0];
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab.id;
}

function waitForTab(tabId, event) {
  return new Promise(async (resolve) => {
    const target = "complete"; // Both "load" and "domcontentloaded" wait for full load

    // Check if already in desired state (avoids race condition)
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === target) {
        resolve();
        return;
      }
    } catch {
      resolve();
      return;
    }

    function listener(tid, changeInfo) {
      if (tid === tabId && changeInfo.status === target) {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
}

// ============================================================================
// Initialization
// ============================================================================

// Ensure offscreen doc exists on every SW activation (covers restarts)
ensureOffscreen().catch(() => {});

// Re-sync toolbar icon after SW restarts (offscreen may already be connected).
setTimeout(() => {
  try {
    chrome.runtime.sendMessage({ type: "get-status" }, (resp) => {
      if (!chrome.runtime.lastError && resp) setActionIcon(!!resp.connected);
    });
  } catch {}
}, 500);

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[bmcp] Browser extension installed");
  await ensureOffscreen();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreen();
});

// Clean up all state on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerAttached.delete(tabId);
  debuggerPending.delete(tabId);
  cdpDomainEnabled.delete(tabId);
  activeTabCommands.delete(tabId);
  pendingDialogs.delete(tabId);
  pendingFileChoosers.delete(tabId);
  tabEmulation.delete(tabId);
  // Clean up per-requestId auth entries for this tab
  const reqIds = pendingAuthByTab.get(tabId);
  if (reqIds) {
    for (const rid of reqIds) pendingAuth.delete(rid);
    pendingAuthByTab.delete(tabId);
  }
  for (const key of frameContexts.keys()) {
    if (key.startsWith(`${tabId}:`)) frameContexts.delete(key);
  }
  // Remove stale download records for closed tab
  for (let i = recentDownloads.length - 1; i >= 0; i--) {
    if (recentDownloads[i].tabId === tabId) recentDownloads.splice(i, 1);
  }
  // Clear console/errors/network capture buffers
  consoleLogs.delete(tabId);
  pageErrors.delete(tabId);
  networkLogs.delete(tabId);
  inFlightRequests.delete(tabId);
});
