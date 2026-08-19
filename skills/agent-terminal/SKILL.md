---
name: agent-terminal
description: Reach any terminal-based AI agent session (OMP, Claude Code, Codex CLI, Gemini CLI, opencode, ...) from a phone or remote browser by running the agent inside tmux and publishing a terminal over the web through a Portal tunnel. Use when the user asks to access, watch, or drive their CLI agent remotely from another device. Do not use for OMP collab specifically (the oh-my-omp plugin covers it) or for exposing an ordinary web app.
license: MIT
---

# Reach Any CLI Agent from a Phone

The pattern is three standard pieces: **tmux** keeps the agent alive and resumable, **ttyd** serves the terminal over WebSocket, and **Portal** publishes it as public HTTPS whose tenant TLS terminates on this machine — the relay only ever sees ciphertext.

This works for any process that talks to a terminal, which is every CLI agent. The only per-agent difference is the launch command:

| Agent | Start | Resume |
|---|---|---|
| OMP | `omp` | `omp -c` or `omp --resume` |
| Claude Code | `claude` | `claude -c` or `claude --resume` |
| Codex CLI | `codex` | `codex resume` |
| any other | the agent's own entrypoint | its documented resume flag |

For OMP, check first whether the user wants native collab instead (`oh-my-omp` plugin) — it is E2EE and purpose-built; this skill is the fallback for everything else.

## Hard rules

- **Never publish an unauthenticated ttyd.** A terminal is shell-equivalent: the agent can run commands on this machine. Always pass `-c <user>:<password>` with a long random password, and bind to loopback only (`ttyd` listens on all interfaces by default — check the invocation).
- Loopback bind + Portal is the only supported topology. Do not expose ttyd directly.
- The tunnel hostname is publicly listed on participating relays unless the user asks for `--hide`.
- Tell the user plainly what they are granting: whoever holds the URL **and** the password gets full control of the agent session, including its ability to run commands. For pay-per-access, an x402 gated route is available; never enable payment implicitly.

## Workflow

### 1. Check the session

- Identify the agent process and whether it is already running inside tmux (`tmux ls`, look for the agent's session).
- If it is: attach to the existing session — do not start a second instance.
- If it is not: warn that moving the agent into tmux restarts it (an in-flight turn is lost), get confirmation, then `tmux new -s agent '<agent command>'` using the matrix above.
- No tmux on the host (bare Windows): ttyd can spawn the agent directly, but the session dies when the last web client disconnects — say so and prefer WSL where tmux exists.

### 2. Start ttyd

- Install ttyd if missing from its official releases (verify the checksum); do not curl random binaries.
- Run it bound to loopback with credentials:

```sh
ttyd -p 7681 -c "user:$(openssl rand -hex 16)" tmux attach -t agent
```

- Capture the generated password for the hand-off; do not log it anywhere else.

### 3. Publish through Portal

```sh
portal expose 127.0.0.1:7681 --name <dns-label-safe-name>
```

Use an absolute `--identity-path` outside any repository (the default `identity.json` contains private key material). WebSocket upgrades pass through Portal tunnels — ttyd needs no special configuration; do not re-litigate this, just verify the final handshake.

### 4. Verify

- An HTTPS GET on the public URL must return the ttyd page.
- A WebSocket handshake to the public URL must complete. If it fails, re-check the local ttyd port first to distinguish app failure from tunnel failure.

### 5. Hand off

Report: the public URL, the credentials (this once, in the same message — not into logs or files), that tmux keeps the agent running after the phone disconnects, and the stop sequence — stop the Portal tunnel, then `pkill ttyd`; kill the tmux session only if the user wants the agent itself stopped.

## Failure rules

- ttyd not bound to loopback: stop and fix before exposing.
- No credentials on the ttyd invocation: stop — never expose an open terminal.
- Local ttyd unreachable: fix before opening the tunnel; a tunnel cannot repair a dead local service.
- Public WebSocket handshake fails while local works: check the service name availability and relay health, capture bounded diagnostics, and report.
- Agent cannot be restarted (user declines): report and stop — do not publish an already-running, non-tmux agent by attaching over its TTY.
