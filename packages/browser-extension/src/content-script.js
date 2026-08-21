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
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (fadeTimer) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
    // No auto-hide here: the service worker owns the hide lifecycle via an
    // idle timer (hide-agent-overlay after inactivity), so the glow stays
    // visible across multi-step agent runs instead of flashing every 5s.
    if (overlayEl) {
      overlayEl.style.opacity = "1";
      return;
    }

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
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (overlayEl) {
        overlayEl.style.opacity = "0";
        fadeTimer = setTimeout(() => {
          if (overlayEl) overlayEl.remove();
          if (styleEl) styleEl.remove();
          overlayEl = null;
          styleEl = null;
          fadeTimer = null;
        }, 300);
      }
    }, 500);
  }

  // ========================================================================
  // Agent Action Cursor - mouse pointer shown at the interaction position
  // ========================================================================

  // Real mouse pointer (black arrow, white outline, drop shadow) so the agent's
  // interaction looks like an actual mouse cursor, not a logo. Tip at (4,2).
  // Minimal arrowhead cursor - no tail, just the pointy tip with a subtle
  // concave back so it still reads as a pointer. Tip stays at (4,2).
  const MOUSE_POINTER_PATH = "M4 2 L17.5 9 L11 10.4 L7.5 15 L4.2 12 Z";

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
      `  transform-origin: 4px 2px; /* arrow tip */`,
      `  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5)) drop-shadow(0 0 1px rgba(0,0,0,0.4));`,
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
  let cursorAnimId = null;

  /** Pop (scale-in) animation at the cursor's current position. */
  function popCursor(cursor) {
    cursor.style.animation = "none";
    void cursor.offsetWidth; // reflow to restart animation
    cursor.style.animation = _pfx + "-cursor-pop 0.35s ease-out forwards";
  }

  /**
   * Animate the cursor from (fx,fy) to (tx,ty) along a natural curved path.
   * Human mouse movements are curved (not straight lines): we take a quadratic
   * bezier whose control point is offset perpendicular to the start->end line,
   * with the arc direction picked deterministically per move so consecutive
   * moves don't always bow the same way. Easing is ease-out (fast start,
   * gentle stop), duration scales with distance. Calls onDone when it lands.
   */
  function animateCursorAlongCurve(cursor, fx, fy, tx, ty, onDone) {
    const dist = Math.hypot(tx - fx, ty - fy);
    if (dist < 1) {
      onDone && onDone();
      return;
    }
    const dur = Math.min(Math.max(160, dist * 0.85), 650);
    // Perpendicular control-point offset: arc scales with distance (~8-60px).
    const arc = Math.min(Math.max(dist * 0.12, 8), 60) * (Math.round(fx + fy) % 2 === 0 ? 1 : -1);
    // Quadratic bezier control point, offset perpendicular to the travel line.
    const dx = tx - fx;
    const dy = ty - fy;
    const len = Math.hypot(dx, dy) || 1;
    const cx = (fx + tx) / 2 - (dy / len) * arc;
    const cy = (fy + ty) / 2 + (dx / len) * arc;
    const start = performance.now();
    function step(now) {
      const t = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const it = 1 - eased;
      const px = it * it * fx + 2 * it * eased * cx + eased * eased * tx;
      const py = it * it * fy + 2 * it * eased * cy + eased * eased * ty;
      cursor.style.left = px - 4 + "px";
      cursor.style.top = py - 2 + "px";
      if (t < 1) {
        cursorAnimId = requestAnimationFrame(step);
      } else {
        cursorAnimId = null;
        cursorX = tx;
        cursorY = ty;
        popCursor(cursor);
        onDone && onDone();
      }
    }
    cursorAnimId = requestAnimationFrame(step);
  }

  /**
   * Move the persistent mouse pointer to the action point. The pointer glides
   * along a natural curve from its current position (ease-out, duration scales
   * with distance, pop on arrival) instead of teleporting or sliding straight.
   * onDone fires once the cursor has landed - the service worker awaits this
   * BEFORE dispatching the actual input, so the user sees the mouse travel to
   * the element first, then the click/type happens.
   */
  function showActionCursor(x, y, onDone) {
    try {
      const cursor = ensurePersistentCursor();
      cursor.style.display = "block";
      cursor.style.opacity = "1";
      cursor.style.transition = "none";
      cursor.style.animation = "none";
      if (cursorAnimId) {
        cancelAnimationFrame(cursorAnimId);
        cursorAnimId = null;
      }
      if (cursorX == null) {
        // First placement: appear at the point immediately with a pop.
        cursor.style.transition = "none";
        cursor.style.left = x - 4 + "px";
        cursor.style.top = y - 2 + "px";
        cursorX = x;
        cursorY = y;
        popCursor(cursor);
        onDone && onDone();
      } else {
        animateCursorAlongCurve(cursor, cursorX, cursorY, x, y, onDone);
      }
    } catch {
      if (onDone) onDone();
    }
  }

  /** Show the persistent pointer (keeps its last position; starts at center). */
  function showActivityCursor() {
    try {
      const cursor = ensurePersistentCursor();
      cursor.style.display = "block";
      cursor.style.opacity = "1";
      cursor.style.transition = "none";
      cursor.style.animation = "none";
      if (cursorX == null) {
        cursor.style.transition = "none";
        cursorX = Math.round(window.innerWidth / 2);
        cursorY = Math.round(window.innerHeight / 2);
        cursor.style.left = cursorX - 6 + "px";
        cursor.style.top = cursorY - 2 + "px";
      }
    } catch {}
  }

  /** Hide the persistent pointer after an idle gap (graceful fade). */
  function hideActivityCursor() {
    try {
      if (!persistentCursorEl) return;
      if (cursorAnimId) {
        cancelAnimationFrame(cursorAnimId);
        cursorAnimId = null;
      }
      const el = persistentCursorEl;
      el.style.transition = "opacity 0.25s ease-out";
      el.style.opacity = "0";
      setTimeout(() => {
        if (persistentCursorEl === el) el.style.display = "none";
      }, 260);
    } catch {}
  }

  // ========================================================================
  // Text-to-Speech (agent narration) - native Web Speech API
  // ========================================================================
  // Plays through THIS tab so chrome.tabCapture (recording) captures the
  // audio. Works in Chrome and Edge (both Chromium). English-first: the
  // agent can list voices (tts action=voices) and pick one by name.

  function ttsListVoices() {
    if (!window.speechSynthesis) return { ok: false, error: "speechSynthesis unavailable in this browser" };
    const voices = speechSynthesis.getVoices();
    return {
      ok: true,
      voices: voices.map((v) => ({ name: v.name, lang: v.lang, local: v.localService, default: v.default })),
      note:
        voices.length === 0 ? "No voices loaded yet - call voices again (Chrome loads them async on first use)." : "",
    };
  }

  function ttsSpeak(text, opts) {
    return new Promise((resolve) => {
      try {
        if (!window.speechSynthesis) {
          resolve({ ok: false, error: "speechSynthesis unavailable in this browser" });
          return;
        }
        if (!text) {
          resolve({ ok: false, error: "text is required" });
          return;
        }
        // Cancel anything already speaking so the agent's latest line wins.
        try {
          speechSynthesis.cancel();
        } catch {}
        const u = new SpeechSynthesisUtterance(String(text).slice(0, 2000));
        const voices = speechSynthesis.getVoices();
        if (opts.voice) {
          const match = voices.find(
            (v) => v.name === opts.voice || v.name.toLowerCase().includes(String(opts.voice).toLowerCase()),
          );
          if (match) u.voice = match;
        }
        if (!u.voice) {
          // English-first default: prefer an en voice, fall back to any.
          const en = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
          if (en) u.voice = en;
        }
        u.lang = opts.lang || "en-US";
        u.rate = Math.min(Math.max(Number(opts.rate) || 1, 0.5), 2);
        u.pitch = Math.min(Math.max(Number(opts.pitch) || 1, 0), 2);
        u.volume = Math.min(Math.max(Number(opts.volume) || 1, 0), 1);
        const done = (ok, extra) => {
          try {
            u.onend = null;
            u.onerror = null;
          } catch {}
          resolve(Object.assign({ ok, spoken: String(text).slice(0, 120) }, extra || {}));
        };
        u.onend = () => done(true);
        u.onerror = (e) => done(false, { error: (e && e.error) || "speech synthesis error" });
        speechSynthesis.speak(u);
        // block=false: fire-and-forget, resolve as soon as queued.
        if (!opts.block) setTimeout(() => done(true, { speaking: true }), 60);
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  function ttsStop() {
    try {
      if (window.speechSynthesis) speechSynthesis.cancel();
      return { ok: true, stopped: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function ttsStatus() {
    if (!window.speechSynthesis) return { ok: true, speaking: false, supported: false };
    return { ok: true, supported: true, speaking: speechSynthesis.speaking, pending: speechSynthesis.pending };
  }

  // ========================================================================
  // Message Handlers
  // ========================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "set-prefix") {
      const oldPfx = _pfx;
      _pfx = message.prefix;
      if (oldPfx !== _pfx) {
        for (const id of [
          `${oldPfx}-overlay-style`,
          `${oldPfx}-agent-overlay`,
          `${oldPfx}-cursor-style`,
          `${oldPfx}-action-cursor`,
        ]) {
          const el = document.getElementById(id);
          if (el) el.remove();
        }
        overlayEl = null;
        styleEl = null;
        cursorStyleEl = null;
        persistentCursorEl = null;
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
      // Async: respond only after the cursor has finished traveling, so the
      // service worker can dispatch the real input AFTER the visual arrival.
      showActionCursor(message.x, message.y, () => sendResponse({ ok: true, landed: true }));
      return true; // keep the message channel open until the animation completes
    } else if (message.type === "show-activity-cursor") {
      showActivityCursor();
      sendResponse({ ok: true });
    } else if (message.type === "hide-activity-cursor") {
      hideActivityCursor();
      sendResponse({ ok: true });
    } else if (message.type === "get-cursor-position") {
      // Report where the agent cursor is so the SW can scroll that area.
      sendResponse(cursorX != null && cursorY != null ? { x: cursorX, y: cursorY } : { x: null, y: null });
    } else if (message.type === "tts-speak") {
      // Async: respond when the utterance finishes (or immediately for fire-and-forget).
      ttsSpeak(message.text, {
        voice: message.voice,
        rate: message.rate,
        pitch: message.pitch,
        volume: message.volume,
        lang: message.lang,
        block: message.block !== false,
      }).then((r) => sendResponse(r));
      return true;
    } else if (message.type === "tts-stop") {
      sendResponse(ttsStop());
    } else if (message.type === "tts-voices") {
      sendResponse(ttsListVoices());
    } else if (message.type === "tts-status") {
      sendResponse(ttsStatus());
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
        left: `${rect.left - 2}px`,
        top: `${rect.top - 2}px`,
        width: `${rect.width + 4}px`,
        height: `${rect.height + 4}px`,
        border: "2px solid #111",
        borderRadius: "3px",
        backgroundColor: "rgba(17, 24, 39, 0.12)",
        zIndex: "2147483647",
        pointerEvents: "none",
        transition: "opacity 0.3s",
      });
      (document.body || document.documentElement).appendChild(overlay);
      setTimeout(() => {
        overlay.style.opacity = "0";
        setTimeout(() => {
          if (overlay.parentNode) overlay.remove();
        }, 300);
      }, duration);
    } catch {
      // Ignore errors
    }
  }
}
