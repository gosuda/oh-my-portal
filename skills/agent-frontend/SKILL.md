---
name: agent-frontend
description: Deploy a rich web chat interface for any CLI agent through a Portal tunnel — streaming text, tool cards, thinking display, slash commands with autocomplete, and per-person nicknames, served from a Bun bridge with pluggable adapters. Use when the user asks for a proper web UI (not a terminal) to interact with their agent from a phone or browser, or wants a chat-like interface instead of a TUI. Do not use for terminal access (agent-terminal) or OMP's native collab (oh-my-omp).
license: MIT
---

# Rich Web Chat Interface for Any CLI Agent

A polished web chat — streaming text, collapsible tool cards, thinking display, slash commands with autocomplete — over any CLI agent. The bridge process adapts each agent's protocol into a universal event stream the frontend renders. Currently supports OMP (full features), Claude Code, Codex, and opencode via SDK/API adapters, plus a universal subprocess fallback for everything else.

## Architecture

```
Phone/browser ── HTTPS ──→ Portal tunnel ──→ caddy (auth) ──→ agent-bridge.ts
                                                                  │
                                              ┌── Adapter Layer ──┤
                                              │  omp-rpc  (full)  │
                                              │  claude-code (SDK)│
                                              │  codex (SDK)      │
                                              │  opencode (API)   │
                                              │  simple (subproc) │
                                              └───────────────────┘
```

Files:
- `frontend/index.html` — minimal shell, links to CSS and JS
- `frontend/style.css` — dark theme, mobile-first
- `frontend/app.js` — frontend logic, universal event rendering, slash command autocomplete
- `frontend/agent-bridge.ts` — Bun server, serves files + WebSocket, adapter selection
- `frontend/adapters/types.ts` — AgentAdapter interface (the contract)
- `frontend/adapters/omp-rpc.ts` — OMP RPC adapter (streaming, tools, state, slash commands)
- `frontend/adapters/claude-code.ts` — Anthropic SDK adapter
- `frontend/adapters/codex.ts` — OpenAI SDK adapter
- `frontend/adapters/opencode.ts` — opencode serve API adapter
- `frontend/adapters/simple.ts` — universal subprocess fallback

## Adapter capability matrix

| Adapter | Streaming | Tools | Thinking | State/Model | Slash cmds |
|---|---|---|---|---|---|
| OMP RPC | ✓ | ✓ | ✓ | ✓ | ✓ |
| Claude Code | ✓ | ✓ | ✓ | basic | ✗ |
| Codex | ✓ | ✓ | ✗ | basic | ✗ |
| opencode | ✓ | ✗ | ✗ | basic | ✗ |
| Simple | ✗ | ✗ | ✗ | ✗ | ✗ |

## Hard rules

- Never expose the bridge without the auth gate — it accepts prompts and controls the agent.
- The bridge binds loopback only; Portal provides the public edge.
- `--hide` on the tunnel.
- Long random password on the gate.

## Workflow

### 1. Verify prerequisites

- `bun --version` (the bridge is a Bun script)
- An agent available: `omp --version` for the default, or the relevant SDK/API key for other adapters

### 2. Start the bridge

```sh
cd <repo>/frontend
bun agent-bridge.ts --port 7683
```

Select a specific agent:

```sh
bun agent-bridge.ts --agent claude --port 7683    # Claude Code (ANTHROPIC_API_KEY)
bun agent-bridge.ts --agent codex --port 7683     # OpenAI (OPENAI_API_KEY)
bun agent-bridge.ts --agent opencode --port 7683  # opencode serve
bun agent-bridge.ts --agent gemini --port 7683    # subprocess fallback
```

Each client connection gets its own auto-created session with an independent agent process. Sessions are listed in a sidebar (☰ toggle); users can create new ones, switch between them (loading history), and delete them. Session titles auto-populate from the first prompt (first 40 chars). Slash commands (`/model`, `/compact`, etc.) apply to the active session only. Multiple clients on the same session share context; each client's own session is private.

### 3. Gate + publish

Reuse the agent-web caddy recipe:

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

- No credentials → `401`
- With credentials → the chat UI loads (dark theme, input box, connection dot green)
- Type `/` in the input → command autocomplete appears
- Send a prompt → streaming markdown with syntax-highlighted code blocks and rich tool cards
- Bare `/model` → clickable model picker (25+ models with cost/context); pick updates the footer
- Bare `/thinking` → level picker; footer shows model, context usage, and session cost
- Spawn a subagent → ⌥ button appears; opens the Agent Hub with live progress
- Agent with no API token → red error card with the agent's own guidance

### 5. Hand off

Report: the public URL, credentials, which agent adapter is active, and the stop sequence.

## Failure rules

- Bridge not reachable locally: check Bun is installed and the port is free.
- WebSocket connects but no response: check the agent process spawned.
- Public URL loads but WebSocket fails: verify the gate or relay forwards WebSocket upgrades.
- `/` autocomplete doesn't show: the input must start with `/` and contain no spaces.
