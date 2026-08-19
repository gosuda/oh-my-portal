---
name: agent-frontend
description: Deploy a rich web chat interface for any CLI agent through a Portal tunnel — streaming text, tool cards, thinking display, and interrupt, served from a Bun bridge that adapts the agent's RPC protocol into a universal event stream. Use when the user asks for a proper web UI (not a terminal) to interact with their agent from a phone or browser, or wants a chat-like interface instead of a TUI. Do not use for terminal access (agent-terminal) or OMP's native collab (oh-my-omp).
license: MIT
---

# Rich Web Chat Interface for Any CLI Agent

The frontend is a single-page web app that provides a polished chat experience — streaming text, collapsible tool cards, thinking display, and an interrupt button — over any CLI agent. The bridge process (`agent-bridge.ts`) spawns the agent and translates its protocol into universal events the frontend renders.

Currently verified with OMP RPC (the most stable, documented protocol). The adapter layer is designed to add other agents.

## Architecture

```
Phone/browser ── HTTPS ──→ Portal tunnel ──→ caddy (auth) ──→ agent-bridge.ts
                                                                  │
                                                     Bun WebSocket + HTTP server
                                                                  │
                                                         spawn: omp --mode rpc
```

- **Frontend** (`frontend/index.html`): self-contained SPA, dark theme, mobile-first, zero external dependencies
- **Bridge** (`frontend/agent-bridge.ts`): Bun script — spawns the agent process, bridges stdio JSON-RPC to WebSocket events
- **Auth**: mandatory caddy `basic_auth` gate (same recipe as agent-web)

## Hard rules

- Never expose the bridge without the auth gate — it accepts prompts and controls the agent.
- The bridge binds loopback only (`127.0.0.1`); Portal provides the public edge.
- `--hide` on the tunnel — a chat interface gains nothing from being listed.
- Long random password on the gate; hand it over once.

## Workflow

### 1. Verify prerequisites

- `bun --version` (the bridge is a Bun script — OMP users already have Bun)
- An omp binary available (`omp --version`) for the default adapter
- The frontend files at `<repo>/frontend/` (both `agent-bridge.ts` and `index.html`)

### 2. Start the bridge

```sh
cd <repo>/frontend
bun agent-bridge.ts --port 7683
```

The bridge:
- Serves the web UI at `http://127.0.0.1:7683/`
- Exposes a WebSocket at the same port
- Spawns `omp --mode rpc` on the first client connection
- Negotiates RPC protocol v2 automatically

To use a different agent, pass `--agent "<command>"`:

```sh
bun agent-bridge.ts --agent "claude --mode rpc" --port 7683
```

### 3. Gate + publish

Reuse the agent-web caddy recipe:

```sh
caddy hash-password --plaintext '<long random password>'
```

```
:8080 {
    basic_auth {
        user <bcrypt hash>
    }
    reverse_proxy 127.0.0.1:7683
}
```

```sh
portal expose 127.0.0.1:8080 --name <hard-to-guess-name> --hide
```

### 4. Verify

- Public URL without credentials → `401`
- With credentials → the chat interface loads (dark theme, input box visible)
- Send a test prompt → streaming response appears with tool cards
- WebSocket upgrade succeeds (check browser DevTools network tab)

### 5. Hand off

Report: the public URL, credentials, what the agent is, and the stop sequence (Portal tunnel → caddy → bridge → agent process).

## Adapter status

| Adapter | Status | Command |
|---|---|---|
| OMP RPC | **Verified** | `omp --mode rpc` (default) |
| Generic stdio | Planned | any CLI agent via line-based JSON |
| Claude Code | Planned | `claude --mode rpc` or SDK |
| Terminal fallback | Planned | xterm.js overlay for agents without adapters |

Adding a new agent = implementing one function that translates its output into the universal event stream (`text_delta`, `thinking_delta`, `tool_start`, `tool_end`, `agent_start`, `agent_end`). The frontend is agent-agnostic.

## Failure rules

- Bridge not reachable locally: check Bun is installed and the port is free.
- WebSocket connects but no response from agent: check the agent process spawned (`bridge` logs to stderr).
- Public URL returns the page but WebSocket fails: the gate or relay may not forward WebSocket upgrades — verify locally first, then through the tunnel.
- Agent exits unexpectedly: the bridge reports `agent_exited` to the client and will respawn on the next prompt.
