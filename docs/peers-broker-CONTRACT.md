# cf-peers-broker CONTRACT

**As-of:** 2026-09-02 (CT)  
**Worker:** `cf-peers-broker` @ https://cf-peers-broker.wes-432.workers.dev  
**DO class:** `BrokerDO` (binding `BROKER_DO`)  
**Auth secret name:** `CLAUDE_PEERS_TOKEN` (Bearer on all POSTs)  
**Status:** Reconstructed online copy (June live CONTRACT.md was offline; rebuilt from Worker comments + preflight June section + live bun `/set-state` parity).

---

## §1 Purpose

Federated peers broker: register Claude/Codex/Grok peers, heartbeat, metadata updates, list peers, send/poll messages. CF Durable Object storage mirrors the bun SQLite broker success/error shapes for the June route set, plus live `/set-state`.

## §2 Auth

- `GET /health` — open (no auth).
- All `POST /*` — `Authorization: Bearer <CLAUDE_PEERS_TOKEN>`.
- Missing/wrong Bearer → `401 {"error":"unauthorized"}`.
- Secret unset on Worker → `500 {"error":"server misconfigured: CLAUDE_PEERS_TOKEN unset"}`.

### §2a Channels, per-user tokens and admin sessions (bun broker, 2026-10)

- Tables `users` (name, is_admin, disabled, optional argon2id `password_hash`), `channels` (name; `default` always exists), `tokens` (SHA-256 digest only; one live token per (user, channel); revoked rows kept for audit), `sessions` (SHA-256 digest of the session id, expiry), `meta`.
- Every peer POST resolves the bearer to exactly one (user, channel). Legacy `CLAUDE_PEERS_TOKEN`/`CLAUDE_PEERS_TOKENS`/`CLAUDE_PEERS_TOKENS_FILE` tokens resolve to the non-admin legacy user (`CLAUDE_PEERS_LEGACY_USER`, default `legacy`) in `default`. Open mode (no auth configured) resolves there too, until the first channel token is ever minted (persistent one-way flag).
- `peers` and `messages` carry `channel` (pre-channel rows migrate to `default`); peers also store `user_id`/`token_id`. Peer ids stay globally unique; `client_message_id` dedupe is per channel.
- Every route only sees and mutates its own channel. An id that belongs to another channel gets the route's normal unknown-peer answer (e.g. send → `{"ok":false,"error":"Peer X not found"}`). A colliding `requested_id` from another channel registers under a suffixed id.
- Revoking a token, disabling/deleting a user, or deleting a channel applies to the next request and drops the affected peers. Disabling the legacy user rejects the legacy tokens.
- `/register` (v2) also returns `channel`. `POST /whoami` → `{user, channel, is_admin}` (informational only). `/capabilities` adds `channels: true`. Unexpected errors return `500 {"error":"internal error"}`.
- **Peer tokens never grant admin.** Any `/admin/*` call with `Authorization: Bearer …` → `403`, whatever the token or its user's flags. Admin routes take `Authorization: Session <id>`; missing/invalid/expired → `401 {"error":"admin session required"}`.
- `POST /admin/login {user,password}` → `{user, session, expires_at}` for an enabled admin with a password; else `401 {"error":"invalid credentials"}` (also for malformed names). Failures back off per (user, client address) (`CLAUDE_PEERS_LOGIN_BACKOFF_MS`, default 1000, doubling to 60 s) with `429`, including while an attempt for that pair is still being verified, or while 4 attempts from that address are; per-user failures add at most a 0.5 s delay, never a refusal. The client address is the socket's, or `X-Peers-Client-IP` when the request carries `X-Peers-Proxy-Secret` matching `CLAUDE_PEERS_PROXY_SECRET` (the dashboard sends both). Sessions last `CLAUDE_PEERS_SESSION_TTL_SECONDS` (default 43200). `POST /admin/logout`, `POST /admin/whoami`. Disabling, demoting, deleting, or setting/clearing a user's password ends their sessions.
- Session routes, all POST JSON under `/admin/`: `list-users` (no hashes), `create-user {name,is_admin?}`, `update-user {name,is_admin?,disabled?}` (booleans only), `delete-user {name}`, `set-password {name,password}` (10-1024 chars), `clear-password {name}`, `list-channels`, `create-channel {name}`, `delete-channel {name}` (not `default`; revokes its tokens, drops its peers and messages), `list-tokens {user?,channel?,include_revoked?}` (metadata only), `grant {user,channel}` → `{user,channel,token,created_at}` (409 if live), `reissue {user,channel}` (revoke + mint atomically), `revoke {user,channel}`, `list-peers {user?,channel?}`. The legacy user cannot be deleted, promoted or given a password.
- `CLAUDE_PEERS_ADMIN_PASSWORD` (with `CLAUDE_PEERS_ADMIN_USER`, default `admin`) is first-run bootstrap only: it creates that admin once and sets `meta.admin_bootstrapped`; afterwards (or if the user already exists) it is ignored with a warning, even if the admin was later deleted. The value is never logged.
- The broker records the legacy user's id in `meta.legacy_user_id`; the direct-DB CLI reads it from there, not from its own env.
- Network gate (before auth, all methods), fail closed: any `X-Peers-Edge-Secret` header must match `CLAUDE_PEERS_EDGE_SECRET` (constant-time) or the request is refused; a match is external with client `X-Peers-Client-IP`. A valid `X-Peers-Proxy-Secret` (dashboard) is direct from any address. Any other request carrying `X-Peers-Client-IP` is refused. Requests on `CLAUDE_PEERS_LOCAL_PORT` are direct; otherwise the socket address must be in `CLAUDE_PEERS_DIRECT_CIDRS` (default `127.0.0.0/8,::1/128,10.1.2.0/24`; no docker bridge ranges, since the bridge gateway is the masquerade source). Refusal: `403 {"error":"forbidden"}`. External: `/admin/*` → 403; GET → 403 unless the address is on some enabled user's allowlist; every auth failure → 403; a valid token whose user has no matching CIDR → 403. Direct requests skip allowlists. Rejections are logged at most once per address per 10 s.
- `user_cidrs` (user, normalized cidr, note) and `net_rejections` (last 200; at, ip, user if the token was valid, route, reason; no tokens). Session routes: `list-cidrs {user?}`, `add-cidr {user,cidr,note?}` (single addresses become /32 or /128, host bits cleared; 409 duplicate), `remove-cidr {user,cidr}`, `list-rejections`, `clear-rejections`. `CLAUDE_PEERS_LEGACY_SEED_CIDRS` seeds the legacy user's list once (`meta.legacy_cidrs_seeded`).
- The CF Worker does not implement channels.

## §3 Request handlers

Each route reproduces the bun broker's exact success/error shape and side effects (Worker comment + June CONTRACT).

| Method | Path | Body (key fields) | Success shape | Notes |
|--------|------|-------------------|---------------|-------|
| GET | `/health` | — | `{"status":"ok","peers":N}` | Open |
| POST | `/register` | `requested_id`, `pid`, `cwd`, `summary`, `machine`, … | `{"id":…}` | Rejects bare `id`; requires `requested_id` |
| POST | `/heartbeat` | `id` | `{"ok":true,"found":bool}` | Touches `last_seen` |
| POST | `/set-summary` | `id`, `summary` | `{"ok":true}` | |
| POST | `/set-nickname` | `id`, `nickname` | `{"ok":true}` | CF returns ok even if missing (June shape) |
| POST | `/set-context` | `id`, context fields | `{"ok":true}` | |
| POST | `/set-state` | `id`, `blocked_on?`, `blocked_since?` | `{"ok":bool,"found":bool}` | Live bun parity (2026-09); see §3a |
| POST | `/list-peers` | `scope`, `cwd`, `git_root`, … | `[Peer,…]` | |
| POST | `/send-message` | `from_id`, `to_id`, `text` | `{"ok":true}` or `{"ok":false,"error":…}` | |
| POST | `/poll-messages` | `id` | `{"messages":[…]}` | Marks delivered |
| POST | `/unregister` | `id` | `{"ok":true}` | Deletes peer row only (messages kept) |
| other GET | `/*` | — | text `claude-peers broker (federated)` | Not a JSON version endpoint |
| unknown POST | — | — | `404 {"error":"not found"}` | |

### §3a `/set-state` (live bun parity)

Source of truth: theoldone `/home/hinescreative/mcp-servers/claude-peers-mcp/broker.ts` `handleSetState` (dirty local on `c7adea0`; matches GitHub `main`).

- Request: `{ "id": string, "blocked_on"?: string|null, "blocked_since"?: string|null }`
- `blocked_on` normalized: null/undefined→null; non-string→null; trim + max 128; empty→null.
- If peer missing → `{ ok: false, found: false }` (HTTP 200).
- If peer found → persist and `{ ok: true, found: true }`.
- `blocked_since` rules:
  - Explicit `blocked_since` string (trimmed non-empty) → use it; empty/non-string → null.
  - If `blocked_since` omitted and `blocked_on` omitted → keep prior since.
  - If `blocked_since` omitted and `blocked_on` set truthy → stamp `new Date().toISOString()`.
  - If `blocked_since` omitted and `blocked_on` cleared (null) → `blocked_since = null`.
- Does **not** alter `summary` (verified by bun process-table tests).

## §4 Storage (DO)

Keys: `peers`, `messages`, `nextMessageId`.  
In-memory Map/array write-through on every mutation.

Peer fields include June core + process-table: `blocked_on`, `blocked_since` (null until `/set-state`).

## §5 Default TTL

`CLAUDE_PEERS_TTL_MINUTES` default **20** minutes → `staleMs`.

## §6 Staleness + delete helpers

- `peerIsStale` — last_seen older than TTL.
- `deletePeerAndUndeliveredMessages` — peer + undelivered msgs to that peer (stale cleanup / stale send target).
- `deletePeer` — peer row only (unregister / re-register cleanup); leaves messages.

## §7 TTL-only prune (accepted fork vs bun)

**TTL-only prune — no PID-liveness reaping.**  
DO alarm ~30s TTL sweep, re-arming each fire.  
Bun may still PID-reap; CF intentionally does not. Do not “fix” CF to match PID behavior.

## §8 Edge / client env names

- Broker base URL knob: **`CLAUDE_PEERS_BROKER_URL`** (not bare `BROKER_URL`).
- Shared broker token: `CLAUDE_PEERS_TOKEN`.
- GB public MCP face stays `https://mcp.hinescreative.xyz/mcp` on cutover; only the edge→broker URL flips when Architect greenlights.

## §9 Non-goals / out of scope (this CONTRACT)

- `/claim-messages` / `/ack-messages` (Air tip ahead of live bun — not on CF).
- Custom domains for this Worker (workers.dev only unless separately decided).
- Client cutover / flipping `CLAUDE_PEERS_BROKER_URL` (hard gate: Architect + Wes).

## §10 Deploy notes

- Compatibility date: `2025-06-01`
- Migration tag: `v1` (`BrokerDO`)
- Secret: `CLAUDE_PEERS_TOKEN` (do not rotate casually)
