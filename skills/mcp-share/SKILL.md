---
name: mcp-share
description: Expose a local MCP server (stdio transport) to other machines' AI agents over HTTPS - a stdio-to-streamable-HTTP bridge behind an auth gate, published through a Portal tunnel. Use when the user asks to share their MCP tools with another machine, let another agent (Claude Code, OMP, Cursor, ...) use local MCP servers remotely, or publish an MCP server for a team. Do not use for human-facing remote access (agent-terminal / agent-web) or notification pushes (agent-notify).
license: MIT
---

# Share Local MCP Tools With Other Agents

This is the first agent-to-agent pattern in this plugin: another machine's agent connects to **your** MCP server over HTTPS and calls your tools. The bridge converts a stdio MCP server to streamable HTTP; a mandatory auth gate stands in front (the bridge ships with none); Portal publishes the gate.

Verified end to end (supergateway bridging `@modelcontextprotocol/server-everything`): `initialize` → `tools/list` → `tools/call echo` all round-tripped through a hidden Portal tunnel's public URL.

## What is being granted — say it first

MCP tools are **executable capability on this machine** (filesystem access, shell, whatever the server does). Sharing an MCP server is not sharing a page; it is delegating tool execution to whoever holds the credentials. The hard rules below exist because the bridge has no authentication of its own (`Headers: (none)` in its own startup banner).

## Hard rules

- **Never expose the bridge without the auth gate.** Use the caddy `basic_auth` recipe from agent-web in front of the bridge; the bridge has zero built-in auth.
- The remote agent's client config carries the credentials (Claude Code and most MCP clients accept custom headers for HTTP servers — `Authorization: Basic <base64>` for the caddy gate). Never put the token in a URL.
- `--hide` always: an MCP endpoint gains nothing from being listed, and tool endpoints are high-value scan targets.
- List for the user exactly which tools the server exposes before the first hand-off; the grant is per-server, all-tools.
- Tools that read secrets or run shells: call them out explicitly and let the user decline the whole share rather than discover the scope later.

## Workflow

### 1. Bridge the stdio server

```sh
npx -y supergateway \
  --stdio "<command that runs your MCP server>" \
  --port <port> --outputTransport streamableHttp
```

Verified specifics (supergateway, current):
- The transport value is `streamableHttp` — `streamable` is rejected.
- The stateless server answers at `/mcp`; each POST is self-contained (no session), which is what makes it easy to sit behind a plain reverse proxy.
- Default `protocolVersion: 2024-11-05`; CORS disabled by default (fine — the gate and Portal are in front).
- **Windows quirk**: binding may fail with `EACCES` on ports inside Hyper-V/WSL reserved ranges — check `netsh interface ipv4 show excludedportrange protocol=tcp` and pick outside them.

### 2. Gate + publish

Reuse the agent-web chain: caddy `basic_auth` (long random password) → `reverse_proxy 127.0.0.1:<bridge-port>`, then:

```sh
portal expose 127.0.0.1:<gate-port> --name <hard-to-guess-name> --hide
```

### 3. Verify all three (local, then through the public URL)

```sh
curl -s -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -u <gate-credentials> \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}' \
  https://<host>/mcp
```

- No credentials → `401`; with credentials → an `initialize` result (SSE `event: message` framing).
- `tools/list` returns the server's tools **through the public URL**.
- One real `tools/call` through the public URL succeeds.

### 4. Configure the remote agent

In the remote machine's MCP client config (Claude Code `.mcp.json`, OMP `mcp-config`, equivalents): URL `https://<host>/mcp`, header `Authorization: Basic <base64 user:password>`, transport streamable HTTP. The token travels in the client config on that machine — treat that machine as holding the grant.

### 5. Hand off

Report: the public URL, which server and **the full tool list** now callable, the credential location (the remote client config), and revocation — delete the gate's credential line and reload (agent-share rules), or stop the tunnel; the remote agent errors immediately.

## Failure rules

- Bridge reachable without credentials: stop the tunnel, fix the gate, re-verify `401`.
- `initialize` works but `tools/call` fails through the public URL while working locally: suspect gate header handling first (some proxies strip `Authorization`), then SSE framing.
- Port bind fails with `EACCES` on Windows: reserved range — move the port.
- User asks to share a server whose tools include shells or secret readers and the recipient is not fully trusted: recommend against, and offer a read-only or redacted subset server instead of the full one.
