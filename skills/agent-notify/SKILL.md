---
name: agent-notify
description: Push phone notifications when a CLI agent finishes a turn, needs input, or hits an error - a self-hosted ntfy server (with its own token auth) exposed through a Portal tunnel. Use when the user asks to be notified about agent activity, get alerts on their phone when a long task completes, or monitor an agent they are not watching. Do not use for interactive remote access (agent-terminal / agent-web); this is the asynchronous companion.
license: MIT
---

# Agent Activity on Your Phone

Long agent turns are the async gap in remote access: you leave, the agent works. This pattern closes it — the agent's own hook fires on turn end or permission prompt, curls a private ntfy topic, and the phone gets a push. The notification server is self-hosted (content never touches a third-party service) and ntfy's built-in token auth is the gate: verified `403` without a token, publish and subscribe with one, end to end through a Portal tunnel.

## Verified facts (ntfy 2.27, tested end to end)

- `ntfy serve --auth-file <db> --auth-default-access deny-all --listen-http 127.0.0.1:7682` — loopback, deny-by-default.
- **`user add` / `token add` read the auth DB from the `NTFY_AUTH_FILE` environment variable**, not from command-line flags placed after the subcommand (flag placement is silently ignored — set the env var). The server must run once to create the DB file.
- Publish: `POST <url>/<topic>` with `Authorization: Bearer <token>` → `200`; without → `403`.
- Subscribe: `GET <url>/<topic>/sse` with the same header; phone app subscribes identically with the token configured per subscription.
- Through `portal expose`: identical behavior on the public URL.

## Hard rules

- `auth-default-access deny-all` always; access exists only through minted tokens.
- The token is a credential — hand it over once (to the phone), never into logs or committed files.
- Notification content carries only labels and status ("turn finished", "permission needed"), never session payloads or secrets.
- `--hide` on the tunnel: a notification endpoint gains nothing from being listed.

## Workflow

### 1. Set up the server

```sh
ntfy serve --auth-file ~/ntfy/auth.db --auth-default-access deny-all \
  --listen-http 127.0.0.1:7682 --base-url https://<tunnel-host>   # run once to create the DB
```

Manage users with the env var set:

```sh
NTFY_AUTH_FILE=~/ntfy/auth.db NTFY_PASSWORD=$(openssl rand -hex 12) ntfy user add --role=admin <name>
NTFY_AUTH_FILE=~/ntfy/auth.db ntfy token add <name>      # → tk_... ; this goes to the phone
```

The phone app: add subscription `<tunnel-host>/<topic>`, paste the token in the subscription's auth settings.

### 2. Expose through Portal

```sh
portal expose 127.0.0.1:7682 --name <hard-to-guess-name> --hide
```

### 3. Wire the agent hook

The hook is one curl; adapt to the agent's hook system (Claude Code Notification hooks, OMP hooks — both run a command on turn end / permission prompts):

```sh
curl -s -H "Authorization: Bearer <token>" -d "agent: turn finished" \
  https://<tunnel-host>/<topic> >/dev/null
```

Write the hook into the agent's config per its own hook syntax; the skill does not assume one format.

### 4. Verify end to end

- No token → `403` (local and public).
- Publish with token → `200`, and the phone app shows the message within seconds.
- Trigger one real agent event and see it arrive — the hook path is the part scripts get wrong (wrong shell, wrong quoting).

### 5. Hand off

Report: the tunnel URL, the topic(s), that the token lives only on the phone, how to add another person (`token add` + subscribe), and rotation (delete token, mint new, update phone).

## Failure rules

- Anonymous publish returns anything but `403`: the server is misconfigured (check `auth-default-access`) — stop and fix before exposing.
- Phone silent while curl works: the subscription URL or token on the phone is wrong; re-verify with curl against the public URL.
- Token leaked anywhere: delete it (`token remove`), mint a new one.
- Notifications carrying secrets observed in any hook: rewrite the hook to labels-only and rotate the token.
