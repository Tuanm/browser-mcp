/**
 * mcp-server.js - MCP JSON-RPC layer for DIRECT gateway mode.
 *
 * When the popup provides a device ID + token, the extension connects straight
 * to the code-mcp gateway (wss://code-mcp.tuanm.dev/ws/<id>) and answers MCP
 * requests itself - no local server required.
 */

export function createMcpHandler(dispatch) {
  const refCache = new Map();
  let refCounter = 0;
  function resetRefs() { refCache.clear(); refCounter = 0; }
  const MAX_REF_CACHE = 2000;
  function storeRef(ref, entry) {
    refCache.set(ref, entry);
    if (refCache.size > MAX_REF_CACHE) {
      for (const key of refCache.keys()) {
        refCache.delete(key);
        if (refCache.size <= MAX_REF_CACHE * 0.8) break;
      }
    }
  }
  function resolveRefArg(args) {
    const ref = args && args.ref;
    if (ref == null) return undefined;
    const m = String(ref).match(/^@?(e\d+)$/);
    if (!m) throw new Error("Invalid ref: " + ref);
    const entry = refCache.get(m[1]);
    if (!entry) throw new Error("Ref " + ref + " not found - run browser_snapshot again");
    return entry.selector;
  }
  function resolveArgsRefs(name, args) {
    if (!args) return args;
    if (REF_SUPPORTING.has(name) && args.ref != null) {
      return { ...args, ref: undefined, selector: resolveRefArg(args) };
    }
    if (name === "browser_drag") {
      let next = args;
      if (args.from_ref != null) next = { ...next, from_ref: undefined, from_selector: resolveRefArg({ ref: args.from_ref }) };
      if (args.to_ref != null) next = { ...next, to_ref: undefined, to_selector: resolveRefArg({ ref: args.to_ref }) };
      return next;
    }
    if (name === "browser_wait" && args.mode === "selector" && args.ref != null) {
      return { ...args, ref: undefined, selector: resolveRefArg(args) };
    }
    return args;
  }

  const REF_SUPPORTING = new Set([
    "browser_click", "browser_type", "browser_fill", "browser_hover", "browser_select",
    "browser_screenshot", "browser_check", "browser_uncheck", "browser_focus",
    "browser_dblclick", "browser_highlight", "browser_get", "browser_is", "browser_upload",
  ]);
  const MAX_TEXT_OUTPUT = 50_000;
  function jsonOut(v) {
    if (typeof v === "string") return v.length > MAX_TEXT_OUTPUT ? v.slice(0, MAX_TEXT_OUTPUT) + "\n\n... (truncated)" : v;
    let s;
    try { s = JSON.stringify(v, null, 2); } catch { s = String(v); }
    return s.length > MAX_TEXT_OUTPUT ? s.slice(0, MAX_TEXT_OUTPUT) + "\n\n... (truncated)" : s;
  }
  const textBlocks = (text) => [{ type: "text", text }];
  const errBlocks = (e) => [{ type: "text", text: "ERROR: " + (e && e.message ? e.message : String(e)) }];

  const TOOLS = [
  { name: "browser_status",
    description: "Check the browser extension connection status.",
    parameters: {}, required: [],
    run: async () => ({ content: textBlocks(jsonOut({ connected: true, extensions: 1, message: "Connected directly to the code-mcp gateway." })) }) },

  { name: "browser_navigate",
    description: "Navigate a browser tab to a URL. Reuse an open tab via tab_id, otherwise a new tab is created.",
    parameters: { url: { type: "string", description: "URL to navigate to" }, tab_id: { type: "number", description: "Target tab ID (optional)" }, wait_for: { type: "string", description: "load (default) or domcontentloaded" } },
    required: ["url"],
    run: async (a) => { const r = await dispatch("navigate", { url: a.url, tabId: a.tab_id, waitFor: a.wait_for || "load" }); return { content: textBlocks(jsonOut({ tab_id: r.tabId, url: r.url, title: r.title })) }; } },

  { name: "browser_screenshot",
    description: "Take a screenshot of the current tab. Returns a JPEG image content block. Prefer browser_extract/browser_execute for text. On anti-bot sites use stealth=true.",
    parameters: { tab_id: { type: "number" }, selector: { type: "string" }, full_page: { type: "boolean" }, stealth: { type: "boolean" } },
    required: [],
    run: async (a) => { const r = await dispatch("screenshot", { tabId: a.tab_id, selector: a.selector, fullPage: a.full_page, stealth: a.stealth }); if (!r || !r.dataUrl) throw new Error("No screenshot data"); const m = r.dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.*)$/); const mime = m ? m[1] : "image/jpeg"; const b64 = m ? m[2] : r.dataUrl.replace(/^data:image\/\w+;base64,/, ""); return { content: [{ type: "image", data: b64, mimeType: mime }, { type: "text", text: jsonOut({ tab_id: r.tabId, width: r.width, height: r.height }) }] }; } },

  { name: "browser_click",
    description: "Click an element (selector/ref) or coordinates. Supports right/middle buttons, click_count, pierce, intercept_file_chooser, stealth.",
    parameters: { selector: { type: "string" }, x: { type: "number" }, y: { type: "number" }, tab_id: { type: "number" }, button: { type: "string", enum: ["left", "right", "middle"] }, click_count: { type: "number" }, pierce: { type: "boolean" }, intercept_file_chooser: { type: "boolean" }, stealth: { type: "boolean" } },
    required: [],
    run: async (a) => { const r = await dispatch("click", { selector: a.selector, x: a.x, y: a.y, tabId: a.tab_id, button: a.button || "left", clickCount: a.click_count, pierce: a.pierce, intercept_file_chooser: a.intercept_file_chooser, stealth: a.stealth }); return { content: textBlocks(jsonOut({ clicked: true, element: r.element, tab_id: r.tabId })) }; } },

  { name: "browser_type",
    description: "Type text into a focused element or a selector. clear_first clears before typing, press_enter presses Enter after.",
    parameters: { text: { type: "string" }, selector: { type: "string" }, tab_id: { type: "number" }, clear_first: { type: "boolean" }, press_enter: { type: "boolean" }, pierce: { type: "boolean" }, stealth: { type: "boolean" } },
    required: ["text"],
    run: async (a) => { const r = await dispatch("type", { text: a.text, selector: a.selector, tabId: a.tab_id, clearFirst: a.clear_first, pressEnter: a.press_enter, pierce: a.pierce, stealth: a.stealth }); return { content: textBlocks(jsonOut({ typed: true, text_length: String(a.text).length, element: r.element, tab_id: r.tabId })) }; } },

  { name: "browser_extract",
    description: "Extract text, links, forms, tables, accessibility tree, or html from the page (or a selector scope).",
    parameters: { mode: { type: "string", enum: ["text", "links", "forms", "tables", "accessibility", "html"] }, selector: { type: "string" }, tab_id: { type: "number" }, frame_id: { type: "string" } },
    required: ["mode"],
    run: async (a) => { const r = await dispatch("extract", { mode: a.mode, selector: a.selector, tabId: a.tab_id, frameId: a.frame_id }); return { content: textBlocks(jsonOut(r && r.data)) }; } },

  { name: "browser_tabs",
    description: "List, close, or activate browser tabs.",
    parameters: { action: { type: "string", enum: ["list", "close", "activate"] }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const r = await dispatch("tabs", { action: a.action || "list", tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },

  { name: "browser_execute",
    description: "Execute JavaScript in the page. Pass code, or script_id (stored via browser_store) + script_args.",
    parameters: { code: { type: "string" }, script_id: { type: "string" }, script_args: { type: "object" }, tab_id: { type: "number" }, frame_id: { type: "string" }, stealth: { type: "boolean" } },
    required: [],
    run: async (a) => {
      let code = a.code;
      if (a.script_id) {
        const st = await dispatch("store", { action: "get", key: a.script_id, tabId: a.tab_id });
        if (!st || !st.found) throw new Error("Stored script not found: " + a.script_id);
        code = "(async function(){const __args=" + JSON.stringify(a.script_args || {}) + ";" + st.value + "})()";
      }
      if (!code) throw new Error("Either code or script_id is required");
      if (!a.script_id) code = "(async()=>{" + code + "})()";
      const r = await dispatch("execute", { code, tabId: a.tab_id, frameId: a.frame_id, stealth: a.stealth });
      return { content: textBlocks(r && r.value !== undefined ? jsonOut(r.value) : "(undefined)") };
    } },
  { name: "browser_scroll",
    description: "Scroll the page or a scrollable element (selector).",
    parameters: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number" }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" }, tab_id: { type: "number" }, stealth: { type: "boolean" } },
    required: [],
    run: async (a) => { const r = await dispatch("scroll", { direction: a.direction || "down", amount: a.amount, selector: a.selector, x: a.x, y: a.y, tabId: a.tab_id, stealth: a.stealth }); return { content: textBlocks(jsonOut({ scrolled: true, direction: r.direction, amount: r.amount, tab_id: r.tabId })) }; } },

  { name: "browser_hover",
    description: "Hover over an element (selector/ref or coordinates) to reveal tooltips/menus.",
    parameters: { selector: { type: "string" }, x: { type: "number" }, y: { type: "number" }, tab_id: { type: "number" }, pierce: { type: "boolean" }, stealth: { type: "boolean" } },
    required: [],
    run: async (a) => { const r = await dispatch("hover", { selector: a.selector, x: a.x, y: a.y, tabId: a.tab_id, pierce: a.pierce, stealth: a.stealth }); return { content: textBlocks(jsonOut({ hovered: true, element: r.element, tab_id: r.tabId })) }; } },

  { name: "browser_mouse_move",
    description: "Move the mouse to coordinates (steps for smoother travel).",
    parameters: { x: { type: "number" }, y: { type: "number" }, steps: { type: "number" }, tab_id: { type: "number" } },
    required: ["x", "y"],
    run: async (a) => { const r = await dispatch("mouse_move", { x: a.x, y: a.y, steps: a.steps, tabId: a.tab_id }); return { content: textBlocks(jsonOut({ moved: true, tab_id: r.tabId })) }; } },

  { name: "browser_drag",
    description: "Drag and drop from a source to a target (selectors/refs or coordinates).",
    parameters: { from_selector: { type: "string" }, from_x: { type: "number" }, from_y: { type: "number" }, to_selector: { type: "string" }, to_x: { type: "number" }, to_y: { type: "number" }, tab_id: { type: "number" }, steps: { type: "number" } },
    required: [],
    run: async (a) => { const r = await dispatch("drag", { fromSelector: a.from_selector, fromX: a.from_x, fromY: a.from_y, toSelector: a.to_selector, toX: a.to_x, toY: a.to_y, tabId: a.tab_id, steps: a.steps }); return { content: textBlocks(jsonOut({ dragged: true, from: r.from, to: r.to, tab_id: r.tabId })) }; } },

  { name: "browser_press",
    description: "Press a keyboard key with optional modifiers (ctrl/shift/alt/meta).",
    parameters: { key: { type: "string", description: "Enter, Tab, Escape, ArrowUp, F1-F12, or any character" }, modifiers: { type: "array", items: { type: "string" } }, tab_id: { type: "number" }, stealth: { type: "boolean" } },
    required: ["key"],
    run: async (a) => { const r = await dispatch("keypress", { key: a.key, modifiers: a.modifiers, tabId: a.tab_id, stealth: a.stealth }); return { content: textBlocks(jsonOut({ pressed: true, key: r.key, modifiers: r.modifiers, tab_id: r.tabId })) }; } },

  { name: "browser_select",
    description: "Select an option in a select by value, text, or index.",
    parameters: { selector: { type: "string" }, value: { type: "string" }, text: { type: "string" }, index: { type: "number" }, tab_id: { type: "number" } },
    required: ["selector"],
    run: async (a) => { const r = await dispatch("select", { selector: a.selector, value: a.value, text: a.text, index: a.index, tabId: a.tab_id }); return { content: textBlocks(jsonOut({ selected: true, value: r.selected, text: r.text, index: r.index, tab_id: r.tabId })) }; } },

  { name: "browser_dialog",
    description: "Handle a JavaScript dialog (accept/dismiss, optional prompt_text).",
    parameters: { action: { type: "string", enum: ["accept", "dismiss"] }, prompt_text: { type: "string" }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const r = await dispatch("dialog", { action: a.action || "accept", promptText: a.prompt_text, tabId: a.tab_id }); return { content: textBlocks(jsonOut({ handled: r.handled, type: r.type, dialog_message: r.dialogMessage, tab_id: r.tabId })) }; } },

  { name: "browser_back",
    description: "Go back in history.",
    parameters: { tab_id: { type: "number" } }, required: [],
    run: async (a) => { const r = await dispatch("back", { tabId: a.tab_id }); return { content: textBlocks(jsonOut({ navigated: "back", url: r.url, title: r.title, tab_id: r.tabId })) }; } },
  { name: "browser_forward",
    description: "Go forward in history.",
    parameters: { tab_id: { type: "number" } }, required: [],
    run: async (a) => { const r = await dispatch("forward", { tabId: a.tab_id }); return { content: textBlocks(jsonOut({ navigated: "forward", url: r.url, title: r.title, tab_id: r.tabId })) }; } },
  { name: "browser_reload",
    description: "Reload the current page.",
    parameters: { tab_id: { type: "number" } }, required: [],
    run: async (a) => { const r = await dispatch("reload", { tabId: a.tab_id }); return { content: textBlocks(jsonOut({ reloaded: true, url: r.url, title: r.title, tab_id: r.tabId })) }; } },
  { name: "browser_close",
    description: "Close a browser tab (defaults to the active tab).",
    parameters: { tab_id: { type: "number" } }, required: [],
    run: async (a) => { const r = await dispatch("close", { tabId: a.tab_id }); return { content: textBlocks(jsonOut({ closed: r.closed })) }; } },
  { name: "browser_wait",
    description: "Wait for a condition: timeout, load, url (substring/regex), text (page contains), selector (element appears via ref/selector).",
    parameters: { mode: { type: "string", enum: ["timeout", "load", "url", "text", "selector"] }, timeout: { type: "number" }, url: { type: "string" }, text: { type: "string" }, ref: { type: "string" }, selector: { type: "string" }, state: { type: "string", enum: ["load", "domcontentloaded"] }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const sel = a.mode === "selector" && a.ref ? resolveRefArg(a) : a.selector; const r = await dispatch("wait", { mode: a.mode || "timeout", selector: sel, text: a.text, url: a.url, timeout: a.timeout, state: a.state, tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },

  { name: "browser_highlight",
    description: "Flash a highlight box around an element so the user can see what the agent is targeting.",
    parameters: { selector: { type: "string" }, ref: { type: "string" }, duration: { type: "number" }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const r = await dispatch("highlight", { selector: a.ref ? resolveRefArg(a) : a.selector, duration: a.duration, tabId: a.tab_id }); return { content: textBlocks(jsonOut({ highlighted: a.selector || a.ref, tab_id: r.tabId })) }; } },

  { name: "browser_snapshot",
    description: "Capture the interactive element tree with refs (e.g. button \"Submit\" [ref=e4]). Use refs with interaction tools. Refs valid until the next snapshot/navigation.",
    parameters: { interactive: { type: "boolean" }, cursor: { type: "boolean" }, include_headings: { type: "boolean" }, max: { type: "number" }, scope: { type: "string" }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => {
      const r = await dispatch("snapshot", { interactive: a.interactive, cursor: a.cursor, max: a.max, includeHeadings: a.include_headings, scope: a.scope, tabId: a.tab_id });
      const entries = (r && r.entries) || [];
      resetRefs();
      const lines = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const ref = "e" + (i + 1);
        storeRef(ref, { selector: e.selector || "", role: e.role || "", name: e.name || "", ts: Date.now() });
        let line = e.role || e.tag;
        if (e.name) line += " " + JSON.stringify(String(e.name).slice(0, 80));
        line += " [ref=" + ref + "]";
        if (e.value !== undefined) line += " [value=" + JSON.stringify(String(e.value).slice(0, 60)) + "]";
        if (e.checked !== undefined) line += " [checked=" + e.checked + "]";
        if (e.href) line += " -> " + String(e.href).slice(0, 200);
        lines.push(line);
      }
      let body = lines.map((l) => "  " + l).join("\n");
      if (body.length > 50000) body = body.slice(0, 50000) + "\n... (truncated)";
      return { content: textBlocks("page: " + ((r && r.url) || "") + " - " + entries.length + " element" + (entries.length === 1 ? "" : "s") + " (refs valid until next snapshot)\n" + body) };
    } },

  { name: "browser_find",
    description: "Semantic element search: role, name, text, label, placeholder, title, testid, selector. Returns matches with refs.",
    parameters: { role: { type: "string" }, name: { type: "string" }, text: { type: "string" }, label: { type: "string" }, placeholder: { type: "string" }, title: { type: "string" }, testid: { type: "string" }, selector: { type: "string" }, exact: { type: "boolean" }, max: { type: "number" }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => {
      const r = await dispatch("find", { role: a.role, name: a.name, text: a.text, label: a.label, placeholder: a.placeholder, title: a.title, testid: a.testid, selector: a.selector, exact: a.exact, max: a.max, tabId: a.tab_id });
      const matches = (r && r.matches) || [];
      const lines = [];
      for (const m of matches) {
        refCounter++;
        const ref = "e" + refCounter;
        storeRef(ref, { selector: m.selector || "", role: m.role || "", name: m.name || "", ts: Date.now() });
        lines.push((m.role || m.tag) + " " + JSON.stringify(String(m.name || m.text || "").slice(0, 60)) + " [ref=" + ref + "]");
      }
      return { content: textBlocks("found " + matches.length + " match" + (matches.length === 1 ? "" : "es") + (lines.length ? "\n" + lines.map((l) => "  " + l).join("\n") : "")) };
    } },

  { name: "browser_get",
    description: "Get element/page info: text, html, value, attribute (attr), url, title, count, box, styles (style_property). Target with ref or selector.",
    parameters: { property: { type: "string", enum: ["text", "html", "value", "attribute", "url", "title", "count", "box", "styles"] }, ref: { type: "string" }, selector: { type: "string" }, attr: { type: "string" }, style_property: { type: "string" }, tab_id: { type: "number" } },
    required: ["property"],
    run: async (a) => { const sel = a.ref ? resolveRefArg(a) : a.selector; if (!sel) throw new Error("ref or selector required"); const r = await dispatch("get_element", { selector: sel, property: a.property, attr: a.attr || null, styleProperty: a.style_property || null, tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },

  { name: "browser_is",
    description: "Check element state: visible, hidden, enabled, disabled, checked, unchecked, editable, readonly, focused. Returns true/false.",
    parameters: { check: { type: "string", enum: ["visible", "hidden", "enabled", "disabled", "checked", "unchecked", "editable", "readonly", "focused"] }, ref: { type: "string" }, selector: { type: "string" }, tab_id: { type: "number" } },
    required: ["check"],
    run: async (a) => { const sel = a.ref ? resolveRefArg(a) : a.selector; if (!sel) throw new Error("ref or selector required"); const r = await dispatch("is_element", { selector: sel, check: a.check, tabId: a.tab_id }); return { content: textBlocks(String(r && r.result)) }; } },

  { name: "browser_fill",
    description: "Fill an input: clear it, then type the text. Target with ref or selector.",
    parameters: { text: { type: "string" }, ref: { type: "string" }, selector: { type: "string" }, press_enter: { type: "boolean" }, tab_id: { type: "number" } },
    required: ["text"],
    run: async (a) => { const sel = a.ref ? resolveRefArg(a) : a.selector; const r = await dispatch("fill", { text: a.text, selector: sel, tabId: a.tab_id, pressEnter: a.press_enter }); return { content: textBlocks(jsonOut({ filled: true, element: sel, tab_id: r.tabId })) }; } },

  { name: "browser_check",
    description: "Check a checkbox/radio (no-op if already checked). Target with ref or selector.",
    parameters: { ref: { type: "string" }, selector: { type: "string" }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const sel = a.ref ? resolveRefArg(a) : a.selector; if (!sel) throw new Error("ref or selector required"); const r = await dispatch("check", { selector: sel, tabId: a.tab_id }); return { content: textBlocks(jsonOut({ checked: true, already: !!r.already, tab_id: r.tabId })) }; } },
  { name: "browser_uncheck",
    description: "Uncheck a checkbox/radio (no-op if already unchecked). Target with ref or selector.",
    parameters: { ref: { type: "string" }, selector: { type: "string" }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const sel = a.ref ? resolveRefArg(a) : a.selector; if (!sel) throw new Error("ref or selector required"); const r = await dispatch("uncheck", { selector: sel, tabId: a.tab_id }); return { content: textBlocks(jsonOut({ checked: false, already: !!r.already, tab_id: r.tabId })) }; } },
  { name: "browser_focus",
    description: "Focus an element (scrolls into view). Target with ref or selector.",
    parameters: { ref: { type: "string" }, selector: { type: "string" }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const sel = a.ref ? resolveRefArg(a) : a.selector; if (!sel) throw new Error("ref or selector required"); const r = await dispatch("focus", { selector: sel, tabId: a.tab_id }); return { content: textBlocks(jsonOut({ focused: true, element: sel, tab_id: r.tabId })) }; } },
  { name: "browser_dblclick",
    description: "Double-click an element. Target with ref, selector, or coordinates.",
    parameters: { ref: { type: "string" }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" }, tab_id: { type: "number" }, stealth: { type: "boolean" } },
    required: [],
    run: async (a) => { const sel = a.ref ? resolveRefArg(a) : a.selector; const r = await dispatch("dblclick", { selector: sel, x: a.x, y: a.y, tabId: a.tab_id, stealth: a.stealth }); return { content: textBlocks(jsonOut({ double_clicked: true, element: r.element, tab_id: r.tabId })) }; } },
  { name: "browser_storage",
    description: "Read/write/clear localStorage or sessionStorage. type: local (default) or session. Actions: get, set, remove, clear.",
    parameters: { action: { type: "string", enum: ["get", "set", "remove", "clear"] }, type: { type: "string", enum: ["local", "session"] }, key: { type: "string" }, value: { type: "string" }, tab_id: { type: "number" } },
    required: ["action"],
    run: async (a) => { const r = await dispatch("storage", { action: a.action || "get", type: a.type || "local", key: a.key, value: a.value, tabId: a.tab_id }); if (r && r.error) throw new Error(r.error); return { content: textBlocks(jsonOut(r)) }; } },

  { name: "browser_pdf",
    description: "Export the page as a PDF. Returns the PDF as base64 text (up to 2 MiB; larger PDFs return an error - run the local server for full file support).",
    parameters: { format: { type: "string", enum: ["letter", "a4", "a3", "a5", "legal", "tabloid"] }, landscape: { type: "boolean" }, print_background: { type: "boolean" }, display_header_footer: { type: "boolean" }, scale: { type: "number" }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const r = await dispatch("pdf", { tabId: a.tab_id, format: a.format, landscape: a.landscape, printBackground: a.print_background, displayHeaderFooter: a.display_header_footer, scale: a.scale }); if (!r || !r.data) throw new Error("No PDF returned"); if (r.data.length > 3 * 1024 * 1024) throw new Error("PDF too large to return inline. Run the local server for full file support."); return { content: textBlocks("PDF (base64, " + Math.round(r.data.length / 1024) + " KB):\n" + r.data) }; } },

  { name: "browser_set",
    description: "Configure browser behavior: viewport (width/height), device (preset), geo (latitude/longitude), offline, headers, media (color_scheme/reduced_motion).",
    parameters: { property: { type: "string", enum: ["viewport", "device", "geo", "offline", "headers", "media"] }, width: { type: "number" }, height: { type: "number" }, device_scale_factor: { type: "number" }, is_mobile: { type: "boolean" }, has_touch: { type: "boolean" }, device_name: { type: "string" }, latitude: { type: "number" }, longitude: { type: "number" }, offline: { type: "boolean" }, headers: { type: "object" }, color_scheme: { type: "string" }, reduced_motion: { type: "string" }, tab_id: { type: "number" } },
    required: ["property"],
    run: async (a) => { const r = await dispatch("set", { property: a.property, width: a.width, height: a.height, deviceScaleFactor: a.device_scale_factor, isMobile: a.is_mobile, hasTouch: a.has_touch, deviceName: a.device_name, latitude: a.latitude, longitude: a.longitude, offline: a.offline, headers: a.headers, colorScheme: a.color_scheme, reducedMotion: a.reduced_motion, tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },

  { name: "browser_window",
    description: "Manage windows: list, create (optional url), close (window_id).",
    parameters: { action: { type: "string", enum: ["list", "create", "close"] }, url: { type: "string" }, window_id: { type: "number" } },
    required: [],
    run: async (a) => { const r = await dispatch("window", { action: a.action || "list", url: a.url, windowId: a.window_id }); return { content: textBlocks(jsonOut(r)) }; } },

  { name: "browser_console",
    description: "View or clear console messages (filter, types). Capture starts on the first call - reload to capture early messages.",
    parameters: { action: { type: "string", enum: ["view", "clear"] }, filter: { type: "string" }, types: { type: "array", items: { type: "string" } }, clear: { type: "boolean" }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const r = await dispatch("console", { action: a.action || "view", filter: a.filter, types: a.types, clear: a.clear, tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },
  { name: "browser_errors",
    description: "View or clear uncaught JavaScript errors (filter). Capture starts on the first call - reload to capture early errors.",
    parameters: { action: { type: "string", enum: ["view", "clear"] }, filter: { type: "string" }, clear: { type: "boolean" }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const r = await dispatch("errors", { action: a.action || "view", filter: a.filter, clear: a.clear, tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },
  { name: "browser_network",
    description: "View or clear captured network requests (filter by URL substring). Capture starts on the first call - reload/navigate to capture.",
    parameters: { action: { type: "string", enum: ["view", "clear"] }, filter: { type: "string" }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const r = await dispatch("network", { action: a.action || "view", filter: a.filter, tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },
  { name: "browser_frames",
    description: "List all frames (iframes) in the current page. Returns frame IDs, URLs, names, and hierarchy.",
    parameters: { tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const r = await dispatch("frames", { tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },
  { name: "browser_touch",
    description: "Dispatch touch events: tap, swipe, long-press, or pinch.",
    parameters: { action: { type: "string", enum: ["tap", "swipe", "long-press", "pinch"] }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" }, end_x: { type: "number" }, end_y: { type: "number" }, scale: { type: "number" }, duration: { type: "number" }, tab_id: { type: "number" } },
    required: ["action"],
    run: async (a) => { if (!a.selector && (a.x === undefined || a.y === undefined)) throw new Error("Provide either selector or x,y coordinates"); const r = await dispatch("touch", { action: a.action, selector: a.selector, x: a.x, y: a.y, endX: a.end_x, endY: a.end_y, scale: a.scale, duration: a.duration, tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },
  { name: "browser_emulate",
    description: 'Emulate a mobile device or custom viewport. Action "clear" resets to defaults.',
    parameters: { action: { type: "string", enum: ["set", "clear"] }, width: { type: "number" }, height: { type: "number" }, device_scale_factor: { type: "number" }, is_mobile: { type: "boolean" }, has_touch: { type: "boolean" }, user_agent: { type: "string" }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const r = await dispatch("emulate", { action: a.action || "set", width: a.width, height: a.height, deviceScaleFactor: a.device_scale_factor, isMobile: a.is_mobile, hasTouch: a.has_touch, userAgent: a.user_agent, tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },
  { name: "browser_download",
    description: "Track and capture file downloads. Actions: list, wait, latest.",
    parameters: { action: { type: "string", enum: ["list", "wait", "latest"] }, timeout: { type: "number" }, tab_id: { type: "number" } },
    required: ["action"],
    run: async (a) => { const r = await dispatch("download", { action: a.action, timeout: a.timeout }); return { content: textBlocks(jsonOut(r)) }; } },
  { name: "browser_auth",
    description: "Handle HTTP Basic/Digest authentication popups. Actions: status, provide, cancel.",
    parameters: { action: { type: "string", enum: ["status", "provide", "cancel"] }, username: { type: "string" }, password: { type: "string" }, tab_id: { type: "number" } },
    required: ["action"],
    run: async (a) => { const r = await dispatch("auth", { action: a.action, username: a.username, password: a.password, tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },
  { name: "browser_store",
    description: "Store and retrieve data/scripts per-website in extension storage. Actions: set, get, list, delete, clear.",
    parameters: { action: { type: "string", enum: ["set", "get", "list", "delete", "clear"] }, key: { type: "string" }, value: { type: "string" }, description: { type: "string" }, tab_id: { type: "number" } },
    required: ["action"],
    run: async (a) => { const r = await dispatch("store", { action: a.action, key: a.key, value: a.value, description: a.description, tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },
  { name: "browser_cookies",
    description: "Read, set, or remove cookies for the current site. Actions: getAll, get, set, remove.",
    parameters: { action: { type: "string", enum: ["getAll", "get", "set", "remove"] }, url: { type: "string" }, domain: { type: "string" }, name: { type: "string" }, value: { type: "string" }, path: { type: "string" }, secure: { type: "boolean" }, http_only: { type: "boolean" }, same_site: { type: "string" }, expiration_date: { type: "number" }, tab_id: { type: "number" } },
    required: ["action"],
    run: async (a) => { const r = await dispatch("cookies", { action: a.action, url: a.url, domain: a.domain, name: a.name, value: a.value, path: a.path, secure: a.secure, httpOnly: a.http_only, sameSite: a.same_site, expirationDate: a.expiration_date, tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },
  { name: "browser_perms",
    description: "Grant or deny browser permissions for a site.",
    parameters: { action: { type: "string", enum: ["grant", "deny", "reset"] }, permissions: { type: "array", items: { type: "string" } }, origin: { type: "string" }, tab_id: { type: "number" } },
    required: ["action", "permissions"],
    run: async (a) => { const r = await dispatch("permissions", { action: a.action, permissions: a.permissions, origin: a.origin, tabId: a.tab_id }); return { content: textBlocks(jsonOut(r)) }; } },
  { name: "browser_upload",
    description: "Upload a file to a page input. Direct mode: pass content (base64) plus filename.",
    parameters: { selector: { type: "string" }, ref: { type: "string" }, file_id: { type: "string" }, content: { type: "string" }, filename: { type: "string" }, tab_id: { type: "number" } },
    required: [],
    run: async (a) => { const sel = a.ref ? resolveRefArg(a) : a.selector; const r = await dispatch("file_upload", { selector: sel, fileId: a.file_id, content: a.content, filename: a.filename, tabId: a.tab_id }); return { content: textBlocks(jsonOut({ uploaded: true, selector: sel || "(file chooser)", tab_id: r.tabId })) }; } },
  { name: "browser_file_read",
    description: "Read a file stored on the local server. Not available in direct mode.",
    parameters: { file_id: { type: "string" } }, required: ["file_id"],
    run: async () => { throw new Error("browser_file_read requires the local server"); } },
  ];

  async function handle(request) {
    const { id, method, params } = request || {};
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    try {
      if (method === "initialize") {
        return ok({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "browser-mcp", version: "0.1.0" },
        });
      }
      if (method === "notifications/initialized") return null;
      if (method === "ping") return ok({});
      if (method === "tools/list") {
        return ok({
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: t.parameters, required: t.required } })),
        });
      }
      if (method === "tools/call") {
        const { name, arguments: args } = params || {};
        const t = TOOLS.find((x) => x.name === name);
        if (!t) return err(-32601, "unknown tool: " + name);
        const resolved = resolveArgsRefs(name, args || {});
        try {
          const out = await t.run(resolved);
          return ok(out);
        } catch (e) {
          return ok({ content: errBlocks(e), isError: true });
        }
      }
      return err(-32601, "unknown method: " + method);
    } catch (e) {
      if (id == null) return null;
      return ok({ content: errBlocks(e), isError: true });
    }
  }

  return handle;
}
