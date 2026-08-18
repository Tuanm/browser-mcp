# Browser MCP Extension

Chrome/Edge extension (Manifest V3) that exposes your browser as MCP tools via a
local `browser-mcp` server. The toolbar icon shows the MCP mark — **gray** when
disconnected, **green** when connected to the server.

## Features

- **Navigate** — open URLs, manage tabs
- **Screenshot** — viewport, full page, or elements (returned as MCP image blocks)
- **Click/Type/Hover/Drag** — interact via CSS selectors or coordinates
- **Extract** — text, links, forms, tables, or accessibility tree
- **Execute JS** — run scripts in the page (with a stealth mode that avoids CDP
  detection on anti-bot sites)
- **Tab Management** — list, activate, close
- **Downloads** — capture files (auto-uploaded to the MCP server)
- **Uploads** — set files on `<input type=file>` or intercepted file choosers
- **Auth** — HTTP Basic/Digest prompts, browser permissions, cookies, storage

## Install

1. Run the server: `bun browser-mcp.ts` (repo root).
2. Download the zip from `http://127.0.0.1:7777/extension`, or load the unpacked
   `packages/browser-extension/` directory directly.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**.
4. Click the icon → verify **Connected to Browser MCP**. The icon turns green.

## Configure

- **Server Host** — where the MCP server listens (default `localhost:7777`).
- **Auth Token** — the `--extension-token` value, if the server requires one.

## Security

- Connects only to the host you configure (default localhost).
- `chrome.debugger` shows the yellow infobar as a consent signal.
- All commands come from the local MCP server over the WebSocket bridge.
