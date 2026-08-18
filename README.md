# Browser MCP

Expose your Chrome/Edge browser as **MCP tools** for any AI agent — locally via
Streamable HTTP, or remotely through a [code-mcp-gateway](https://github.com/Tuanm/code-mcp-gateway)
so agents anywhere can drive the connected browser.

A tiny Chrome extension (Manifest V3) bridges the browser to a local MCP server;
the server speaks the same MCP JSON-RPC protocol as [code-mcp](https://github.com/Tuanm/code-mcp)
and the same gateway WebSocket protocol, so it drops into existing agent setups.

## Architecture

```
┌────────────────────────────────────────────┐
│ Chrome/Edge Extension (Manifest V3)        │
│  ├─ Service Worker (command dispatch)      │
│  ├─ Offscreen Doc (WebSocket bridge)       │
│  ├─ Content Script (DOM utilities)         │
│  ├─ Shield (anti-bot CDP detection)        │
│  └─ Popup (status + MCP-mark icon)         │
└──────────────┬─────────────────────────────┘
               │ WebSocket ws://localhost:7777/browser/ws
┌──────────────┴─────────────────────────────┐
│ browser-mcp.ts (Bun, single file)          │
│  ├─ POST /mcp         MCP JSON-RPC tools   │
│  ├─ /browser/ws       extension bridge     │
│  ├─ /files/*          file transfer        │
│  ├─ GET /extension    extension zip        │
│  └─ gateway client    wss://gateway/ws     │
└──────────────┬─────────────────────────────┘
               │ code-mcp-gateway protocol
┌──────────────┴─────────────────────────────┐
│ code-mcp-gateway (Cloudflare Worker)       │
└────────────────────────────────────────────┘
```

## Quick start

Requires [Bun](https://bun.sh) (>= 1.1) and Chrome or Edge (>= 111).

### 1. Run the server

```bash
bun browser-mcp.ts                  # listens on http://127.0.0.1:7777/mcp
bun browser-mcp.ts --token <s>      # require auth on /mcp + /files
```

### 2. Install the extension

Two options — both produce the same zip:

- **From the server**: open `http://127.0.0.1:7777/extension` and download
  `browser-mcp-extension.zip`, then unzip it.
- **From the repo**: the extension source lives in `packages/browser-extension/`.

Then in Chrome/Edge:

1. Go to `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `packages/browser-extension` directory.
3. The toolbar icon shows the MCP mark — **gray** (disconnected) or **green** (connected).
4. Click the icon → verify it says **Connected to Browser MCP**.

The extension auto-connects to `ws://localhost:7777/browser/ws`. If you moved the
server (different port/host, or you set `--extension-token`), click the icon and
update the **Server Host** / **Auth Token** fields.

### 3. Point an agent at it

Local MCP clients connect to `http://127.0.0.1:7777/mcp`. Example Claude Desktop
config (`claude_desktop_config.json` / `mcpServers`):

```json
{
  "mcpServers": {
    "browser": {
      "type": "http",
      "url": "http://127.0.0.1:7777/mcp"
    }
  }
}
```

Verify it works: `curl -s http://127.0.0.1:7777/health` → `extensionConnected: true`.

## Remote access via code-mcp-gateway

```bash
bun browser-mcp.ts --gateway <domain> --token <s> --id <device-id>
```

- Connects to `wss://<domain>/ws/<device-id>` (mirrors code-mcp: register,
  keepalive every 25s, 75s watchdog, jittered backoff reconnect).
- Inbound MCP requests from the gateway are forwarded to the local `/mcp`.
- **Use the same `--token` on the gateway device.** Never run gateway mode
  without a token — the server prints a warning if you do.

Remote agents can read downloaded files and screenshots that were too large to
return inline via `browser_file_read`, or upload files inline to
`browser_upload_file` with base64 `content`. Huge files stay on the local machine
and are fetched via `GET /files/<file_id>`.

## Tools (47)

Core + agent-browser parity (element discovery with the **@ref system**):

- **Element discovery** — `browser_snapshot` (interactive element tree with `[ref=eN]`
  markers), `browser_find` (semantic search by role/name/text/label/placeholder/
  title/testid/selector), `browser_get` (text/html/value/attribute/count/box/styles),
  `browser_is` (visible/enabled/checked/editable/focused).
- **Interaction** — `browser_click`, `browser_dblclick`, `browser_type`, `browser_fill`
  (clear+type), `browser_check` / `browser_uncheck`, `browser_select`, `browser_hover`,
  `browser_focus`, `browser_press`, `browser_drag`, `browser_scroll`, `browser_upload`.
  Every interaction tool accepts a `ref` (from `browser_snapshot`) **or** a CSS
  `selector` — refs are cached server-side and resolve to selectors automatically.
- **Navigation** — `browser_navigate`, `browser_reload`, `browser_back`,
  `browser_forward`, `browser_close`, `browser_tabs`, `browser_window`.
- **Page reads** — `browser_extract`, `browser_execute`, `browser_screenshot`
  (MCP image block), `browser_pdf` (→ `file_id`), `browser_wait`
  (timeout/load/url/text/selector), `browser_highlight`.
- **State & debugging** — `browser_store`, `browser_cookies`, `browser_storage`
  (local/sessionStorage), `browser_console`, `browser_errors`, `browser_network`
  (CDP ring buffers), `browser_status`, `browser_file_read`.
- **Emulation & control** — `browser_emulate`, `browser_set` (viewport/device/geo/
  offline/headers/media), `browser_perms`, `browser_auth`, `browser_dialog`,
  `browser_frames`, `browser_touch`, `browser_download`.

Console/errors/network capture is lazy: it starts on the first call, so reload or
navigate after enabling to capture traffic. Back/forward use CDP navigation
history (more reliable than `chrome.tabs.goBack`).

Run `curl -s -X POST http://127.0.0.1:7777/mcp -H 'Content-Type: application/json'
-d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` for full schemas.

## Flags

| Flag | Description | Default |
| --- | --- | --- |
| `--port <n>` | Listen port | `7777` or `$PORT` |
| `--bind <addr>` | Bind address | `127.0.0.1` |
| `--token <s>` | Require auth on `/mcp` and `/files/*` (`?token=` or Bearer) | none |
| `--extension-token <s>` | Require this token from the extension on `/browser/ws` + `/browser/files/*` | none |
| `--gateway <domain>` | Tunnel the MCP endpoint through a code-mcp-gateway | none |
| `--id <uuid>` | Gateway device id (stable reconnect identity) | random |
| `--files-dir <path>` | Where downloaded/uploaded files are stored | `./files` |
| `--allow-any-origin` | DEV ONLY: skip the extension Origin check. Never use on a shared machine | off |

## Security

- **Origin-gated endpoints.** `/browser/ws` accepts only `chrome-extension://`
  origins, and `/mcp` + `/files/*` reject browser origins other than localhost /
  the extension — so a malicious website cannot drive your browser through
  localhost (CSRF). Native MCP clients (no Origin header) are unaffected.
- **`--token`** enforces constant-time auth on `/mcp` and `/files/*`
  (`?token=` or `Authorization: Bearer`).
- **`--extension-token`** (optional) adds a shared secret the extension must
  present on the bridge and file endpoints. Enter it in the popup.
- **Path traversal** is impossible: file IDs are 12-char random hex and
  validated against a strict pattern; upload filenames are sanitized.
- **Size caps**: uploads 500 MiB, screenshots 8 MiB inline, MCP bodies bounded.
- **`chrome.debugger`** shows Chrome's yellow infobar while the debugger is
  attached (consent signal), and `browser_permissions`/`browser_cookies` use the
  non-debugger APIs where possible (less detection surface).
- The server binds to `127.0.0.1` by default. Binding to `0.0.0.0` without
  `--token` prints a warning — anyone on the network could control the browser.

## Timeouts

Bridge commands: 30s default, 60s for navigate/execute/wait_for, 120s for
download/file_upload, capped at 120s locally and 55s in gateway mode (the
gateway aborts forwards after 60s). Tools accept `bridge_timeout` (seconds) to
override. The extension's relay timeout (125s) is above the local cap so the
server always fails first with a clean error.

## Development

```bash
bun scripts/build-extension.ts   # rebuild dist/browser-extension.zip
bun scripts/test-integration.ts  # mock-extension + mock-gateway E2E suite
bun browser-mcp.ts               # run the server
```

The extension is a rebranded/adapted fork of the browser extension built for
[clawd](https://github.com/Tuanm/clawd) (command surface, stealth shield, and
off-screen WebSocket bridge preserved; branding, icon, port, and defaults
updated for standalone MCP use).
