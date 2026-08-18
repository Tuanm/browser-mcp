/**
 * Content Script — injected into every page.
 *
 * Provides:
 * 1. Agent activity indicator (glowing border overlay using Browser MCP primary color)
 * 2. Visual feedback for element interactions (highlight)
 * 3. DOM utility helpers callable from service worker
 *
 * Stealth: All DOM element IDs, CSS animation names, and class names use a
 * session-random prefix (received from service worker) to prevent anti-bot
 * fingerprinting via known identifier patterns.
 */

// Session-random prefix for all injected DOM identifiers.
// Generated once per service worker lifecycle and passed via message.
// Falls back to a random prefix if the content script is injected before
// the service worker sends it (shouldn't happen in practice).
let _pfx = "_x" + Math.random().toString(36).slice(2, 8);

// Avoid re-injection. Content scripts run in Chrome's isolated world, so this
// property is invisible to page JavaScript. Key is deliberately non-descriptive.
const _guard = Symbol.for("_x7cs");
if (!window[_guard]) {
  window[_guard] = true;

  // ==========================================================================
  // Agent Activity Overlay — glowing border when agent is working in this tab
  // ==========================================================================

  let overlayCount = 0;
  let overlayEl = null;
  let styleEl = null;
  let hideTimer = null;
  let fadeTimer = null;
  let autoHideTimer = null;

  function showAgentOverlay() {
    overlayCount++;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (fadeTimer) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
    // Auto-hide after 5s in case agent finishes without sending hide signal
    if (autoHideTimer) clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(() => {
      autoHideTimer = null;
      overlayCount = 0;
      hideAgentOverlay();
    }, 5000);
    if (overlayEl) {
      overlayEl.style.opacity = "1"; // restore if mid-fade
      return;
    }

    styleEl = document.createElement("style");
    styleEl.id = `${_pfx}-overlay-style`;
    styleEl.textContent = `
      @keyframes ${_pfx}-glow {
        0%, 100% {
          box-shadow: inset 0 0 6px 2px rgba(217, 120, 83, 0.3);
        }
        50% {
          box-shadow: inset 0 0 24px 6px rgba(217, 120, 83, 0.7);
        }
      }
      @keyframes ${_pfx}-glow-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
    `;
    (document.head || document.documentElement).appendChild(styleEl);

    overlayEl = document.createElement("div");
    overlayEl.id = `${_pfx}-agent-overlay`;
    Object.assign(overlayEl.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      bottom: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      border: "none",
      animation: `${_pfx}-glow 2s ease-in-out infinite, ${_pfx}-glow-in 0.3s ease-out`,
      transition: "opacity 0.3s ease-out",
    });
    document.documentElement.appendChild(overlayEl);
  }

  function hideAgentOverlay() {
    overlayCount = Math.max(0, overlayCount - 1);
    if (overlayCount > 0 || !overlayEl) return;
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }

    // Brief delay before fade-out for smoother visual
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (overlayEl) {
        overlayEl.style.opacity = "0";
        fadeTimer = setTimeout(() => {
          overlayEl?.remove();
          overlayEl = null;
          styleEl?.remove();
          styleEl = null;
          fadeTimer = null;
        }, 300);
      }
    }, 500);
  }

  // ==========================================================================
  // Agent Action Cursor — animated Browser MCP icon at action positions
  // ==========================================================================

  function cursorSvg() {
    return `<svg width="24" height="24" viewBox="0 0 66 52" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="13" width="6" height="13" fill="#d5826a"/>
    <rect x="60" y="13" width="6" height="13" fill="#d5826a"/>
    <rect class="${_pfx}-leg-l1" x="6" y="39" width="6" height="13" fill="#d5826a"/>
    <rect class="${_pfx}-leg-l2" x="18" y="39" width="6" height="13" fill="#d5826a"/>
    <rect class="${_pfx}-leg-r1" x="42" y="39" width="6" height="13" fill="#d5826a"/>
    <rect class="${_pfx}-leg-r2" x="54" y="39" width="6" height="13" fill="#d5826a"/>
    <rect x="6" y="0" width="54" height="39" fill="#d5826a"/>
    <rect x="12" y="13" width="6" height="6.5" fill="#222"/>
    <rect x="48" y="13" width="6" height="6.5" fill="#222"/>
  </svg>`;
  }

  let cursorStyleEl = null;

  const MAX_CURSORS = 5;
  let activeCursors = 0;

  function ensureCursorStyles() {
    if (cursorStyleEl && cursorStyleEl.isConnected) return;
    cursorStyleEl = document.createElement("style");
    cursorStyleEl.id = `${_pfx}-cursor-style`;
    cursorStyleEl.textContent = `
      @keyframes ${_pfx}-leg-run-1 {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-3px); }
      }
      @keyframes ${_pfx}-leg-run-2 {
        0%, 100% { transform: translateY(-3px); }
        50% { transform: translateY(0); }
      }
      @keyframes ${_pfx}-cursor-pop {
        0% { transform: translate(-50%, -50%) scale(0); opacity: 1; }
        15% { transform: translate(-50%, -50%) scale(1.3); opacity: 1; }
        30% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
        85% { transform: translate(-50%, -50%) scale(1); opacity: 0.9; }
        100% { transform: translate(-50%, -50%) scale(0.5); opacity: 0; }
      }
      .${_pfx}-action-cursor {
        position: fixed;
        z-index: 2147483647;
        pointer-events: none;
        animation: ${_pfx}-cursor-pop 0.7s ease-out forwards;
        filter: drop-shadow(0 1px 3px rgba(0,0,0,0.3));
      }
      .${_pfx}-action-cursor svg {
        display: block;
      }
      .${_pfx}-action-cursor .${_pfx}-leg-l1,
      .${_pfx}-action-cursor .${_pfx}-leg-r2 {
        transform-origin: center top;
        animation: ${_pfx}-leg-run-1 0.12s ease-in-out infinite;
      }
      .${_pfx}-action-cursor .${_pfx}-leg-l2,
      .${_pfx}-action-cursor .${_pfx}-leg-r1 {
        transform-origin: center top;
        animation: ${_pfx}-leg-run-2 0.12s ease-in-out infinite;
      }
    `;
    (document.head || document.documentElement).appendChild(cursorStyleEl);
  }

  function showActionCursor(x, y) {
    if (activeCursors >= MAX_CURSORS) return;
    try {
      ensureCursorStyles();
      const cursor = document.createElement("div");
      cursor.className = `${_pfx}-action-cursor`;
      cursor.innerHTML = cursorSvg();
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
      (document.body || document.documentElement).appendChild(cursor);
      activeCursors++;
      setTimeout(() => {
        cursor.remove();
        activeCursors--;
      }, 750);
    } catch {
      // Ignore errors on restricted pages
    }
  }

  // ==========================================================================
  // Persistent Activity Cursor — Browser MCP icon that stays during long operations
  // ==========================================================================

  let activityCursorEl = null;

  function showActivityCursor() {
    if (activityCursorEl) return;
    try {
      ensureCursorStyles();
      activityCursorEl = document.createElement("div");
      activityCursorEl.id = `${_pfx}-activity-cursor`;
      activityCursorEl.innerHTML = cursorSvg();
      Object.assign(activityCursorEl.style, {
        position: "fixed",
        bottom: "24px",
        right: "24px",
        zIndex: "2147483647",
        pointerEvents: "none",
        filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.35))",
        animation: `${_pfx}-cursor-bounce 1s ease-in-out infinite`,
        transition: "opacity 0.3s ease-out",
      });
      // Add bounce animation if not already present
      let bounceStyle = document.getElementById(`${_pfx}-bounce-style`);
      if (!bounceStyle) {
        bounceStyle = document.createElement("style");
        bounceStyle.id = `${_pfx}-bounce-style`;
        bounceStyle.textContent = `
          @keyframes ${_pfx}-cursor-bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-6px); }
          }
          #${_pfx}-activity-cursor svg { display: block; width: 32px; height: 32px; }
          #${_pfx}-activity-cursor .${_pfx}-leg-l1,
          #${_pfx}-activity-cursor .${_pfx}-leg-r2 {
            transform-origin: center top;
            animation: ${_pfx}-leg-run-1 0.12s ease-in-out infinite;
          }
          #${_pfx}-activity-cursor .${_pfx}-leg-l2,
          #${_pfx}-activity-cursor .${_pfx}-leg-r1 {
            transform-origin: center top;
            animation: ${_pfx}-leg-run-2 0.12s ease-in-out infinite;
          }
        `;
        (document.head || document.documentElement).appendChild(bounceStyle);
      }
      (document.body || document.documentElement).appendChild(activityCursorEl);
    } catch {
      // Ignore errors on restricted pages
    }
  }

  function hideActivityCursor() {
    if (!activityCursorEl) return;
    activityCursorEl.style.opacity = "0";
    const el = activityCursorEl;
    activityCursorEl = null;
    setTimeout(() => el.remove(), 300);
  }

  // ==========================================================================
  // Message Handlers
  // ==========================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "set-prefix") {
      // Receive session prefix from service worker (stealth DOM identifiers)
      const oldPfx = _pfx;
      _pfx = message.prefix;
      // Clean up any DOM elements created with the old/fallback prefix
      if (oldPfx !== _pfx) {
        for (const id of [
          `${oldPfx}-overlay-style`,
          `${oldPfx}-agent-overlay`,
          `${oldPfx}-cursor-style`,
          `${oldPfx}-bounce-style`,
          `${oldPfx}-activity-cursor`,
        ]) {
          document.getElementById(id)?.remove();
        }
        overlayEl = null;
        styleEl = null;
        cursorStyleEl = null;
        activityCursorEl = null;
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        if (fadeTimer) {
          clearTimeout(fadeTimer);
          fadeTimer = null;
        }
        if (autoHideTimer) {
          clearTimeout(autoHideTimer);
          autoHideTimer = null;
        }
        overlayCount = 0;
        activeCursors = 0;
      }
      sendResponse({ ok: true });
    } else if (message.type === "show-agent-overlay") {
      showAgentOverlay();
      sendResponse({ ok: true });
    } else if (message.type === "hide-agent-overlay") {
      hideAgentOverlay();
      sendResponse({ ok: true });
    } else if (message.type === "highlight-element") {
      highlightElement(message.selector, message.duration || 2000);
      sendResponse({ ok: true });
    } else if (message.type === "show-action-cursor") {
      showActionCursor(message.x, message.y);
      sendResponse({ ok: true });
    } else if (message.type === "show-activity-cursor") {
      showActivityCursor();
      sendResponse({ ok: true });
    } else if (message.type === "hide-activity-cursor") {
      hideActivityCursor();
      sendResponse({ ok: true });
    }
    return false;
  });

  // ==========================================================================
  // Element Highlighting
  // ==========================================================================

  function highlightElement(selector, duration) {
    try {
      const el = document.querySelector(selector);
      if (!el) return;

      const overlay = document.createElement("div");
      const rect = el.getBoundingClientRect();
      Object.assign(overlay.style, {
        position: "fixed",
        left: `${rect.left - 2}px`,
        top: `${rect.top - 2}px`,
        width: `${rect.width + 4}px`,
        height: `${rect.height + 4}px`,
        border: "2px solid #D97853",
        borderRadius: "3px",
        backgroundColor: "rgba(217, 120, 83, 0.1)",
        zIndex: "2147483647",
        pointerEvents: "none",
        transition: "opacity 0.3s",
      });

      (document.body || document.documentElement).appendChild(overlay);

      setTimeout(() => {
        overlay.style.opacity = "0";
        setTimeout(() => overlay.remove(), 300);
      }, duration);
    } catch {
      // Ignore errors
    }
  }
}
