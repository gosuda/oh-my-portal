# Oh My Portal

Portal access skills for every CLI agent — Claude Code, Codex CLI, Gemini CLI, opencode, OMP, or anything else that lives in a terminal. Reach your agent from a phone or remote browser through [Portal](https://github.com/gosuda/portal-tunnel), the trustless relay network: tenant TLS terminates on your machine, the relay only ever sees ciphertext.

Two plugins ship from this repository:

- **`oh-my-portal`** (main, universal) — pattern-based skills that work with every CLI agent.
- **`oh-my-omp`** (OMP-specific, under `omp/`) — native OMP collab integration.

## Skills

### agent-terminal (universal)

Reach any terminal-based CLI agent from a phone: **tmux** keeps the agent alive and resumable, **ttyd** serves the terminal over WebSocket, and **Portal** publishes it as public HTTPS. The only per-agent difference is the launch command, carried in a small matrix (`omp`, `claude`, `codex`, ...). Security rules are front-loaded: loopback bind only, credentials always, never an open terminal — a terminal is shell-equivalent.

### omp-collab (OMP-specific, `oh-my-omp` plugin)

Share a live OMP session through OMP collab:

- **Hosted path** — the user runs `/collab` in the OMP TUI and opens the printed `my.omp.sh` link or QR on the phone. No infrastructure; payloads are end-to-end encrypted (AES-256-GCM) and the relay only sees ciphertext.
- **Self-hosted path** — the collab relay stand-in runs on the user's machine and is published through a Portal tunnel (`portal expose 127.0.0.1:7466`), with `collab.relayUrl` pointing at the tunnel and `collab.webUrl` at an HTTPS web-client origin. Session traffic terminates on the user's own machine.

Only the host human mints collab links; the agent prepares infrastructure and never fabricates or logs them.

### agent-web (universal)

Publish an agent's native web UI — `opencode serve` (verified end to end: loopback default, full web UI at `/`, **no built-in auth**) or self-hosted community UIs for Claude Code / Codex / Gemini — behind a mandatory authentication gate (caddy basic_auth recipe included) and through a Portal tunnel. The skill encodes the verified failure mode: local-first UIs usually answer unauthenticated, so the gate is a hard rule, and verification requires `401` without credentials before hand-off.

### agent-share (universal)

One persistent Portal tunnel = one stable HTTPS domain, guarded by per-person tokens (caddy `basic_auth`, one bcrypt hash per person). Inviting is minting a token; removal is deleting a line plus a graceful reload — verified to revoke instantly while other members stay connected without a drop.

### agent-notify (universal)

Agent hooks (Claude Code notification hooks, OMP hooks) push to a self-hosted ntfy server exposed through a hidden Portal tunnel. Verified end to end on ntfy 2.27: `403` anonymous, token publish and SSE subscribe locally and through the public URL. Notification content is labels-only.

### mcp-share (universal)

Expose a local stdio MCP server to other machines' agents: a supergateway bridge (streamable HTTP, stateless `/mcp`) behind the auth gate, published through a hidden tunnel. Verified with `initialize` → `tools/list` → `tools/call` all round-tripping through the public URL. The bridge has no built-in auth, so the gate is mandatory; the skill makes the tool-execution grant explicit.

### Planned: agent-bridge (universal frontend via OMP collab)

The endgame for mobile UX: import any CLI agent's session into a local OMP instance (`omp --from-claude`, `--from-codex`), share it via OMP collab, and every agent gets a collab-quality mobile UI — streaming transcript, tool cards, subagent panel, prompt composer — instead of a raw terminal in the browser. Works today because all pieces exist; the skill composes them.

## Install

### From this repository (OMP marketplace)

```sh
omp plugin marketplace add gosuda/oh-my-portal
omp plugin install oh-my-portal@oh-my-portal   # universal skills
omp plugin install oh-my-omp@oh-my-portal       # OMP collab (optional)
```

Or inside the OMP TUI: `/marketplace add gosuda/oh-my-portal`, then `/marketplace install ...`.

Local development:

```sh
omp plugin marketplace add ./oh-my-portal
omp plugin install oh-my-portal@oh-my-portal
```

Run `/reload-plugins` after installing to refresh skills.

### From npm

```sh
omp plugin install oh-my-portal
```

(The npm package carries the universal plugin; the OMP-specific plugin installs from the marketplace above.)

### Claude Code

The catalog is also published in the Claude Code plugin registry format (`.claude-plugin/marketplace.json`):

```sh
claude plugin marketplace add gosuda/oh-my-portal
claude plugin install oh-my-portal@oh-my-portal
```

## Layout

```text
oh-my-portal/
├── .omp-plugin/marketplace.json        # OMP marketplace catalog: both plugins
├── .claude-plugin/marketplace.json     # Claude Code-compatible catalog
├── .claude-plugin/plugin.json          # oh-my-portal (main) manifest
├── skills/
│   └── agent-terminal/                 # universal: any CLI agent via tmux+ttyd+Portal
├── omp/                                # oh-my-omp (OMP-specific plugin)
│   ├── .claude-plugin/plugin.json
│   └── skills/omp-collab/
│       ├── SKILL.md
│       └── references/omp-collab-details.md
├── package.json                        # npm distribution (universal plugin)
└── README.md
```

## Publishing

- npm: `npm publish` (package `oh-my-portal`; the tarball carries the catalogs, both plugin manifests, and all skills).
- Marketplace consumers track this repository's `main` branch; bump `version` in `package.json`, both plugin manifests, and the catalog entries together.

## License

MIT
