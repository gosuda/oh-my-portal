---
name: agent-frontend
description: Deploy a rich web chat interface for any CLI agent through a Portal tunnel — streaming markdown, syntax-highlighted code, rich tool cards, model/thinking pickers, session cost tracking, an Agent Hub with subagent transcripts, and capability-negotiated adapters, served from a Bun bridge. Use when the user asks for a proper web UI (not a terminal) to interact with their agent from a phone or browser, or wants a chat-like interface instead of a TUI. Do not use for terminal access (agent-terminal) or OMP's native collab (oh-my-omp).
license: MIT
---

# Rich Web Chat Interface for Any CLI Agent

A polished mobile-first web chat over any CLI agent. Adapters translate each agent's protocol into a universal event stream; the frontend negotiates capabilities with the active adapter and shows only what that agent supports. OMP gets the full feature set; other agents get streaming chat with conversation history.

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
- `frontend/index.html` — shell (gate, sidebar, chat, Agent Hub, footer)
- `frontend/style.css` — dark theme, mobile-first, syntax highlighting colors
- `frontend/markdown.js` — self-contained markdown renderer + 8-language highlighter
- `frontend/app.js` — frontend logic (event contract documented in the header)
- `frontend/agent-bridge.ts` — Bun server: files + WebSocket + session management + capability negotiation
- `frontend/adapters/types.ts` — AgentAdapter interface, AgentEvent contract, AdapterCapabilities
- `frontend/adapters/omp-rpc.ts` — OMP RPC adapter (reference implementation)
- `frontend/adapters/claude-code.ts` — Anthropic SDK adapter (multi-turn history)
- `frontend/adapters/codex.ts` — OpenAI SDK adapter (multi-turn history)
- `frontend/adapters/opencode.ts` — opencode serve API adapter
- `frontend/adapters/simple.ts` — universal subprocess fallback (line streaming)

## Capability negotiation

Each adapter declares what it can do; the bridge sends
`{type: "capabilities", adapter, caps, commands}` on connect and session
switch; the frontend shows only those features.

| Adapter | models | thinking | hub+transcripts | cost | commands | history |
|---|---|---|---|---|---|---|
| omp-rpc | ✓ | ✓ | ✓ | ✓ | 14 | ✓ (process) |
| claude-code | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (rolling 40) |
| codex | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (rolling 40) |
| opencode | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (server session) |
| simple | ✗ | ✗ | ✗ | ✗ | ✗ | CLI-dependent |

New adapter = implement the interface + declare caps. No frontend changes.

## Feature set (per capability)

- Streaming markdown with syntax highlighting (JS/TS/Python/Go/Rust/Bash/JSON/YAML)
- Tool cards: parameters (JSON) + results, expandable
- Thinking display, Agent Hub (⌥) with live subagent cards — status, tokens, cost, duration — and per-agent transcripts (▤)
- `/model` picker (typing `/model` opens it instantly; cost/context/current mark; cached list)
- `/thinking` picker (levels from model state)
- Footer: model, context usage, cumulative session cost
- 2-level cascade autocomplete (parent → subcommands; hides during arguments)
- Sessions: sidebar, independent agent per session, auto-title, refresh reattaches to the latest session
- Agent error cards — token-less/crash guidance from the agent's own stderr
- Stop button, prompt watchdog for silently-swallowed commands

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

Sessions: each connection reattaches to the most recent session (page
refresh keeps the conversation); ＋ New Chat in the sidebar creates a
fresh one with an independent agent process. Titles auto-populate from
the first prompt. Slash commands apply to the active session only.

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
- With credentials → the chat UI loads; the header names the active adapter
- Type `/` → autocomplete (top-level commands; `/goal ` → subcommands)
- Send a prompt → streaming markdown with highlighted code and tool cards
- Type `/model` → picker opens without Send; pick updates the footer + echoes
- Type `/thinking` → level picker with the current level marked
- Footer shows model, context, and session cost (grows each turn)
- Spawn a subagent → ⌥ button; open the hub → cards; ▤ transcript renders the subagent's messages
- Refresh the page → the latest session restores with history
- Agent with no API token → red error card with the agent's own guidance

### 5. Hand off

Report: the public URL, credentials, which agent adapter is active, and the stop sequence.

## Failure rules

- Bridge not reachable locally: check Bun is installed and the port is free.
- WebSocket connects but no response: check the agent process spawned; a red error card means the agent died (missing API key) — read its guidance.
- Public URL loads but WebSocket fails: verify the gate or relay forwards WebSocket upgrades.
- `/` autocomplete doesn't show: commands come from the active adapter — non-OMP adapters intentionally have none.
- Pickers don't open on `/model`: the active adapter didn't declare `models` capability.
