# Browser MCP Extension

Chrome/Edge extension (Manifest V3) that exposes your browser as **MCP tools** for
any AI agent. It works two ways:

- **Direct (default)** — enter a **Device ID** (+ optional **Token**) in the popup
  and the extension connects straight to the code-mcp gateway
  (`wss://code-mcp.tuanm.dev/ws/<id>`) and **serves MCP itself**. No local server
  is needed.
- **Local bridge** — with the optional `browser-mcp.ts` server running, the
  extension connects over `ws://localhost:7777/browser/ws` and the server answers
  MCP over Streamable HTTP (`http://127.0.0.1:7777/mcp`). Use this for the file
  store (`browser_file_read`, large downloads/uploads) or a plain local HTTP
  endpoint.

The toolbar icon shows the MCP mark — **gray** when disconnected, **green** when
connected.

## Features

- **Navigate** — open URLs, manage tabs and windows
- **Screenshot** — viewport, full page, or elements (returned as MCP image blocks)
- **Click / Type / Hover / Drag** — interact via CSS selectors, coordinates, or
  `@ref` markers from `browser_snapshot`
- **Extract** — text, links, forms, tables, or the accessibility tree
- **Execute JS** — run scripts in the page (with a stealth mode that avoids CDP
  detection on anti-bot sites)
- **Downloads** — capture files (returned inline as base64 when small)
- **Uploads** — set files on `<input type=file>` or intercepted file choosers
- **Auth** — HTTP Basic/Digest prompts, browser permissions, cookies, storage
- **Emulation** — mobile viewports, touch gestures, geolocation, offline mode

## Install

1. Load the extension:
   - **From the repo** — open `chrome://extensions`, enable **Developer mode**,
     click **Load unpacked**, and select this `packages/browser-extension`
     directory. Or
   - **From the server** — run `bun browser-mcp.ts`, open
     `http://127.0.0.1:7777/extension`, download and unzip the zip, then load it
     the same way.
2. Click the toolbar icon — the popup shows two fields:
   - **ID** — your gateway device ID (e.g. `my-browser`)
   - **Token** — the shared secret configured for that device on the gateway
3. Enter both and click **Connect**. The popup shows **Connected (gateway)** and
   the icon turns green. Any agent that can reach the gateway can now drive the
   browser — the extension answers MCP `initialize` / `tools/list` /
   `tools/call` in place.

> Without an ID, the extension falls back to the local server bridge
> (`ws://localhost:7777/browser/ws`).

## Security

- In direct mode the gateway forwards the device **Token** with each request and
  the extension verifies it before answering. Leave the Token empty only if you
  accept that anyone reaching the gateway can control the browser.
- `chrome.debugger` shows the yellow infobar as a consent signal while attached.
- All commands run inside your browser profile — nothing is stored remotely.
