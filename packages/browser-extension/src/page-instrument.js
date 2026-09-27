/**
 * page-instrument.js — page-side capture for browsers WITHOUT chrome.debugger.
 *
 * Chrome/Edge read console output, page errors and JavaScript dialogs over the
 * DevTools Protocol. WebKit (Safari, Orion on iPadOS) has no CDP, so this file
 * observes the page directly instead. It is registered in TWO worlds at
 * document_start and ONLY on browsers that lack CDP (see
 * registerPageInstrumentation() in service-worker.js), so Chrome is untouched.
 *
 *   relay (isolated world): mints a per-document nonce, hands it to the shim, and
 *     forwards what the shim reports to the service worker. A MAIN-world script
 *     has no chrome.* APIs, hence the split.
 *
 *   shim (MAIN world): wraps console.*, the error events and the three blocking
 *     dialog functions, tagging everything with the nonce.
 *
 * Both worlds are injected before any page script runs, so a page cannot observe
 * the nonce and therefore cannot fabricate console output or errors for the agent
 * to read.
 */
(() => {
  const CHANNEL = "__bmcp_page_instrument__";
  const NONCE_KEY = "__bmcp_page_instrument_nonce__";
  const isIsolatedWorld = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);

  if (isIsolatedWorld) {
    // ---------------- relay (isolated world) ----------------
    // Re-injection (e.g. the on-demand fallback) must not stack relays.
    if (window.__bmcpPageInstrumentRelay) return;
    window.__bmcpPageInstrumentRelay = true;
    const nonce = (() => {
      try {
        return crypto.randomUUID();
      } catch {
        return String(Math.random()).slice(2) + String(Date.now());
      }
    })();
    // Re-announce: the shim may be injected just after us, and a late document
    // (about:blank frames) can rebuild its world.
    const announce = () => {
      try {
        window.postMessage({ [NONCE_KEY]: nonce }, "*");
      } catch {}
    };
    announce();
    setTimeout(announce, 0);

    // Answers chosen earlier (dialog action=auto) survive navigation.
    try {
      chrome.runtime.sendMessage({ type: "dialog-defaults-request" }, (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        try {
          window.postMessage(
            { __bmcp_dialog_defaults: true, nonce: nonce, confirm: resp.confirm, prompt: resp.prompt },
            "*",
          );
        } catch {}
      });
    } catch {}

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data[CHANNEL] !== true || data.nonce !== nonce) return;
      try {
        const sent = chrome.runtime.sendMessage({ type: "page-instrument", kind: data.kind, payload: data.payload });
        if (sent && typeof sent.catch === "function") sent.catch(() => {});
      } catch {}
    });

    // Dialog answers pushed down by the service worker (dialog action=auto).
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (!message || message.type !== "dialog-defaults") return;
        try {
          window.postMessage(
            { __bmcp_dialog_defaults: true, nonce: nonce, confirm: message.confirm, prompt: message.prompt },
            "*",
          );
        } catch {}
      });
    } catch {}
    return;
  }

  // ---------------- shim (MAIN world) ----------------
  if (window.__bmcpPageInstrumented) return;
  window.__bmcpPageInstrumented = true;

  // alert/confirm/prompt block the page's JS. CDP lets Chrome pause them and ask
  // the agent; without CDP we cannot block, so they are answered with a SAFE
  // default and reported instead. confirm never auto-accepts: accepting one can
  // destroy data. The agent can change these up front with dialog action=auto.
  const dialogDefaults = { confirm: false, prompt: null };

  let nonce = null;
  const queue = [];
  const post = (kind, payload) => {
    const message = { [CHANNEL]: true, nonce: nonce, kind: kind, payload: payload };
    if (!nonce) {
      if (queue.length < 200) queue.push(message);
      return;
    }
    try {
      window.postMessage(message, "*");
    } catch {}
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;
    if (data[NONCE_KEY] && !nonce) {
      nonce = data[NONCE_KEY];
      for (const queued of queue.splice(0)) {
        queued.nonce = nonce;
        try {
          window.postMessage(queued, "*");
        } catch {}
      }
      return;
    }
    if (data.__bmcp_dialog_defaults === true && data.nonce === nonce) {
      if (typeof data.confirm === "boolean") dialogDefaults.confirm = data.confirm;
      if (data.prompt !== undefined) dialogDefaults.prompt = data.prompt;
    }
  });

  const fmt = (value, depth) => {
    try {
      if (typeof value === "string") return value;
      if (value instanceof Error) return value.stack || value.name + ": " + value.message;
      if (value === null) return "null";
      if (value === undefined) return "undefined";
      if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
      if (typeof value === "object") {
        if ((depth || 0) > 2) return "[Object]";
        if (Array.isArray(value)) {
          return "[" + value.slice(0, 20).map((v) => fmt(v, (depth || 0) + 1)).join(", ") + "]";
        }
        const keys = Object.keys(value).slice(0, 20);
        return "{" + keys.map((k) => k + ": " + fmt(value[k], (depth || 0) + 1)).join(", ") + "}";
      }
      return String(value);
    } catch {
      return "[unserializable]";
    }
  };

  // ---- console ----
  for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
    const original = console[level];
    if (typeof original !== "function") continue;
    console[level] = function (...args) {
      try {
        post("console", { type: level, text: args.map((a) => fmt(a, 0)).join(" ").slice(0, 1000) });
      } catch {}
      return original.apply(this, args);
    };
  }

  // ---- uncaught errors ----
  window.addEventListener(
    "error",
    (event) => {
      try {
        const err = event && event.error;
        const text = err && err.stack ? err.stack : event && event.message ? event.message : "Unknown error";
        post("error", {
          text: String(text).slice(0, 500),
          url: (event && event.filename) || location.href,
          line: event && typeof event.lineno === "number" ? event.lineno : null,
          column: event && typeof event.colno === "number" ? event.colno : null,
        });
      } catch {}
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) => {
    try {
      const reason = event && event.reason;
      const text = reason && reason.stack ? reason.stack : "Unhandled rejection: " + fmt(reason, 0);
      post("error", { text: String(text).slice(0, 500), url: location.href, line: null, column: null });
    } catch {}
  });

  // ---- blocking dialogs ----
  try {
    const nativeAlert = window.alert;
    const nativeConfirm = window.confirm;
    const nativePrompt = window.prompt;
    window.alert = function (message) {
      post("dialog", { type: "alert", message: String(message == null ? "" : message) });
      return undefined;
    };
    window.confirm = function (message) {
      post("dialog", { type: "confirm", message: String(message == null ? "" : message) });
      return !!dialogDefaults.confirm;
    };
    window.prompt = function (message, defaultValue) {
      post("dialog", {
        type: "prompt",
        message: String(message == null ? "" : message),
        defaultPrompt: defaultValue == null ? "" : String(defaultValue),
      });
      return dialogDefaults.prompt === null ? null : String(dialogDefaults.prompt);
    };
    // Keep them looking native to naive feature-detection.
    if (nativeAlert) window.alert.toString = () => nativeAlert.toString();
    if (nativeConfirm) window.confirm.toString = () => nativeConfirm.toString();
    if (nativePrompt) window.prompt.toString = () => nativePrompt.toString();
  } catch {}
})();
