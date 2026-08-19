# Oh My Portal

**Use your CLI agent from your phone.**

You run Claude Code, Codex, Gemini CLI, opencode, or OMP in a terminal. Oh My Portal gives you safe ways to reach it from anywhere — through [Portal](https://github.com/gosuda/portal-tunnel), a relay network that never sees your data: traffic is encrypted end-to-end and terminates on your machine, not on anyone else's server.

## What can I do with it?

| I want to… | Use | What you get |
|---|---|---|
| Chat with my agent from my phone | **agent-frontend** | A proper web chat — streaming answers with code formatting, model switching, session list, cost tracking |
| Full terminal access on the go | **agent-terminal** | The real terminal in your phone browser; the agent survives disconnects and reboots |
| Let a teammate watch or join | **agent-share** | One stable link per person; add and revoke access in seconds |
| Know when a long task finishes | **agent-notify** | Push notifications to your phone when the agent needs you |
| Share my MCP tools with another machine | **mcp-share** | Your local tools, reachable by other agents — behind your login |

On OMP there's also **omp-collab** (OMP's own session-sharing) and **agent-web** (an agent's built-in web UI, safely exposed).

## Quick start

The skills install into your agent and guide you from there — you describe what you want in plain language, the agent sets everything up.

```sh
# OMP
omp plugin marketplace add gosuda/oh-my-portal
omp plugin install oh-my-portal@oh-my-portal

# Claude Code
claude plugin marketplace add gosuda/oh-my-portal
claude plugin install oh-my-portal@oh-my-portal
```

Then just ask: *"set up a web chat for my agent so I can use it from my phone"*.

Every setup ends the same way: your agent runs on your machine, a relay forwards encrypted traffic, and nothing works without a password you control.

The chat adapts to whichever agent it's talking to: OMP gets model pickers, live subagent tracking, and session cost; other agents get streaming chat with full conversation memory. New agents plug in without changing the chat.

<details>
<summary><strong>Skill reference</strong> (what each one actually does)</summary>

**agent-terminal** — tmux keeps the agent alive across disconnects, ttyd serves the terminal over WebSocket, Portal publishes it as HTTPS. Loopback bind + credentials are hard rules; an open terminal is a shell.

**agent-frontend** — a Bun bridge adapts each agent's protocol into one event stream the chat renders. OMP via RPC (full features), Claude Code and Codex via SDK with conversation history, opencode via its API, anything else via a subprocess fallback. Ships with a contract test suite; the bridge won't start on a broken frontend.

**agent-share** — one persistent tunnel, one stable HTTPS domain, per-person tokens (caddy `basic_auth`). Revoking a token takes effect immediately without dropping other members.

**agent-notify** — agent hooks push to a self-hosted ntfy server behind a hidden tunnel. Verified on ntfy 2.27; notification content is labels-only.

**mcp-share** — a supergateway bridge exposes a local stdio MCP server as HTTP behind the auth gate; `initialize`/`tools/list`/`tools/call` round-trip through the public URL.

**agent-web** — publishes an agent's own web UI (opencode serve, or community UIs) behind a mandatory gate. Most local-first UIs answer unauthenticated — the skill refuses to deploy without `401` proof.

**omp-collab** (OMP only) — share a live OMP session. Either use the hosted `my.omp.sh` link (end-to-end encrypted) or self-host the relay stand-in through your own tunnel.

</details>

<details>
<summary><strong>All install options</strong></summary>

```sh
# OMP marketplace
omp plugin marketplace add gosuda/oh-my-portal
omp plugin install oh-my-portal@oh-my-portal   # universal skills
omp plugin install oh-my-omp@oh-my-portal       # OMP collab (optional)
# then /reload-plugins in the TUI

# npm
omp plugin install oh-my-portal

# Claude Code registry
claude plugin marketplace add gosuda/oh-my-portal
claude plugin install oh-my-portal@oh-my-portal

# local development
omp plugin marketplace add ./oh-my-portal
```

</details>

## For maintainers

- Skills live in `skills/`, the OMP-specific plugin in `omp/`, the web chat in `frontend/`.
- The web chat deploys through a contract suite (`bun run test/contract.ts`) and the bridge refuses to boot if the suite's static checks fail.
- npm package `oh-my-portal` carries the universal plugin; bump versions in `package.json` and the plugin manifests together.

## License

MIT
