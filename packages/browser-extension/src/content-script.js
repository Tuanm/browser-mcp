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

  // One persistent mouse pointer. It is shown while the agent works, moves to
  // each action point (tip at the action position), and stays there until the
  // agent session ends - it does not auto-remove after each action.
  let cursorStyleEl = null;
  let persistentCursorEl = null;

  function ensureCursorStyles() {
    if (cursorStyleEl && cursorStyleEl.isConnected) return;
    cursorStyleEl = document.createElement("style");
    cursorStyleEl.id = `${_pfx}-cursor-style`;
    cursorStyleEl.textContent = [
      `@keyframes ${_pfx}-cursor-pop {`,
      `  0% { transform: scale(0); opacity: 1; }`,
      `  15% { transform: scale(1.25); opacity: 1; }`,
      `  30% { transform: scale(1); opacity: 1; }`,
      `  100% { transform: scale(1); opacity: 1; }`,
      `}`,
      `.` + `${_pfx}-action-cursor {`,
      `  position: fixed;`,
      `  z-index: 2147483647;`,
      `  pointer-events: none;`,
      `  transform-origin: 6px 2px; /* arrow tip */`,
      `  filter: drop-shadow(0 2px 3px rgba(0,0,0,0.35));`,
      `}`,
      `.` + `${_pfx}-action-cursor svg { display: block; }`,
    ].join("\n");
    (document.head || document.documentElement).appendChild(cursorStyleEl);
  }

  function ensurePersistentCursor() {
    if (persistentCursorEl && persistentCursorEl.isConnected) return persistentCursorEl;
    ensureCursorStyles();
    persistentCursorEl = document.createElement("div");
    persistentCursorEl.id = `${_pfx}-action-cursor`;
    persistentCursorEl.className = `${_pfx}-action-cursor`;
    persistentCursorEl.innerHTML = cursorSvg(24);
    (document.body || document.documentElement).appendChild(persistentCursorEl);
    return persistentCursorEl;
  }

  // Last tip position of the persistent cursor, for animating the next move.
  let cursorX = null;
  let cursorY = null;
  let moveEndHandler = null;

  /** Pop (scale-in) animation at the cursor's current position. */
  function popCursor(cursor) {
    cursor.style.animation = "none";
    void cursor.offsetWidth; // reflow to restart animation
    cursor.style.animation = `${_pfx}-cursor-pop 0.35s ease-out forwards`;
  }

  /**
   * Move the persistent mouse pointer to the action point. The pointer glides
   * from its current position (human-like: ease-out, duration scales with
   * distance, pop on arrival) instead of teleporting.
   */
  function showActionCursor(x, y) {
    try {
      const cursor = ensurePersistentCursor();
      cursor.style.display = "block";
      cursor.style.animation = "none";
      // Place the arrow tip at the action point (tip at 6,2 in the 24px svg).
      const tipX = x - 6;
      const tipY = y - 2;
      if (cursorX == null) {
        // First placement: appear at the point immediately with a pop.
        cursor.style.transition = "none";
        cursor.style.left = tipX + "px";
        cursor.style.top = tipY + "px";
        popCursor(cursor);
      } else {
        const dist = Math.hypot(x - cursorX, y - cursorY);
        // Human move: ~150-600ms, longer for longer distances, ease-out.
        const dur = Math.min(Math.max(140, dist * 0.9), 600);
        cursor.style.transition =
          "left " + dur + "ms cubic-bezier(0.25, 0.46, 0.45, 0.94), " +
          "top " + dur + "ms cubic-bezier(0.25, 0.46, 0.45, 0.94)";
        cursor.style.left = tipX + "px";
        cursor.style.top = tipY + "px";
        // Pop when the glide arrives (handle left transition only, once).
        if (moveEndHandler) cursor.removeEventListener("transitionend", moveEndHandler);
        moveEndHandler = (e) => {
          if (e.propertyName !== "left") return;
          cursor.removeEventListener("transitionend", moveEndHandler);
          moveEndHandler = null;
          popCursor(cursor);
        };
        cursor.addEventListener("transitionend", moveEndHandler);
      }
      cursorX = x;
      cursorY = y;
    } catch {}
  }

  /** Show the persistent pointer (keeps its last position; starts at center). */
  function showActivityCursor() {
    try {
      const cursor = ensurePersistentCursor();
      cursor.style.display = "block";
      cursor.style.animation = "none";
      if (cursorX == null) {
        cursor.style.transition = "none";
        cursorX = Math.round(window.innerWidth / 2);
        cursorY = Math.round(window.innerHeight / 2);
        cursor.style.left = (cursorX - 6) + "px";
        cursor.style.top = (cursorY - 2) + "px";
      }
    } catch {}
  }

  /** Hide the persistent pointer when the agent session ends. */
  function hideActivityCursor() {
    try {
      if (persistentCursorEl) persistentCursorEl.style.display = "none";
    } catch {}
  }

  // ========================================================================
  // Message Handlers
  // ========================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "set-prefix") {
      const oldPfx = _pfx;
      _pfx = message.prefix;
      if (oldPfx !== _pfx) {
        for (const id of [`${oldPfx}-overlay-style`, `${oldPfx}-agent-overlay`, `${oldPfx}-cursor-style`, `${oldPfx}-action-cursor`]) {
          const el = document.getElementById(id);
          if (el) el.remove();
        }
        overlayEl = null; styleEl = null; cursorStyleEl = null; persistentCursorEl = null;
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
        if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
        overlayCount = 0;
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
