# Oh My Portal

Portal access skills for [Oh My Pi](https://github.com/can1357/oh-my-pi) and every CLI agent — share a live session, expose a native web UI, or reach any agent's terminal from a phone. Built on [Portal](https://github.com/gosuda/portal-tunnel), the trustless relay network: tenant TLS terminates on your machine, the relay sees only ciphertext.

## Skills

### omp-collab

Shares a live OMP session with a phone or remote browser through OMP collab:

- **Hosted path** — the user runs `/collab` in the OMP TUI and opens the printed `my.omp.sh` link or QR on the phone. No infrastructure; payloads are end-to-end encrypted (AES-256-GCM) and the relay only sees ciphertext.
- **Self-hosted path** — the collab relay stand-in runs on the user's machine and is published through a Portal tunnel (`portal expose 127.0.0.1:7466`), with `collab.relayUrl` pointing at the tunnel and `collab.webUrl` at an HTTPS web-client origin. Session traffic terminates on the user's own machine.

The `omp-collab` skill teaches an agent the full workflow: OMP checks, relay startup, tunnel command construction with safe identity handling, WebSocket verification through the public URL, OMP settings, and hand-off. Only the host human mints collab links; the agent never fabricates or logs them.

Planned sibling skills generalize the pattern to other CLI agents: native web UIs (`opencode serve`, community Claude Code / Codex UIs) and a universal `tmux` + terminal-over-WebSocket fallback published through Portal.

## Install

### From this repository (OMP marketplace)

```sh
omp plugin marketplace add gosuda/oh-my-portal
omp plugin install oh-my-portal@oh-my-portal
```

Or inside the OMP TUI: `/marketplace add gosuda/oh-my-portal`, then `/marketplace install oh-my-portal@oh-my-portal`.

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

### Claude Code

The catalog is also published in the Claude Code plugin registry format (`.claude-plugin/marketplace.json`):

```sh
claude plugin marketplace add gosuda/oh-my-portal
claude plugin install oh-my-portal@oh-my-portal
```

## Layout

```text
oh-my-portal/
├── .omp-plugin/marketplace.json        # OMP marketplace catalog (preferred)
├── .claude-plugin/marketplace.json     # Claude Code-compatible catalog
├── .claude-plugin/plugin.json          # plugin manifest
├── skills/omp-collab/                   # skill name stays omp-collab
│   ├── SKILL.md                        # agent workflow
│   └── references/omp-collab-details.md
├── package.json                        # npm distribution
└── README.md
```

## Publishing

- npm: `npm publish` (package `oh-my-portal`; the tarball carries the catalogs, plugin manifest, and skills).
- Marketplace consumers track this repository's `main` branch; bump `version` in both `package.json` and `.omp-plugin/marketplace.json` together.

## License

MIT
