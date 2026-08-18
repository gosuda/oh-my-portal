# omp-portal

Oh My Pi plugins for [Portal](https://github.com/gosuda/portal-tunnel), the self-hostable tunnel network.

## omp-collab

Shares a live OMP session with a phone or remote browser through OMP collab:

- **Hosted path** — the user runs `/collab` in the OMP TUI and opens the printed `my.omp.sh` link or QR on the phone. No infrastructure; payloads are end-to-end encrypted (AES-256-GCM) and the relay only sees ciphertext.
- **Self-hosted path** — the collab relay stand-in runs on the user's machine and is published through a Portal tunnel (`portal expose 127.0.0.1:7466`), with `collab.relayUrl` pointing at the tunnel and `collab.webUrl` at an HTTPS web-client origin. Session traffic terminates on the user's own machine.

The plugin teaches an agent the full workflow: OMP checks, relay startup, tunnel command construction with safe identity handling, WebSocket verification through the public URL, OMP settings, and hand-off. Only the host human mints collab links; the agent never fabricates or logs them.

## Install

### From this repository (OMP marketplace)

```sh
omp plugin marketplace add gosuda/omp-portal
omp plugin install omp-collab@omp-portal
```

Or inside the OMP TUI: `/marketplace add gosuda/omp-portal`, then `/marketplace install omp-collab@omp-portal`.

Local development:

```sh
omp plugin marketplace add ./omp-portal
omp plugin install omp-collab@omp-portal
```

Run `/reload-plugins` after installing to refresh skills.

### From npm

```sh
omp plugin install omp-portal
```

### Claude Code

The catalog is also published in the Claude Code plugin registry format (`.claude-plugin/marketplace.json`):

```sh
claude plugin marketplace add gosuda/omp-portal
claude plugin install omp-collab@omp-portal
```

## Layout

```text
omp-portal/
├── .omp-plugin/marketplace.json        # OMP marketplace catalog (preferred)
├── .claude-plugin/marketplace.json     # Claude Code-compatible catalog
├── .claude-plugin/plugin.json          # plugin manifest
├── skills/omp-collab/
│   ├── SKILL.md                        # agent workflow
│   └── references/omp-collab-details.md
├── package.json                        # npm distribution
└── README.md
```

## Publishing

- npm: `npm publish` (package `omp-portal`; the tarball carries the catalogs, plugin manifest, and skills).
- Marketplace consumers track this repository's `main` branch; bump `version` in both `package.json` and `.omp-plugin/marketplace.json` together.

## License

MIT
