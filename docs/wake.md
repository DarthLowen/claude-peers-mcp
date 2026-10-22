# Peers wake

A send is stored, then the broker may ask the lead-wake edge that already runs on theoldone. The edge is `lead-wake-edge.ts`, `dispatch.mjs`, and `protocol.mjs`. It starts a Mac T3 thread, or queues behind a turn that is already running. The mail stays in the broker. The wake text is `peers mail waiting; run check_messages`.

## What forwards

The broker calls `POST $LEAD_WAKE_URL` with `to_id`, `from_id`, `kind`, `message_id`, `cwd`, and `machine`. The bearer is `CLAUDE_PEERS_TOKEN`, or the first line of `CLAUDE_PEERS_TOKENS_FILE` when that variable is unset. The wait is 3 seconds.

It calls when the recipient has no row, the row is stale, or the row's runtime is `poll`. A live seat with any other runtime is not forwarded. An id that is not `[a-zA-Z0-9_-]{3,64}` is stored as `wake: no-route` and the edge is not called. If `LEAD_WAKE_URL` is unset the wake is `unconfigured` and the edge is not called.

The sender sees `wake: sent`, `failed`, `no-route`, or `unconfigured` on the same response. `no-route` and `failed` are errors. A live seat has no wake line.

The edge checks `routes.json` first. Otherwise it uses the one live thread whose `worktreePath` is under `~/.t3/worktrees/` and equals the cwd, and that thread is not a fork. Anything else is `no-route`. A broker retry sends the same T3 command id, taken from the message id.

A seat with the channel disabled registers as runtime `poll`, so a send to it forwards while it is up. Codex exits when its parent process changes, the same check the Claude server already has. The next send then finds no live row and forwards.

## Deploy

Run this only after this PR is on main. On 2026-10-22 theoldone was still `b112981`. Nothing on the Mac changes. `~/bin/peers` stays the Python script at `/Users/wesleyhines/bin/peers`. Printing its wake line is a follow-up, not this PR. theoldone's local grok-edge patch is retired by this: the broker forwards for every sender, and the fallback in that patch is not in the repo.

```sh
cp -a /home/hinescreative/mcp-servers/claude-peers-mcp /home/hinescreative/mcp-servers/claude-peers-mcp.bak-2026-10-22
rm /home/hinescreative/mcp-servers/claude-peers-mcp/butler-inbox-edge.ts
mkdir -p /home/hinescreative/mcp-servers/claude-peers-mcp.bak-2026-10-22/untracked
mv /home/hinescreative/mcp-servers/claude-peers-mcp/lead-wake-edge.ts /home/hinescreative/mcp-servers/claude-peers-mcp/dispatch.mjs /home/hinescreative/mcp-servers/claude-peers-mcp/protocol.mjs /home/hinescreative/mcp-servers/claude-peers-mcp.bak-2026-10-22/untracked/
git -C /home/hinescreative/mcp-servers/claude-peers-mcp stash push -m "grok-edge local lead-wake patch 2026-10-22" -- grok-edge.ts
git -C /home/hinescreative/mcp-servers/claude-peers-mcp pull --ff-only origin main
```

Do not pop the stash. The unit already runs `~/mcp-servers/claude-peers-mcp/lead-wake-edge.ts`, so after the pull that path is the repo copy. The `mv` is only so the pull is allowed to write those three files.

```sh
mkdir -p /home/hinescreative/.config/systemd/user/claude-peers-broker.service.d
cat > /home/hinescreative/.config/systemd/user/claude-peers-broker.service.d/wake.conf <<'EOF'
[Service]
Environment=LEAD_WAKE_URL=http://100.108.57.10:8811/wake
EOF
systemctl --user restart claude-peers-lead-wake.service
umask 077
tac /home/hinescreative/.config/claude-peers/broker-tokens.txt > /home/hinescreative/.config/claude-peers/broker-tokens.txt.new
chmod 600 /home/hinescreative/.config/claude-peers/broker-tokens.txt.new
mv /home/hinescreative/.config/claude-peers/broker-tokens.txt.new /home/hinescreative/.config/claude-peers/broker-tokens.txt
# needs Wes's go
systemctl --user daemon-reload
systemctl --user restart claude-peers-broker.service
```

Lead-wake already listens on `100.108.57.10:8811`, not on loopback. The broker unit has `CLAUDE_PEERS_TOKENS_FILE` and no `CLAUDE_PEERS_TOKEN`. The outbound bearer is the first line of that file. On 2026-10-22 the file had two lines: the old token first (sha256 prefix `73c69fab`) and the current token second (`052541b3`). The edge's `edge.env` holds the current one. The `tac` puts the current token first. Do not print the file. The broker reloads the tokens file when it changes (PR #2), so the restart is not what picks up the new order. The rule: the first line of the tokens file is the token the edge accepts. The unit already runs `~/mcp-servers/claude-peers-mcp/lead-wake-edge.ts`, which is the repo copy after the pull. The routes file stays `~/.local/state/lead-wake/routes.json`.
