# Peers wake

A send is stored, then the broker may ask the lead-wake edge. The edge is `lead-wake-edge.ts`, `dispatch.mjs`, and `protocol.mjs`. It starts a T3 thread, or queues behind a turn that is already running. The mail stays in the broker. The wake text is `peers mail waiting; run check_messages`.

## What forwards

The broker calls `POST $LEAD_WAKE_URL` with `to_id`, `from_id`, `kind`, `message_id`, `cwd`, and `machine`. The bearer is `CLAUDE_PEERS_TOKEN`, or the first line of `CLAUDE_PEERS_TOKENS_FILE` when that variable is unset. The wait is 3 seconds.

It calls when the recipient has no row, the row is stale, or the row's runtime is `poll`. A live seat with any other runtime is not forwarded. An id that is not `[a-zA-Z0-9_-]{3,64}` is stored as `wake: no-route` and the edge is not called. If `LEAD_WAKE_URL` is unset the wake is `unconfigured` and the edge is not called.

The sender sees `wake: sent`, `failed`, `no-route`, or `unconfigured` on the same response. `no-route` and `failed` are errors. A live seat has no wake line.

The edge checks `routes.json` first. Otherwise it uses the one live thread whose `worktreePath` is under `~/.t3/worktrees/` and equals the cwd, and that thread is not a fork. Anything else is `no-route`. A broker retry sends the same T3 command id, taken from the message id.

A seat with the channel disabled registers as runtime `poll`, so a send to it forwards while it is up. Codex exits when its parent process changes, the same check the Claude server already has. The next send then finds no live row and forwards.

## Deploy

Placeholder defaults are loopback. Set them when the edge is not on the broker host. Host paths and the token-file order belong in the operator's private deploy notes, not here.

- `CLAUDE_PEERS_BROKER_URL` — default `http://127.0.0.1:7899`
- `LEAD_WAKE_HOST` — bind host, default `127.0.0.1`
- `CLAUDE_PEERS_MACHINE` — default the host name
- `LEAD_WAKE_URL` on the broker — the edge's `/wake` URL, for example `http://127.0.0.1:8811/wake`
- The bearer is `CLAUDE_PEERS_TOKEN` or the first line of `CLAUDE_PEERS_TOKENS_FILE`. The edge must accept that token. Do not print the file.

Order:

1. Check out this repo on the broker host.
2. Point the lead-wake unit at `lead-wake-edge.ts`.
3. Health-check the edge with the bearer. Restart the broker only when that check returns 200.
4. On each seat host, pull the same commit. A running seat picks up the server the next time it starts.
