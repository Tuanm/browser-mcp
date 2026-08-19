# Browser MCP

Expose your Chrome/Edge browser as **MCP tools** for any AI agent. A tiny
Chrome extension (Manifest V3) turns the browser itself into an MCP server that
connects straight to a [code-mcp-gateway](https://github.com/Tuanm/code-mcp-gateway)
— so agents anywhere can drive the connected browser, **with no local server
running**.

It speaks the same MCP JSON-RPC protocol as [code-mcp](https://github.com/Tuanm/code-mcp)
and the same gateway WebSocket protocol, so it drops into existing agent setups.

## How it works

```
┌────────────────────────────────────────────┐
│ Chrome/Edge Extension (Manifest V3)        │
│  ├─ Service Worker (command dispatch +     │
│  │    in-extension MCP server)             │
│  ├─ Offscreen Doc (WebSocket bridge)       │
│  ├─ Content Script (DOM utilities)         │
│  ├─ Shield (anti-bot CDP detection)        │
│  └─ Popup (ID/Token + status, MCP-mark)    │
└──────────────┬─────────────────────────────┘
               │ DIRECT: wss://code-mcp.tuanm.dev/ws/<id>
               │ (extension is the MCP server - no local server)
               │ code-mcp-gateway protocol (register/keepalive)
┌──────────────┴─────────────────────────────┐
│ code-mcp-gateway (Cloudflare Worker)       │
└────────────────────────────────────────────┘
```

An optional local server (`browser-mcp.ts`) adds a file store
(`browser_file_read`, large downloads/uploads) and a plain local MCP HTTP
endpoint — see [Optional: local server](#optional-local-server).

## Quick start

Requires Chrome or Edge (>= 111). [Bun](https://bun.sh) (>= 1.1) is only needed
for the optional local server or the dev tooling — **the extension works
standalone**.

### 1. Install the extension

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
and select the `packages/browser-extension` directory. (Or run
`bun browser-mcp.ts` and download the zip from `http://127.0.0.1:7777/extension`.)

### 2. Connect

1. Click the toolbar icon — the MCP mark is **gray** when disconnected, **green**
   when connected.
2. In the popup enter your gateway **Device ID** (e.g. `my-browser`) and the
   **Token** configured for that device on the gateway, then click **Connect**.
3. The extension connects straight to `wss://code-mcp.tuanm.dev/ws/<id>`
   (register, keepalive every 25s, 75s watchdog, jittered backoff reconnect) and
   answers MCP `initialize` / `tools/list` / `tools/call` in place. The popup
   shows **Connected (gateway)**.

Any agent that can reach the gateway can now drive the browser.

> The token must match what you configured for this device on the gateway side —
> the gateway forwards it with each request and the extension verifies it.
> No token entered → anyone reaching the gateway can control the browser.

### 3. Point an agent at it

For the local server only (see below), MCP clients connect to
`http://127.0.0.1:7777/mcp`. Example Claude Desktop config
(`claude_desktop_config.json` / `mcpServers`):

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

> If you run the server with `--token`, add `"headers": { "Authorization": "Bearer <token>" }` to
> the client config (see `mcp-client.example.json`).

## Optional: local server

Only needed for the local file store (`browser_file_read`, downloads/uploads
larger than 512 KB) or for a plain local MCP HTTP endpoint:

```bash
bun browser-mcp.ts                  # listens on http://127.0.0.1:7777/mcp
bun browser-mcp.ts --token <s>      # require auth on /mcp + /files
```

With the server running, the extension's popup Connect also hands the ID + Token
over for the server's own gateway link; without it, the extension still works
directly.

## Remote access via code-mcp-gateway

**Default (popup, direct mode):** enter **ID** + **Token** in the extension popup
and click Connect — the extension itself connects to
`wss://code-mcp.tuanm.dev/ws/<id>` and serves MCP directly. **No local server
is needed.**

**With the local server (server-side gateway link):** the server links to
`wss://code-mcp.tuanm.dev/ws/<id>` and uses the Token for `/mcp` auth.

**CLI (custom gateway):**

```bash
bun browser-mcp.ts --gateway <domain> --token <s> --id <device-id>
```

- Connects to `wss://<domain>/ws/<device-id>` (mirrors code-mcp: register,
  keepalive every 25s, 75s watchdog, jittered backoff reconnect).
- Inbound MCP requests from the gateway are forwarded to the local `/mcp`.
- **Use the same `--token` on the gateway device.** Never run gateway mode
  without a token — the server prints a warning if you do.
- Set `BMCP_GATEWAY_DOMAIN` to change the popup flow's default gateway host.

Remote agents can read downloaded files and screenshots that were too large to
return inline via `browser_file_read`, or upload files inline to
`browser_upload` with base64 `content`. Huge files stay on the local machine
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
  `selector` — refs are cached and resolve to selectors automatically.
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
| `--gateway <domain>` | Tunnel the MCP endpoint through a code-mcp-gateway (popup flow uses `code-mcp.tuanm.dev`, override with `BMCP_GATEWAY_DOMAIN`) | none |
| `--id <uuid>` | Gateway device id (overridden by the popup ID when the extension connects) | random |
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

## agent-browser parity

This project ports the practical surface of [agent-browser](https://github.com/vercel-labs/agent-browser)
(and the agent_browser_mcp 44-tool wrapper) onto our extension-based architecture,
including the signature **`@ref` system**: `browser_snapshot` returns an
interactive-element tree with `[ref=eN]` markers, and every interaction tool
accepts the ref instead of a hand-written selector (refs are cached and
resolved automatically; stale refs produce a "run browser_snapshot again" error).

Deliberately NOT ported (dev/niche features that don't fit a real user's
browser): `browser_record` (video), `browser_trace` (tracing), `browser_profiler`
(DevTools profiling), `browser_diff` (page diff), `browser_state` (Playwright
state dump — use `browser_store`/`browser_cookies`/`browser_storage` instead),
`browser_tab` (we have `browser_tabs`), and `browser_mouse` (we have
`browser_mouse_move` + coordinate interactions).

## Timeouts

Bridge commands: 30s default, 60s for navigate/execute/wait_for, 120s for
download/file_upload, capped at 120s locally and 55s in gateway mode (the
gateway aborts forwards after 60s). Tools accept `bridge_timeout` (seconds) to
override. The extension's relay timeout (125s) is above the local cap so the
server always fails first with a clean error.

## Development

```bash
bun run check   # syntax-check server + scripts + extension JS
bun run test    # mock-extension + mock-gateway E2E suite
bun run build   # rebuild dist/browser-extension.zip
bun browser-mcp.ts  # run the server
```

The extension is a rebranded/adapted fork of the browser extension built for
[clawd](https://github.com/Tuanm/clawd) (command surface, stealth shield, and
off-screen WebSocket bridge preserved; branding, icon, port, and defaults
updated for standalone MCP use).
