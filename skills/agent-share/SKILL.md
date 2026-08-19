---
name: agent-share
description: Turn one persistent Portal tunnel into a shared space - a single stable HTTPS domain guarded by per-person tokens (caddy basic_auth), with the user's services behind it. Use when the user asks to share access with a team or friends, invite people to their services, set up a shared dev space or community demo space, or manage who can enter and revoke access. Do not use for one-off personal access without sharing (agent-terminal / agent-web), which does not need a persistent domain or multi-person tokens.
license: MIT
---

# One Stable Domain, Per-Person Tokens, Many Services

The share space composes what the other skills build one-off: a **persistent Portal tunnel** (stable hostname), one **caddy basic_auth gate** in front (a labeled token per person), and the user's services behind it. Inviting someone is minting a token; removing them is deleting a line and reloading — verified to revoke instantly while other members stay connected without a drop.

Security model, stated up front: the gate runs on the user's machine, tenant TLS terminates at the tunnel, the relay sees only ciphertext, and `--hide` keeps the hostname out of public relay listings. Tokens are the boundary; the listing question is discoverability, not access control.

## Hard rules

- Every token is long and random (`openssl rand -hex 16` or better); the label identifies the person, the value is the grant.
- Store token hashes only. The generated Caddyfile contains bcrypt hashes; the plaintext exists exactly once, in the hand-off message to that person.
- The persistent tunnel uses a hard-to-guess `--name` even with `--hide` — name guessing is the practical scan vector when a listing leaks.
- Never enable x402 payment implicitly; a paid route on the shared domain is an explicit user decision.
- Revocation is not complete until verified: after `caddy reload`, confirm the revoked token gets `401` and every remaining token still gets `200`.

## Workflow

### 1. Establish the persistent tunnel

A share space needs a hostname that survives restarts: a Portal agent-managed tunnel, not an ad-hoc `expose`. Inspect any existing agent config first and merge rather than replace — the same agent may own unrelated tunnels. Minimal entry:

```toml
[[tunnels]]
service_name = "<hard-to-guess-name>"
target = "127.0.0.1:8090"   # the gate, not any single service
hide = true
```

Run or restart the agent service per the user's setup; confirm the stable URL is served.

### 2. Build the gate (verified recipe, caddy 2.11)

One hash per person:

```sh
caddy hash-password --plaintext '<token for PERSON>'
```

```
:8090 {
    basic_auth {
        bob <bcrypt-hash>
        alice <bcrypt-hash>
    }
    reverse_proxy 127.0.0.1:7681   # or a caddy route block for several services
}
```

`basic_auth` is the current directive name (`basicauth` is deprecated and logs a warning). Multiple upstreams become a `route` block with path matchers — keep the gate at the edge and route behind it.

### 3. Verify before inviting anyone

- No credentials → `401`
- Each token → `200` and the expected service
- Through the public URL, not just loopback — the tunnel leg is part of the boundary

### 4. Add and revoke people

- **Add**: hash the new token, append the line, `caddy reload`. Verify `200` for the new member and that existing members are unaffected (reload is graceful; verified zero drop).
- **Revoke**: delete the person's line, `caddy reload`, then verify the revoked token returns `401` and the others still return `200`. A reload without verification does not count as revoked.
- Rotate-all: regenerate every hash in one edit, reload, hand out new tokens.

### 5. Hand off

Report: the stable URL, who currently holds tokens (labels only, never values — values went out once, directly to each person), how to add/revoke (the two-step above), and the stop sequence: Portal agent tunnel last, gate first.

## Failure rules

- A token appears in any log, file, or final response beyond its single hand-off: rotate it.
- Reload failed or Caddyfile rejected: the old config keeps serving — fix before proceeding, and re-verify all tokens afterward.
- Anyone reports access after revocation: treat the gate as compromised, rotate all tokens, and re-check that the running Caddyfile matches what you edited.
- User wants to un-hide the listing: allowed once the gate exists (the tokens are the boundary), but say plainly that the hostname becomes publicly discoverable.
