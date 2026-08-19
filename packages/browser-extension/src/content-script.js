/**
 * Content Script - injected into every page (isolated world).
 *
 * Provides:
 * 1. Agent activity indicator (glowing border overlay while an agent command runs)
 * 2. Black MCP-mark action cursor with box shadow at interaction positions
 * 3. Element highlight for highlight
 *
 * Stealth: all injected DOM ids/classes/animation names use a session-random
 * prefix (received from the service worker) to avoid detectable patterns.
 */

// Re-injection guard. chrome.scripting.executeScript on an already-injected tab
// must be a clean no-op, so EVERYTHING lives inside the guard - nothing is
// declared at top level.
if (!window[Symbol.for("_x7cs")]) {
  window[Symbol.for("_x7cs")] = true;

  // Session-random prefix for all injected DOM identifiers.
  let _pfx = "_x" + Math.random().toString(36).slice(2, 8);

  // ========================================================================
  // Agent Activity Overlay - glowing border while the agent is working
  // ========================================================================

  let overlayCount = 0;
  let overlayEl = null;
  let styleEl = null;
  let hideTimer = null;
  let fadeTimer = null;
  let autoHideTimer = null;

  function showAgentOverlay() {
    overlayCount++;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    if (autoHideTimer) clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(() => { autoHideTimer = null; overlayCount = 0; hideAgentOverlay(); }, 5000);
    if (overlayEl) { overlayEl.style.opacity = "1"; return; }

    styleEl = document.createElement("style");
    styleEl.id = `${_pfx}-overlay-style`;
    styleEl.textContent = `
      @keyframes ${_pfx}-glow {
        0%, 100% { box-shadow: inset 0 0 6px 2px rgba(0,0,0,0.25); }
        50% { box-shadow: inset 0 0 24px 6px rgba(0,0,0,0.45); }
      }
      @keyframes ${_pfx}-glow-in { from { opacity: 0; } to { opacity: 1; } }
    `;
    (document.head || document.documentElement).appendChild(styleEl);

    overlayEl = document.createElement("div");
    overlayEl.id = `${_pfx}-agent-overlay`;
    Object.assign(overlayEl.style, {
      position: "fixed", top: "0", left: "0", right: "0", bottom: "0",
      zIndex: "2147483647", pointerEvents: "none", border: "none",
      animation: `${_pfx}-glow 2s ease-in-out infinite, ${_pfx}-glow-in 0.3s ease-out`,
      transition: "opacity 0.3s ease-out",
    });
    document.documentElement.appendChild(overlayEl);
  }

  function hideAgentOverlay() {
    overlayCount = Math.max(0, overlayCount - 1);
    if (overlayCount > 0 || !overlayEl) return;
    if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (overlayEl) {
        overlayEl.style.opacity = "0";
        fadeTimer = setTimeout(() => {
          if (overlayEl) overlayEl.remove();
          if (styleEl) styleEl.remove();
          overlayEl = null; styleEl = null; fadeTimer = null;
        }, 300);
      }
    }, 500);
  }

  // ========================================================================
  // Agent Action Cursor - mouse pointer shown at the interaction position
  // ========================================================================

  // Real mouse pointer (black arrow, white outline, drop shadow) so the agent's
  // interaction looks like an actual mouse cursor, not a logo.
  const MOUSE_POINTER_PATH = "M6.2 1.9a1 1 0 01.8.26L22.6 15.5a1 1 0 01-.55 1.76l-6.6.36-3.2 7.2a1 1 0 01-1.9-.2l-3.2-9.6-4.4 4.9a1 1 0 01-1.7-.66V2.9a1 1 0 011-1z";

  function cursorSvg(size) {
    return `<svg width="${size || 24}" height="${size || 24}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round" d="${MOUSE_POINTER_PATH}"/>
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
      @keyframes ${_pfx}-cursor-pop {
        0% { transform: scale(0); opacity: 1; }
        15% { transform: scale(1.25); opacity: 1; }
        30% { transform: scale(1); opacity: 1; }
        85% { transform: scale(1); opacity: 0.9; }
        100% { transform: scale(0.55); opacity: 0; }
      }
      .${_pfx}-action-cursor {
        position: fixed;
        z-index: 2147483647;
        pointer-events: none;
        animation: ${_pfx}-cursor-pop 0.7s ease-out forwards;
        transform-origin: 6px 2px; /* arrow tip */
        filter: drop-shadow(0 2px 3px rgba(0,0,0,0.35));
      }
      .${_pfx}-action-cursor svg {
        display: block;
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
      cursor.innerHTML = cursorSvg(24);
      // Place the arrow tip at the action point (tip at 6,2 in the 24px svg).
      cursor.style.left = `${x - 6}px`;
      cursor.style.top = `${y - 2}px`;
      (document.body || document.documentElement).appendChild(cursor);
      activeCursors++;
      setTimeout(() => { cursor.remove(); activeCursors--; }, 750);
    } catch {
      // Ignore errors on restricted pages
    }
  }

  // ========================================================================
  // Persistent Activity Cursor - mouse pointer that stays during long operations
  // ========================================================================

  let activityCursorEl = null;

  function showActivityCursor() {
    if (activityCursorEl) return;
    try {
      ensureCursorStyles();
      activityCursorEl = document.createElement("div");
      activityCursorEl.id = `${_pfx}-activity-cursor`;
      activityCursorEl.innerHTML = cursorSvg(32);
      Object.assign(activityCursorEl.style, {
        position: "fixed", bottom: "24px", right: "24px",
        zIndex: "2147483647", pointerEvents: "none",
        filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.35))",
        animation: `${_pfx}-cursor-bounce 1s ease-in-out infinite`,
        transition: "opacity 0.3s ease-out",
      });
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
    setTimeout(() => { if (el) el.remove(); }, 300);
  }

  // ========================================================================
  // Message Handlers
  // ========================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "set-prefix") {
      const oldPfx = _pfx;
      _pfx = message.prefix;
      if (oldPfx !== _pfx) {
        for (const id of [`${oldPfx}-overlay-style`, `${oldPfx}-agent-overlay`, `${oldPfx}-cursor-style`, `${oldPfx}-bounce-style`, `${oldPfx}-activity-cursor`]) {
          const el = document.getElementById(id);
          if (el) el.remove();
        }
        overlayEl = null; styleEl = null; cursorStyleEl = null; activityCursorEl = null;
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
        if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
        overlayCount = 0; activeCursors = 0;
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

  // ========================================================================
  // Element Highlighting
  // ========================================================================

  function highlightElement(selector, duration) {
    try {
      const el = document.querySelector(selector);
      if (!el) return;
      const overlay = document.createElement("div");
      const rect = el.getBoundingClientRect();
      Object.assign(overlay.style, {
        position: "fixed",
        left: `${rect.left - 2}px`, top: `${rect.top - 2}px`,
        width: `${rect.width + 4}px`, height: `${rect.height + 4}px`,
        border: "2px solid #111",
        borderRadius: "3px",
        backgroundColor: "rgba(17, 24, 39, 0.12)",
        zIndex: "2147483647", pointerEvents: "none",
        transition: "opacity 0.3s",
      });
      (document.body || document.documentElement).appendChild(overlay);
      setTimeout(() => {
        overlay.style.opacity = "0";
        setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 300);
      }, duration);
    } catch {
      // Ignore errors
    }
  }
}
