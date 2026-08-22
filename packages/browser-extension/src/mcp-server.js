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
  function resetRefs() {
    refCache.clear();
    refCounter = 0;
  }
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
    if (!entry) throw new Error("Ref " + ref + " not found - run snapshot again");
    return entry.selector;
  }
  function resolveArgsRefs(name, args) {
    if (!args) return args;
    if (REF_SUPPORTING.has(name) && args.ref != null) {
      return { ...args, ref: undefined, selector: resolveRefArg(args) };
    }
    if (name === "drag") {
      let next = args;
      if (args.from_ref != null)
        next = { ...next, from_ref: undefined, from_selector: resolveRefArg({ ref: args.from_ref }) };
      if (args.to_ref != null) next = { ...next, to_ref: undefined, to_selector: resolveRefArg({ ref: args.to_ref }) };
      return next;
    }
    if (name === "wait" && args.mode === "selector" && args.ref != null) {
      return { ...args, ref: undefined, selector: resolveRefArg(args) };
    }
    return args;
  }

  const REF_SUPPORTING = new Set([
    "click",
    "type",
    "fill",
    "hover",
    "select",
    "screenshot",
    "check",
    "uncheck",
    "focus",
    "dblclick",
    "highlight",
    "get",
    "is",
    "upload",
  ]);
  const MAX_TEXT_OUTPUT = 50_000;
  function jsonOut(v) {
    if (typeof v === "string")
      return v.length > MAX_TEXT_OUTPUT ? v.slice(0, MAX_TEXT_OUTPUT) + "\n\n... (truncated)" : v;
    let s;
    try {
      s = JSON.stringify(v, null, 2);
    } catch {
      s = String(v);
    }
    return s.length > MAX_TEXT_OUTPUT ? s.slice(0, MAX_TEXT_OUTPUT) + "\n\n... (truncated)" : s;
  }
  const textBlocks = (text) => [{ type: "text", text }];
  const errBlocks = (e) => [{ type: "text", text: "ERROR: " + (e && e.message ? e.message : String(e)) }];

  const TOOLS = [
    {
      name: "status",
      description: "Check the browser extension connection status.",
      parameters: {},
      required: [],
      run: async () => ({
        content: textBlocks(
          jsonOut({ connected: true, extensions: 1, message: "Connected directly to the code-mcp gateway." }),
        ),
      }),
    },

    {
      name: "navigate",
      description: "Navigate a browser tab to a URL. Reuse an open tab via tab_id, otherwise a new tab is created.",
      parameters: {
        url: { type: "string", description: "URL to navigate to" },
        tab_id: { type: "number", description: "Target tab ID (optional)" },
        wait_for: { type: "string", description: "load (default) or domcontentloaded" },
      },
      required: ["url"],
      run: async (a) => {
        const r = await dispatch("navigate", { url: a.url, tabId: a.tab_id, waitFor: a.wait_for || "load" });
        return { content: textBlocks(jsonOut({ tab_id: r.tabId, url: r.url, title: r.title })) };
      },
    },

    {
      name: "screenshot",
      description:
        "Take a screenshot of the current tab. Returns a JPEG image content block. Prefer extract/execute for text. On anti-bot sites use stealth=true.",
      parameters: {
        tab_id: { type: "number" },
        selector: { type: "string" },
        full_page: { type: "boolean" },
        stealth: { type: "boolean" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("screenshot", {
          tabId: a.tab_id,
          selector: a.selector,
          fullPage: a.full_page,
          stealth: a.stealth,
        });
        if (!r || !r.dataUrl) throw new Error("No screenshot data");
        const m = r.dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.*)$/);
        const mime = m ? m[1] : "image/jpeg";
        const b64 = m ? m[2] : r.dataUrl.replace(/^data:image\/\w+;base64,/, "");
        return {
          content: [
            { type: "image", data: b64, mimeType: mime },
            { type: "text", text: jsonOut({ tab_id: r.tabId, width: r.width, height: r.height }) },
          ],
        };
      },
    },

    {
      name: "click",
      description:
        "Click an element (selector/ref) or coordinates. Supports right/middle buttons, click_count, pierce, intercept_file_chooser, stealth.",
      parameters: {
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        tab_id: { type: "number" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        click_count: { type: "number" },
        pierce: { type: "boolean" },
        intercept_file_chooser: { type: "boolean" },
        stealth: { type: "boolean" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("click", {
          selector: a.selector,
          x: a.x,
          y: a.y,
          tabId: a.tab_id,
          button: a.button || "left",
          clickCount: a.click_count,
          pierce: a.pierce,
          intercept_file_chooser: a.intercept_file_chooser,
          stealth: a.stealth,
        });
        const out = { clicked: true, element: r.element, tab_id: r.tabId };
        if (r.dialog_opened) {
          out.dialog_opened = true;
          out.dialog = r.dialog || null;
          out.hint = r.hint || "A JS dialog is open. Use the dialog tool (status/accept/dismiss) to continue.";
        }
        if (r.download_triggered) out.download_triggered = r.download_triggered;
        if (r.file_chooser_opened) out.file_chooser_opened = r.file_chooser_opened;
        return { content: textBlocks(jsonOut(out)) };
      },
    },

    {
      name: "type",
      description:
        "Type text into a focused element or a selector. clear_first clears before typing, press_enter presses Enter after.",
      parameters: {
        text: { type: "string" },
        selector: { type: "string" },
        tab_id: { type: "number" },
        clear_first: { type: "boolean" },
        press_enter: { type: "boolean" },
        pierce: { type: "boolean" },
        stealth: { type: "boolean" },
      },
      required: ["text"],
      run: async (a) => {
        const r = await dispatch("type", {
          text: a.text,
          selector: a.selector,
          tabId: a.tab_id,
          clearFirst: a.clear_first,
          pressEnter: a.press_enter,
          pierce: a.pierce,
          stealth: a.stealth,
        });
        return {
          content: textBlocks(
            jsonOut({ typed: true, text_length: String(a.text).length, element: r.element, tab_id: r.tabId }),
          ),
        };
      },
    },

    {
      name: "extract",
      description:
        "Extract text, links, forms, tables, accessibility tree, or html from the page (or a selector scope).",
      parameters: {
        mode: { type: "string", enum: ["text", "links", "forms", "tables", "accessibility", "html"] },
        selector: { type: "string" },
        tab_id: { type: "number" },
        frame_id: { type: "string" },
      },
      required: ["mode"],
      run: async (a) => {
        const r = await dispatch("extract", {
          mode: a.mode,
          selector: a.selector,
          tabId: a.tab_id,
          frameId: a.frame_id,
        });
        return { content: textBlocks(jsonOut(r && r.data)) };
      },
    },

    {
      name: "tabs",
      description: "List, close, or activate browser tabs.",
      parameters: { action: { type: "string", enum: ["list", "close", "activate"] }, tab_id: { type: "number" } },
      required: [],
      run: async (a) => {
        const r = await dispatch("tabs", { action: a.action || "list", tabId: a.tab_id });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "execute",
      description: "Execute JavaScript in the page. Pass code, or script_id (stored via store) + script_args.",
      parameters: {
        code: { type: "string" },
        script_id: { type: "string" },
        script_args: { type: "object" },
        tab_id: { type: "number" },
        frame_id: { type: "string" },
        stealth: { type: "boolean" },
      },
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
        if (r && r.dialog_opened) {
          return {
            content: textBlocks(
              jsonOut({
                value: null,
                dialog_opened: true,
                dialog: r.dialog || null,
                hint:
                  r.hint ||
                  "The executed script opened a JS dialog. Use the dialog tool (status/accept/dismiss) to continue.",
              }),
            ),
          };
        }
        return { content: textBlocks(r && r.value !== undefined ? jsonOut(r.value) : "(undefined)") };
      },
    },
    {
      name: "scroll",
      description:
        "Scroll the page or a scroll area. Without selector/coordinates it scrolls at the agent cursor's position (so nested scroll areas under the cursor work). Direction: up, down, left, or right (horizontal supported). Selector scrolls that element; x/y scroll at those coordinates.",
      parameters: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number" },
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        tab_id: { type: "number" },
        stealth: { type: "boolean" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("scroll", {
          direction: a.direction || "down",
          amount: a.amount,
          selector: a.selector,
          x: a.x,
          y: a.y,
          tabId: a.tab_id,
          stealth: a.stealth,
        });
        return {
          content: textBlocks(jsonOut({ scrolled: true, direction: r.direction, amount: r.amount, tab_id: r.tabId })),
        };
      },
    },

    {
      name: "hover",
      description: "Hover over an element (selector/ref or coordinates) to reveal tooltips/menus.",
      parameters: {
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        tab_id: { type: "number" },
        pierce: { type: "boolean" },
        stealth: { type: "boolean" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("hover", {
          selector: a.selector,
          x: a.x,
          y: a.y,
          tabId: a.tab_id,
          pierce: a.pierce,
          stealth: a.stealth,
        });
        return { content: textBlocks(jsonOut({ hovered: true, element: r.element, tab_id: r.tabId })) };
      },
    },

    {
      name: "mouse_move",
      description: "Move the mouse to coordinates (steps for smoother travel).",
      parameters: {
        x: { type: "number" },
        y: { type: "number" },
        steps: { type: "number" },
        tab_id: { type: "number" },
      },
      required: ["x", "y"],
      run: async (a) => {
        const r = await dispatch("mouse_move", { x: a.x, y: a.y, steps: a.steps, tabId: a.tab_id });
        return { content: textBlocks(jsonOut({ moved: true, tab_id: r.tabId })) };
      },
    },

    {
      name: "drag",
      description: "Drag and drop from a source to a target (selectors/refs or coordinates).",
      parameters: {
        from_selector: { type: "string" },
        from_x: { type: "number" },
        from_y: { type: "number" },
        to_selector: { type: "string" },
        to_x: { type: "number" },
        to_y: { type: "number" },
        tab_id: { type: "number" },
        steps: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("drag", {
          fromSelector: a.from_selector,
          fromX: a.from_x,
          fromY: a.from_y,
          toSelector: a.to_selector,
          toX: a.to_x,
          toY: a.to_y,
          tabId: a.tab_id,
          steps: a.steps,
        });
        return { content: textBlocks(jsonOut({ dragged: true, from: r.from, to: r.to, tab_id: r.tabId })) };
      },
    },

    {
      name: "press",
      description: "Press a keyboard key with optional modifiers (ctrl/shift/alt/meta).",
      parameters: {
        key: { type: "string", description: "Enter, Tab, Escape, ArrowUp, F1-F12, or any character" },
        modifiers: { type: "array", items: { type: "string" } },
        tab_id: { type: "number" },
        stealth: { type: "boolean" },
      },
      required: ["key"],
      run: async (a) => {
        const r = await dispatch("keypress", {
          key: a.key,
          modifiers: a.modifiers,
          tabId: a.tab_id,
          stealth: a.stealth,
        });
        return { content: textBlocks(jsonOut({ pressed: true, key: r.key, modifiers: r.modifiers, tab_id: r.tabId })) };
      },
    },

    {
      name: "select",
      description: "Select an option in a select by value, text, or index.",
      parameters: {
        selector: { type: "string" },
        value: { type: "string" },
        text: { type: "string" },
        index: { type: "number" },
        tab_id: { type: "number" },
      },
      required: ["selector"],
      run: async (a) => {
        const r = await dispatch("select", {
          selector: a.selector,
          value: a.value,
          text: a.text,
          index: a.index,
          tabId: a.tab_id,
        });
        return {
          content: textBlocks(
            jsonOut({ selected: true, value: r.selected, text: r.text, index: r.index, tab_id: r.tabId }),
          ),
        };
      },
    },

    {
      name: "dialog",
      description:
        "Handle a JavaScript dialog. Actions: status (inspect an open dialog without dismissing), accept (OK/Enter, optional prompt_text for prompt dialogs), dismiss (Cancel).",
      parameters: {
        action: { type: "string", enum: ["status", "accept", "dismiss"] },
        prompt_text: { type: "string" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("dialog", {
          action: a.action || "accept",
          promptText: a.prompt_text,
          tabId: a.tab_id,
        });
        const out = { handled: r.handled, type: r.type, tab_id: r.tabId };
        if (r.dialogMessage !== undefined) out.dialog_message = r.dialogMessage;
        if (r.message !== undefined) out.message = r.message;
        if (r.pending !== undefined) out.pending = r.pending;
        if (r.default_prompt !== undefined) out.default_prompt = r.default_prompt;
        return { content: textBlocks(jsonOut(out)) };
      },
    },

    {
      name: "back",
      description: "Go back in history.",
      parameters: { tab_id: { type: "number" } },
      required: [],
      run: async (a) => {
        const r = await dispatch("back", { tabId: a.tab_id });
        return { content: textBlocks(jsonOut({ navigated: "back", url: r.url, title: r.title, tab_id: r.tabId })) };
      },
    },
    {
      name: "forward",
      description: "Go forward in history.",
      parameters: { tab_id: { type: "number" } },
      required: [],
      run: async (a) => {
        const r = await dispatch("forward", { tabId: a.tab_id });
        return { content: textBlocks(jsonOut({ navigated: "forward", url: r.url, title: r.title, tab_id: r.tabId })) };
      },
    },
    {
      name: "reload",
      description: "Reload the current page.",
      parameters: { tab_id: { type: "number" } },
      required: [],
      run: async (a) => {
        const r = await dispatch("reload", { tabId: a.tab_id });
        return { content: textBlocks(jsonOut({ reloaded: true, url: r.url, title: r.title, tab_id: r.tabId })) };
      },
    },
    {
      name: "close",
      description: "Close a browser tab (defaults to the active tab).",
      parameters: { tab_id: { type: "number" } },
      required: [],
      run: async (a) => {
        const r = await dispatch("close", { tabId: a.tab_id });
        return { content: textBlocks(jsonOut({ closed: r.closed })) };
      },
    },
    {
      name: "wait",
      description:
        "Wait for a condition: timeout, load, url (substring/regex), text (page contains), selector (element appears via ref/selector).",
      parameters: {
        mode: { type: "string", enum: ["timeout", "load", "url", "text", "selector"] },
        timeout: { type: "number" },
        url: { type: "string" },
        text: { type: "string" },
        ref: { type: "string" },
        selector: { type: "string" },
        state: { type: "string", enum: ["load", "domcontentloaded"] },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const sel = a.mode === "selector" && a.ref ? resolveRefArg(a) : a.selector;
        const r = await dispatch("wait", {
          mode: a.mode || "timeout",
          selector: sel,
          text: a.text,
          url: a.url,
          timeout: a.timeout,
          state: a.state,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "highlight",
      description: "Flash a highlight box around an element so the user can see what the agent is targeting.",
      parameters: {
        selector: { type: "string" },
        ref: { type: "string" },
        duration: { type: "number" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("highlight", {
          selector: a.ref ? resolveRefArg(a) : a.selector,
          duration: a.duration,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut({ highlighted: a.selector || a.ref, tab_id: r.tabId })) };
      },
    },

    {
      name: "snapshot",
      description:
        'Capture the interactive element tree with refs (e.g. button "Submit" [ref=e4]). Use refs with interaction tools. Refs valid until the next snapshot/navigation.',
      parameters: {
        interactive: { type: "boolean" },
        cursor: { type: "boolean" },
        include_headings: { type: "boolean" },
        max: { type: "number" },
        scope: { type: "string" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("snapshot", {
          interactive: a.interactive,
          cursor: a.cursor,
          max: a.max,
          includeHeadings: a.include_headings,
          scope: a.scope,
          tabId: a.tab_id,
        });
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
        return {
          content: textBlocks(
            "page: " +
              ((r && r.url) || "") +
              " - " +
              entries.length +
              " element" +
              (entries.length === 1 ? "" : "s") +
              " (refs valid until next snapshot)\n" +
              body,
          ),
        };
      },
    },

    {
      name: "find",
      description:
        "Semantic element search: role, name, text, label, placeholder, title, testid, selector. Returns matches with refs.",
      parameters: {
        role: { type: "string" },
        name: { type: "string" },
        text: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        title: { type: "string" },
        testid: { type: "string" },
        selector: { type: "string" },
        exact: { type: "boolean" },
        max: { type: "number" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("find", {
          role: a.role,
          name: a.name,
          text: a.text,
          label: a.label,
          placeholder: a.placeholder,
          title: a.title,
          testid: a.testid,
          selector: a.selector,
          exact: a.exact,
          max: a.max,
          tabId: a.tab_id,
        });
        const matches = (r && r.matches) || [];
        const lines = [];
        for (const m of matches) {
          refCounter++;
          const ref = "e" + refCounter;
          storeRef(ref, { selector: m.selector || "", role: m.role || "", name: m.name || "", ts: Date.now() });
          lines.push(
            (m.role || m.tag) +
              " " +
              JSON.stringify(String(m.name || m.text || "").slice(0, 60)) +
              " [ref=" +
              ref +
              "]",
          );
        }
        return {
          content: textBlocks(
            "found " +
              matches.length +
              " match" +
              (matches.length === 1 ? "" : "es") +
              (lines.length ? "\n" + lines.map((l) => "  " + l).join("\n") : ""),
          ),
        };
      },
    },

    {
      name: "get",
      description:
        "Get element/page info: text, html, value, attribute (attr), url, title, count, box, styles (style_property). Target with ref or selector.",
      parameters: {
        property: {
          type: "string",
          enum: ["text", "html", "value", "attribute", "url", "title", "count", "box", "styles"],
        },
        ref: { type: "string" },
        selector: { type: "string" },
        attr: { type: "string" },
        style_property: { type: "string" },
        tab_id: { type: "number" },
      },
      required: ["property"],
      run: async (a) => {
        const sel = a.ref ? resolveRefArg(a) : a.selector;
        if (!sel) throw new Error("ref or selector required");
        const r = await dispatch("get_element", {
          selector: sel,
          property: a.property,
          attr: a.attr || null,
          styleProperty: a.style_property || null,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "is",
      description:
        "Check element state: visible, hidden, enabled, disabled, checked, unchecked, editable, readonly, focused. Returns true/false.",
      parameters: {
        check: {
          type: "string",
          enum: ["visible", "hidden", "enabled", "disabled", "checked", "unchecked", "editable", "readonly", "focused"],
        },
        ref: { type: "string" },
        selector: { type: "string" },
        tab_id: { type: "number" },
      },
      required: ["check"],
      run: async (a) => {
        const sel = a.ref ? resolveRefArg(a) : a.selector;
        if (!sel) throw new Error("ref or selector required");
        const r = await dispatch("is_element", { selector: sel, check: a.check, tabId: a.tab_id });
        return { content: textBlocks(String(r && r.result)) };
      },
    },

    {
      name: "fill",
      description: "Fill an input: clear it, then type the text. Target with ref or selector.",
      parameters: {
        text: { type: "string" },
        ref: { type: "string" },
        selector: { type: "string" },
        press_enter: { type: "boolean" },
        tab_id: { type: "number" },
      },
      required: ["text"],
      run: async (a) => {
        const sel = a.ref ? resolveRefArg(a) : a.selector;
        const r = await dispatch("fill", { text: a.text, selector: sel, tabId: a.tab_id, pressEnter: a.press_enter });
        return { content: textBlocks(jsonOut({ filled: true, element: sel, tab_id: r.tabId })) };
      },
    },

    {
      name: "check",
      description: "Check a checkbox/radio (no-op if already checked). Target with ref or selector.",
      parameters: { ref: { type: "string" }, selector: { type: "string" }, tab_id: { type: "number" } },
      required: [],
      run: async (a) => {
        const sel = a.ref ? resolveRefArg(a) : a.selector;
        if (!sel) throw new Error("ref or selector required");
        const r = await dispatch("check", { selector: sel, tabId: a.tab_id });
        return { content: textBlocks(jsonOut({ checked: true, already: !!r.already, tab_id: r.tabId })) };
      },
    },
    {
      name: "uncheck",
      description: "Uncheck a checkbox/radio (no-op if already unchecked). Target with ref or selector.",
      parameters: { ref: { type: "string" }, selector: { type: "string" }, tab_id: { type: "number" } },
      required: [],
      run: async (a) => {
        const sel = a.ref ? resolveRefArg(a) : a.selector;
        if (!sel) throw new Error("ref or selector required");
        const r = await dispatch("uncheck", { selector: sel, tabId: a.tab_id });
        return { content: textBlocks(jsonOut({ checked: false, already: !!r.already, tab_id: r.tabId })) };
      },
    },
    {
      name: "focus",
      description: "Focus an element (scrolls into view). Target with ref or selector.",
      parameters: { ref: { type: "string" }, selector: { type: "string" }, tab_id: { type: "number" } },
      required: [],
      run: async (a) => {
        const sel = a.ref ? resolveRefArg(a) : a.selector;
        if (!sel) throw new Error("ref or selector required");
        const r = await dispatch("focus", { selector: sel, tabId: a.tab_id });
        return { content: textBlocks(jsonOut({ focused: true, element: sel, tab_id: r.tabId })) };
      },
    },
    {
      name: "dblclick",
      description: "Double-click an element. Target with ref, selector, or coordinates.",
      parameters: {
        ref: { type: "string" },
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        tab_id: { type: "number" },
        stealth: { type: "boolean" },
      },
      required: [],
      run: async (a) => {
        const sel = a.ref ? resolveRefArg(a) : a.selector;
        const r = await dispatch("dblclick", { selector: sel, x: a.x, y: a.y, tabId: a.tab_id, stealth: a.stealth });
        return { content: textBlocks(jsonOut({ double_clicked: true, element: r.element, tab_id: r.tabId })) };
      },
    },
    {
      name: "storage",
      description:
        "Read/write/clear localStorage or sessionStorage. type: local (default) or session. Actions: get, set, remove, clear.",
      parameters: {
        action: { type: "string", enum: ["get", "set", "remove", "clear"] },
        type: { type: "string", enum: ["local", "session"] },
        key: { type: "string" },
        value: { type: "string" },
        tab_id: { type: "number" },
      },
      required: ["action"],
      run: async (a) => {
        const r = await dispatch("storage", {
          action: a.action || "get",
          type: a.type || "local",
          key: a.key,
          value: a.value,
          tabId: a.tab_id,
        });
        if (r && r.error) throw new Error(r.error);
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "pdf",
      description:
        "Export the page as a PDF. Returns the PDF as base64 text (up to 2 MiB; larger PDFs return an error - run the local server for full file support).",
      parameters: {
        format: { type: "string", enum: ["letter", "a4", "a3", "a5", "legal", "tabloid"] },
        landscape: { type: "boolean" },
        print_background: { type: "boolean" },
        display_header_footer: { type: "boolean" },
        scale: { type: "number" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("pdf", {
          tabId: a.tab_id,
          format: a.format,
          landscape: a.landscape,
          printBackground: a.print_background,
          displayHeaderFooter: a.display_header_footer,
          scale: a.scale,
        });
        if (!r || !r.data) throw new Error("No PDF returned");
        if (r.data.length > 3 * 1024 * 1024)
          throw new Error("PDF too large to return inline. Run the local server for full file support.");
        return { content: textBlocks("PDF (base64, " + Math.round(r.data.length / 1024) + " KB):\n" + r.data) };
      },
    },

    {
      name: "set",
      description:
        "Configure browser behavior: viewport (width/height), device (preset), geo (latitude/longitude), offline, headers, media (color_scheme/reduced_motion).",
      parameters: {
        property: { type: "string", enum: ["viewport", "device", "geo", "offline", "headers", "media"] },
        width: { type: "number" },
        height: { type: "number" },
        device_scale_factor: { type: "number" },
        is_mobile: { type: "boolean" },
        has_touch: { type: "boolean" },
        device_name: { type: "string" },
        latitude: { type: "number" },
        longitude: { type: "number" },
        offline: { type: "boolean" },
        headers: { type: "object" },
        color_scheme: { type: "string" },
        reduced_motion: { type: "string" },
        tab_id: { type: "number" },
      },
      required: ["property"],
      run: async (a) => {
        const r = await dispatch("set", {
          property: a.property,
          width: a.width,
          height: a.height,
          deviceScaleFactor: a.device_scale_factor,
          isMobile: a.is_mobile,
          hasTouch: a.has_touch,
          deviceName: a.device_name,
          latitude: a.latitude,
          longitude: a.longitude,
          offline: a.offline,
          headers: a.headers,
          colorScheme: a.color_scheme,
          reducedMotion: a.reduced_motion,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "window",
      description: "Manage windows: list, create (optional url), close (window_id).",
      parameters: {
        action: { type: "string", enum: ["list", "create", "close"] },
        url: { type: "string" },
        window_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("window", { action: a.action || "list", url: a.url, windowId: a.window_id });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "console",
      description:
        "View or clear console messages (filter, types). Capture starts on the first call - reload to capture early messages.",
      parameters: {
        action: { type: "string", enum: ["view", "clear"] },
        filter: { type: "string" },
        types: { type: "array", items: { type: "string" } },
        clear: { type: "boolean" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("console", {
          action: a.action || "view",
          filter: a.filter,
          types: a.types,
          clear: a.clear,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },
    {
      name: "errors",
      description:
        "View or clear uncaught JavaScript errors (filter). Capture starts on the first call - reload to capture early errors.",
      parameters: {
        action: { type: "string", enum: ["view", "clear"] },
        filter: { type: "string" },
        clear: { type: "boolean" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("errors", {
          action: a.action || "view",
          filter: a.filter,
          clear: a.clear,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },
    {
      name: "network",
      description:
        "View or clear captured network requests (filter by URL substring). Capture starts on the first call - reload/navigate to capture.",
      parameters: {
        action: { type: "string", enum: ["view", "clear"] },
        filter: { type: "string" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("network", { action: a.action || "view", filter: a.filter, tabId: a.tab_id });
        return { content: textBlocks(jsonOut(r)) };
      },
    },
    {
      name: "frames",
      description: "List all frames (iframes) in the current page. Returns frame IDs, URLs, names, and hierarchy.",
      parameters: { tab_id: { type: "number" } },
      required: [],
      run: async (a) => {
        const r = await dispatch("frames", { tabId: a.tab_id });
        return { content: textBlocks(jsonOut(r)) };
      },
    },
    {
      name: "touch",
      description: "Dispatch touch events: tap, swipe, long-press, or pinch.",
      parameters: {
        action: { type: "string", enum: ["tap", "swipe", "long-press", "pinch"] },
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        end_x: { type: "number" },
        end_y: { type: "number" },
        scale: { type: "number" },
        duration: { type: "number" },
        tab_id: { type: "number" },
      },
      required: ["action"],
      run: async (a) => {
        if (!a.selector && (a.x === undefined || a.y === undefined))
          throw new Error("Provide either selector or x,y coordinates");
        const r = await dispatch("touch", {
          action: a.action,
          selector: a.selector,
          x: a.x,
          y: a.y,
          endX: a.end_x,
          endY: a.end_y,
          scale: a.scale,
          duration: a.duration,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },
    {
      name: "emulate",
      description: 'Emulate a mobile device or custom viewport. Action "clear" resets to defaults.',
      parameters: {
        action: { type: "string", enum: ["set", "clear"] },
        width: { type: "number" },
        height: { type: "number" },
        device_scale_factor: { type: "number" },
        is_mobile: { type: "boolean" },
        has_touch: { type: "boolean" },
        user_agent: { type: "string" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("emulate", {
          action: a.action || "set",
          width: a.width,
          height: a.height,
          deviceScaleFactor: a.device_scale_factor,
          isMobile: a.is_mobile,
          hasTouch: a.has_touch,
          userAgent: a.user_agent,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },
    {
      name: "download",
      description: "Track and capture file downloads. Actions: list, wait, latest.",
      parameters: {
        action: { type: "string", enum: ["list", "wait", "latest"] },
        timeout: { type: "number" },
        tab_id: { type: "number" },
      },
      required: ["action"],
      run: async (a) => {
        const r = await dispatch("download", { action: a.action, timeout: a.timeout });
        return { content: textBlocks(jsonOut(r)) };
      },
    },
    {
      name: "auth",
      description:
        "Handle HTTP Basic/Digest authentication popups. Actions: status, provide, cancel. provide accepts username+password, or vault_name to pull credentials from the unlocked vault (never crosses the gateway).",
      parameters: {
        action: { type: "string", enum: ["status", "provide", "cancel"] },
        username: { type: "string" },
        password: { type: "string" },
        vault_name: { type: "string" },
        tab_id: { type: "number" },
      },
      required: ["action"],
      run: async (a) => {
        const r = await dispatch("auth", {
          action: a.action,
          username: a.username,
          password: a.password,
          vaultName: a.vault_name,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },
    {
      name: "store",
      description:
        "Store and retrieve data/scripts per-website in extension storage. Actions: set, get, list, delete, clear.",
      parameters: {
        action: { type: "string", enum: ["set", "get", "list", "delete", "clear"] },
        key: { type: "string" },
        value: { type: "string" },
        description: { type: "string" },
        tab_id: { type: "number" },
      },
      required: ["action"],
      run: async (a) => {
        const r = await dispatch("store", {
          action: a.action,
          key: a.key,
          value: a.value,
          description: a.description,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },
    {
      name: "cookies",
      description: "Read, set, or remove cookies for the current site. Actions: getAll, get, set, remove.",
      parameters: {
        action: { type: "string", enum: ["getAll", "get", "set", "remove"] },
        url: { type: "string" },
        domain: { type: "string" },
        name: { type: "string" },
        value: { type: "string" },
        path: { type: "string" },
        secure: { type: "boolean" },
        http_only: { type: "boolean" },
        same_site: { type: "string" },
        expiration_date: { type: "number" },
        tab_id: { type: "number" },
      },
      required: ["action"],
      run: async (a) => {
        const r = await dispatch("cookies", {
          action: a.action,
          url: a.url,
          domain: a.domain,
          name: a.name,
          value: a.value,
          path: a.path,
          secure: a.secure,
          httpOnly: a.http_only,
          sameSite: a.same_site,
          expirationDate: a.expiration_date,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },
    {
      name: "perms",
      description: "Grant or deny browser permissions for a site.",
      parameters: {
        action: { type: "string", enum: ["grant", "deny", "reset"] },
        permissions: { type: "array", items: { type: "string" } },
        origin: { type: "string" },
        tab_id: { type: "number" },
      },
      required: ["action", "permissions"],
      run: async (a) => {
        const r = await dispatch("permissions", {
          action: a.action,
          permissions: a.permissions,
          origin: a.origin,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },
    {
      name: "upload",
      description: "Upload a file to a page input. Direct mode: pass content (base64) plus filename.",
      parameters: {
        selector: { type: "string" },
        ref: { type: "string" },
        file_id: { type: "string" },
        content: { type: "string" },
        filename: { type: "string" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const sel = a.ref ? resolveRefArg(a) : a.selector;
        const r = await dispatch("file_upload", {
          selector: sel,
          fileId: a.file_id,
          content: a.content,
          filename: a.filename,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut({ uploaded: true, selector: sel || "(file chooser)", tab_id: r.tabId })) };
      },
    },
    {
      name: "file_read",
      description: "Read a file stored on the local server. Not available in direct mode.",
      parameters: { file_id: { type: "string" } },
      required: ["file_id"],
      run: async () => {
        throw new Error("file_read requires the local server");
      },
    },

    {
      name: "history",
      description:
        "Browser history. Actions: search (query - recent history items), visits (url - visit timestamps for one URL), clear (delete all history).",
      parameters: {
        action: { type: "string", enum: ["search", "visits", "clear"] },
        query: { type: "string" },
        url: { type: "string" },
        max_results: { type: "number" },
      },
      required: ["action"],
      run: async (a) => {
        const r = await dispatch("history", {
          action: a.action,
          query: a.query,
          url: a.url,
          maxResults: a.max_results,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "notify",
      description:
        "Show a Chrome desktop notification (alerts the user even when Chrome is in the background). If url is given, clicking the notification opens it.",
      parameters: {
        title: { type: "string" },
        message: { type: "string" },
        url: { type: "string" },
        priority: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("notify", { title: a.title, message: a.message, url: a.url, priority: a.priority });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "groups",
      description:
        "Manage Chrome tab groups. Actions: list, create (tab_ids + optional title/color), add (tab_ids + group_id), remove (tab_ids), update (group_id + title/color/collapsed), list_tabs (group_id).",
      parameters: {
        action: { type: "string", enum: ["list", "create", "add", "remove", "update", "list_tabs"] },
        tab_ids: { type: "array", items: { type: "number" } },
        group_id: { type: "number" },
        title: { type: "string" },
        color: { type: "string" },
        collapsed: { type: "boolean" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("groups", {
          action: a.action || "list",
          tabIds: a.tab_ids,
          groupId: a.group_id,
          title: a.title,
          color: a.color,
          collapsed: a.collapsed,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "bookmarks",
      description:
        "Manage browser bookmarks. Actions: tree (all bookmarks), create (title + optional parent_id/url), search (query).",
      parameters: {
        action: { type: "string", enum: ["tree", "create", "search"] },
        parent_id: { type: "string" },
        title: { type: "string" },
        url: { type: "string" },
        query: { type: "string" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("bookmarks", {
          action: a.action || "tree",
          parentId: a.parent_id,
          title: a.title,
          url: a.url,
          query: a.query,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "session",
      description:
        "Browser session tools. Actions: recent (recently closed tabs/windows), restore (reopen the most recently closed tab/window).",
      parameters: { action: { type: "string", enum: ["recent", "restore"] }, max_results: { type: "number" } },
      required: [],
      run: async (a) => {
        const r = await dispatch("session", { action: a.action || "recent", maxResults: a.max_results });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "intercept",
      description:
        "Intercept network requests in a tab. Actions: enable (patterns - url substrings, empty = all), status (paused requests), continue (request_id or url), fail (request_id/url + error_reason), fulfill (request_id/url + status/body/content_type/headers), stop.",
      parameters: {
        action: { type: "string", enum: ["enable", "stop", "status", "continue", "fail", "fulfill"] },
        patterns: { type: "array", items: { type: "string" } },
        request_id: { type: "string" },
        url: { type: "string" },
        status: { type: "number" },
        body: { type: "string" },
        content_type: { type: "string" },
        headers: { type: "object" },
        error_reason: { type: "string" },
        tab_id: { type: "number" },
      },
      required: ["action"],
      run: async (a) => {
        const r = await dispatch("intercept", {
          action: a.action,
          patterns: a.patterns,
          requestId: a.request_id,
          url: a.url,
          status: a.status,
          body: a.body,
          contentType: a.content_type,
          headers: a.headers,
          errorReason: a.error_reason,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "har",
      description:
        "Export the captured network requests for a tab as HAR 1.2 JSON. Requires network capture to have been active while the page loaded.",
      parameters: { tab_id: { type: "number" } },
      required: [],
      run: async (a) => {
        const r = await dispatch("har", { tabId: a.tab_id });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "ws",
      description:
        "View or clear captured WebSocket frames for a tab (filter by URL substring). Capture starts on the first call - reload to capture early frames.",
      parameters: {
        action: { type: "string", enum: ["view", "clear"] },
        filter: { type: "string" },
        clear: { type: "boolean" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("ws", {
          action: a.action || "view",
          filter: a.filter,
          clear: a.clear,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "throttle",
      description:
        "Simulate network conditions. Presets: offline, slow-3g, 3g, 4g, wifi. Or pass custom latency (ms) / download_throughput / upload_throughput (bytes/sec). clear resets to normal.",
      parameters: {
        preset: { type: "string", enum: ["offline", "slow-3g", "3g", "4g", "wifi"] },
        latency: { type: "number" },
        download_throughput: { type: "number" },
        upload_throughput: { type: "number" },
        clear: { type: "boolean" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("throttle", {
          preset: a.preset,
          latency: a.latency,
          downloadThroughput: a.download_throughput,
          uploadThroughput: a.upload_throughput,
          clear: a.clear,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "resources",
      description:
        "Inspect page resources. Actions: list (resources loaded by the page via Performance API), read (url - read a resource body from the browser cache; requires network capture active while it loaded).",
      parameters: {
        action: { type: "string", enum: ["list", "read"] },
        url: { type: "string" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("resources", { action: a.action || "list", url: a.url, tabId: a.tab_id });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "coverage",
      description:
        "CSS usage coverage. Actions: start (begin tracking), stop (stop + report), report (one-shot measure: starts, waits wait_ms, reports). Returns per-stylesheet used percentages.",
      parameters: {
        action: { type: "string", enum: ["start", "stop", "report"] },
        wait_ms: { type: "number" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("coverage", { action: a.action || "report", waitMs: a.wait_ms, tabId: a.tab_id });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "pseudo",
      description:
        "Force CSS pseudo-class states (:hover/:focus/:active/...) on an element so you can inspect hover/focus styles without real interaction. action=clear resets.",
      parameters: {
        action: { type: "string", enum: ["force", "clear"] },
        selector: { type: "string" },
        states: { type: "array", items: { type: "string" } },
        tab_id: { type: "number" },
      },
      required: ["selector"],
      run: async (a) => {
        const r = await dispatch("pseudo", {
          action: a.action || "force",
          selector: a.selector,
          states: a.states,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "styles",
      description:
        "Get computed styles and matched CSS rules for an element (selector or ref). Optionally filter computed styles by property.",
      parameters: {
        ref: { type: "string" },
        selector: { type: "string" },
        property: { type: "string" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("styles", { ref: a.ref, selector: a.selector, property: a.property, tabId: a.tab_id });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "site_data",
      description:
        "Clear site data for an origin (cookies, local_storage, cache, indexed_db, service_workers). Defaults to the current tab's origin.",
      parameters: {
        origin: { type: "string" },
        cookies: { type: "boolean" },
        local_storage: { type: "boolean" },
        cache: { type: "boolean" },
        indexed_db: { type: "boolean" },
        service_workers: { type: "boolean" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("site_data", {
          origin: a.origin,
          cookies: a.cookies,
          localStorage: a.local_storage,
          cache: a.cache,
          indexedDB: a.indexed_db,
          serviceWorkers: a.service_workers,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "extension",
      description:
        "Extension diagnostics. Actions: state (version, mode, captures, vault status), reload (reload the extension), reconnect (force gateway reconnect).",
      parameters: { action: { type: "string", enum: ["state", "reload", "reconnect"] } },
      required: [],
      run: async (a) => {
        const r = await dispatch("extension", { action: a.action || "state" });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "record",
      description:
        "Record the browser. Actions: start (record a tab - no prompt, no picker, no toolbar click needed; CDP screencast, video-only by default), window/screen (Chrome share dialog - required by the browser), status, stop (save to Downloads, no dialog). Multi-tab session: session_start (begin ONE continuous recording), tab (tab_id - switch which tab is recorded into the same session), session_stop (finish the combined session recording). include_audio=true uses chrome.tabCapture for real tab audio (requires one toolbar click on that tab - Chrome security rule; falls back to the share picker otherwise). save_as=true opts into Save As. WebM, saved via chrome.downloads.",
      parameters: {
        action: {
          type: "string",
          enum: ["start", "window", "screen", "status", "stop", "session_start", "tab", "session_stop"],
        },
        tab_id: { type: "number" },
        include_audio: { type: "boolean" },
        save_as: { type: "boolean" },
        filename: { type: "string" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("record", {
          action: a.action || "status",
          tabId: a.tab_id,
          includeAudio: a.include_audio,
          saveAs: a.save_as,
          filename: a.filename,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "speak",
      description:
        "Make the agent speak aloud via the browser's native text-to-speech (English-first; works in Chrome and Edge). Plays through the current tab so it is audible AND captured by tab recording. Actions: say (text + optional voice/rate/pitch/volume/block), voices (list available voices), stop, status.",
      parameters: {
        action: { type: "string", enum: ["say", "voices", "stop", "status"] },
        text: { type: "string" },
        voice: { type: "string" },
        rate: { type: "number" },
        pitch: { type: "number" },
        volume: { type: "number" },
        lang: { type: "string" },
        block: { type: "boolean" },
        tab_id: { type: "number" },
      },
      required: [],
      run: async (a) => {
        const r = await dispatch("speak", {
          action: a.action || "say",
          text: a.text,
          voice: a.voice,
          rate: a.rate,
          pitch: a.pitch,
          volume: a.volume,
          lang: a.lang,
          block: a.block,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },

    {
      name: "vault",
      description:
        "Encrypted in-browser credential store (like a password manager). Actions: init (create vault with master password), unlock (master), lock, status, set (origin/name/username/password/url), get (origin/name - returns credentials), list, delete, fill (fill a login form on the current page from the vault - credentials never leave the extension).",
      parameters: {
        action: { type: "string", enum: ["init", "unlock", "lock", "status", "set", "get", "list", "delete", "fill"] },
        master: { type: "string" },
        origin: { type: "string" },
        name: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        url: { type: "string" },
        username_selector: { type: "string" },
        password_selector: { type: "string" },
        submit: { type: "boolean" },
        tab_id: { type: "number" },
      },
      required: ["action"],
      run: async (a) => {
        const r = await dispatch("vault", {
          action: a.action,
          master: a.master,
          origin: a.origin,
          name: a.name,
          username: a.username,
          password: a.password,
          url: a.url,
          usernameSelector: a.username_selector,
          passwordSelector: a.password_selector,
          submit: a.submit,
          tabId: a.tab_id,
        });
        return { content: textBlocks(jsonOut(r)) };
      },
    },
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
          serverInfo: { name: "browser-mcp", version: "0.2.0" },
        });
      }
      // Notifications have no id. The gateway always serializes the device
      // response as JSON, so return a parseable empty result (codex/pi reject
      // a literal null body).
      if (method === "notifications/initialized") return { jsonrpc: "2.0", id: null, result: {} };
      if (method === "ping") return ok({});
      if (method === "tools/list") {
        return ok({
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: { type: "object", properties: t.parameters, required: t.required },
          })),
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
      return { jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message: String((e && e.message) || e) } };
    }
  }

  return handle;
}
