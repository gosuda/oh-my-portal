---
name: agent-web
description: Publish an agent's native web UI (opencode serve, self-hosted community UIs for Claude Code / Codex / Gemini) through a Portal tunnel with a mandatory authentication gate in front, reachable from a phone or remote browser. Use when the agent has a web frontend to share and terminal access (agent-terminal) is not what the user asked for. Do not use for OMP collab (oh-my-omp) or plain web apps.
license: MIT
---

# Publish an Agent Web UI Behind an Auth Gate

Some agents ship a web frontend. The pattern is the same for all of them: the UI listens on loopback, an authenticating reverse proxy guards it, and Portal publishes the proxy as public HTTPS whose tenant TLS terminates on this machine.

## Verified facts (opencode 1.18.x, tested end to end)

- `opencode serve --port <n>` starts a headless server; `--hostname` **defaults to `127.0.0.1`** (loopback — keep it). Never pass `--mdns` (it binds `0.0.0.0`).
- `GET /` serves the full OpenCode web UI — no separate client needed.
- **The server has no built-in authentication**: API endpoints answer unauthenticated on loopback. Exposing it directly through a tunnel hands full agent control to anyone with the URL. The auth gate below is mandatory, not optional.
- Verified chain: opencode (127.0.0.1:4096) → caddy basicauth (127.0.0.1:8080) → `portal expose` → public URL returns `401` without credentials and the web UI with them.

## Hard rules

- Never expose a UI that answers unauthenticated (opencode serve, most local-first UIs). The gate is always in front, never omitted.
- The upstream UI binds loopback only. If it defaults wider, re-bind or refuse.
- Long random password; the URL plus the password together are the grant.
- The tunnel hostname is publicly listed unless the user asks for `--hide`. x402 route gating is available for pay-per-access; never enable payment implicitly.

## Workflow

### 1. Start the UI on loopback

- opencode: `opencode serve --port 4096` (defaults verified safe).
- Community UIs (claudecodeui and similar): run them per their docs but ensure they bind loopback; containerized ones should publish to `127.0.0.1:<port>` only. Verify their auth posture yourself before trusting it — if it already enforces a login, the extra gate is optional and you say so.

### 2. Put the auth gate in front

Caddy is a single binary and the verified recipe:

```sh
caddy hash-password --plaintext '<long random password>'   # → $2a$...
```

```
:8080 {
    basicauth {
        user <bcrypt hash>
    }
    reverse_proxy 127.0.0.1:4096
}
```

```sh
caddy run --config Caddyfile
```

If the host already runs a reverse proxy (nginx in front of shared sites, for example), add the gate there instead of a second proxy. WebSocket/SSE pass through both Caddy and Portal tunnels without special config — verify the final handshake rather than re-litigating.

### 3. Publish through Portal

```sh
portal expose 127.0.0.1:8080 --name <dns-label-safe-name>
```

Absolute `--identity-path` outside any repository.

### 4. Verify (all three, every time)

- Public URL without credentials → `401`.
- Public URL with credentials → `200` and the expected UI HTML.
- One authenticated API/WebSocket round trip through the public URL (e.g. the UI's session list) — proves the data path, not just the login page.

### 5. Hand off

Report: the public URL, the credentials (this once, in the same message), what the UI can drive (the agent and its tools — the same power as sitting at the machine), and the stop sequence: Portal tunnel first, then the gate, then the UI process.

## Failure rules

- UI reachable without credentials after exposure: stop the tunnel immediately and fix the gate.
- UI will not bind loopback: report and stop; do not widen the bind.
- Verification step 2 or 3 fails: treat as not deployed; distinguish local UI failure from tunnel failure by re-checking the local port.
- Credentials weak or reused: regenerate before exposing.
