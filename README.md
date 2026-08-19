# Oh My Portal

Portal access skills for every CLI agent — OMP, Claude Code, Codex CLI, Gemini CLI, opencode, or anything else that lives in a terminal. Reach your agent from a phone or remote browser through [Portal](https://github.com/gosuda/portal-tunnel), the trustless relay network: tenant TLS terminates on your machine, the relay only ever sees ciphertext.

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

Publish an agent's native web UI — `opencode serve` (verified end to end: loopback default, full web UI at `/`, **no built-in auth**) or self-hosted community UIs for Claude Code / Codex / Gemini — behind a mandatory authentication gate (caddy basicauth recipe included) and through a Portal tunnel. The skill encodes the verified failure mode: local-first UIs usually answer unauthenticated, so the gate is a hard rule, and verification requires `401` without credentials before hand-off.

### Planned

- `agent-notify` — agent hooks (Claude Code notification hooks, OMP hooks) pushing to a self-hosted ntfy exposed through Portal.
- `mcp-share` — expose local MCP servers (stdio→HTTP bridge) through Portal so other machines' agents can use your tools.

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
