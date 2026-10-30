# claude-peers

_Originally created by [louislva](https://github.com/louislva/claude-peers-mcp). This fork adds fleet-wide federation._

Fleet-wide peer discovery and messaging for Claude Code.

Run Claude Code across multiple machines? `claude-peers` lets every instance find and talk to every other instance — across terminals, projects, and machines. Messages arrive instantly via [MCP channels](https://modelcontextprotocol.io).

```
  Laptop                  Desktop                  Autonomous Node
  ┌──────────────┐       ┌──────────────┐         ┌──────────────┐
  │ Claude ×2    │       │ Claude ×1    │         │ Claude ×1    │
  │ (two tabs)   │       │              │         │ (headless)   │
  └──────┬───────┘       └──────┬───────┘         └──────┬───────┘
         │                      │                        │
         └──────────────┬───────┴────────────────────────┘
                        ▼
              ┌──────────────────────┐
              │  Central Broker      │
              │  Always-on server    │
              │  SQLite + HTTP       │
              │  :7899               │
              └──────────────────────┘
                        │
              All peers visible to all.
              Any session can message any other.
```

## How it works

A **broker daemon** runs on one machine (your always-on server, ideally). Every Claude Code session spawns an **MCP server** that registers with the broker and polls for messages. Inbound messages are pushed into the session via MCP channel notifications — Claude sees them immediately.

Each peer registers with:
- A unique ID (auto-generated)
- Machine name (hostname or configured)
- Working directory and git context
- A summary of what it's working on

The broker handles discovery, message routing, and stale peer cleanup.

## Quick start

> **Joining a network someone else runs?** Follow [docs/joining.md](docs/joining.md)
> instead: it covers Linux, macOS and Windows and skips everything about running
> the broker.

### 1. Install

```bash
git clone https://github.com/hinescreative/claude-peers-mcp.git ~/mcp-servers/claude-peers-mcp
cd ~/mcp-servers/claude-peers-mcp
bun install
```

### 2. Start the broker

Pick one machine to host the broker. Run it directly or as a service:

```bash
# Generate a token
python3 -c "import secrets; print(secrets.token_urlsafe(32))"

# Start the broker
CLAUDE_PEERS_TOKEN=your-secret-token bun broker.ts
```

The broker binds to `0.0.0.0:7899` by default. See [Running as a service](#running-as-a-service) for production setups.

### 3. Configure Claude Code on each machine

Add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "claude-peers": {
      "type": "stdio",
      "command": "bun",
      "args": ["/path/to/claude-peers-mcp/server.ts"],
      "env": {
        "CLAUDE_PEERS_BROKER_URL": "http://your-broker-ip:7899",
        "CLAUDE_PEERS_TOKEN": "your-secret-token",
        "CLAUDE_PEERS_MACHINE": "this-machine-name"
      }
    }
  }
}
```

The token decides which [channel](#channels-users-and-per-user-tokens) the
session joins. To be in a second channel as well, add a second entry with that
channel's token and a `CLAUDE_PEERS_LABEL`, so the session can tell which
entry a message came through and replies through the same one:

```json
{
  "mcpServers": {
    "claude-peers": { "...": "as above, default-channel token" },
    "claude-peers-lab": {
      "type": "stdio",
      "command": "bun",
      "args": ["/path/to/claude-peers-mcp/server.ts"],
      "env": {
        "CLAUDE_PEERS_BROKER_URL": "http://your-broker-ip:7899",
        "CLAUDE_PEERS_TOKEN": "token-for-the-lab-channel",
        "CLAUDE_PEERS_MACHINE": "this-machine-name",
        "CLAUDE_PEERS_LABEL": "lab"
      }
    }
  }
}
```

`bun cli.ts --db grant <user> <channel> [device]` prints a ready-made entry
like this, label included. The label is only a display name; it does not pick
the channel.

### 4. Enable channels

These are Claude Code's push notifications, not the peer channels above.

Add to `~/.claude/settings.json`:

```json
{
  "channelsEnabled": true
}
```

This allows incoming peer messages to interrupt the session in real time. Without it, messages still arrive but require manually calling `check_messages`.

If several peers are active and Claude starts returning temporary server-side rate-limit errors, set `CLAUDE_PEERS_RESPONSE_DELAY_MS` to delay inbound channel notifications:

```bash
CLAUDE_PEERS_RESPONSE_DELAY_MS=30000 claude --dangerously-load-development-channels server:claude-peers
```

### 5. Use it

Start Claude Code normally. The MCP server connects to the broker automatically.

> List all peers across the fleet

> Send a message to peer abc123: "what are you working on?"

## Tools

| Tool | Description |
|------|-------------|
| `list_peers` | Discover other instances. Scopes: `fleet` (all machines), `machine` (same host), `directory` (same cwd), `repo` (same git root) |
| `send_message` | Send a message to another instance by peer ID. Arrives instantly via channel push |
| `set_summary` | Set a 1-2 sentence summary of current work, visible to other peers |
| `check_messages` | Manually check for messages (fallback when channels aren't enabled) |

## Codex peer

Codex can join the same broker with the sibling MCP server:

```bash
codex mcp add codex-peers -- bun /path/to/claude-peers-mcp/codex-server.ts
```

If the broker is remote or authenticated, pass the same environment variables used by Claude peers:

```bash
codex mcp add codex-peers \
  --env CLAUDE_PEERS_BROKER_URL=http://127.0.0.1:7899 \
  --env CLAUDE_PEERS_TOKEN=... \
  --env CODEX_PEER_NAME=codex-main \
  -- bun /path/to/claude-peers-mcp/codex-server.ts
```

Codex tools:

| Tool | Description |
|------|-------------|
| `peer_status` | Show Codex's peer ID, broker URL, machine, cwd, git root, and summary |
| `list_peers` | Find Claude/Codex peers. Scopes: `fleet`, `machine`, `directory`, or `repo` |
| `send_message` | Send a message to another peer by ID |
| `set_summary` | Describe what this Codex peer is doing |
| `check_messages` | Poll Codex's peer inbox |

Codex does not currently receive Claude's `claude/channel` push notifications. It participates by polling with `check_messages`, then replying with `send_message`.

If `CLAUDE_PEERS_BROKER_URL` or `CLAUDE_PEERS_TOKEN` are not set in Codex's MCP config, `codex-server.ts` will try to inherit them from the existing `claude-peers` entry in `~/.mcp.json`. This keeps Codex pointed at the same fleet broker without duplicating the token into `~/.codex/config.toml`.

## Architecture

```
  Laptop (macOS)           Desktop (Windows)        Server (Linux)
  ┌──────────┐            ┌──────────┐            ┌──────────────────┐
  │ Claude A │            │ Claude C │            │ Broker daemon    │
  │  ↕       │            │  ↕       │            │ 0.0.0.0:7899     │
  │ MCP srv  │──────┐     │ MCP srv  │──────┐     │ SQLite + HTTP    │
  │ (stdio)  │      │     │ (stdio)  │      │     │                  │
  ├──────────┤      │     └──────────┘      │     │ Also runs Claude │
  │ Claude B │      ├────────────────────────┼────>│  ↕               │
  │  ↕       │      │                       │     │ MCP srv D        │
  │ MCP srv  │──────┘                       └────>│                  │
  │ (stdio)  │                                    └──────────────────┘
  └──────────┘
         Multiple sessions per machine. All route through one broker.
```

| File | Role |
|------|------|
| `broker.ts` | Central HTTP server + SQLite. One per fleet. Handles registration, discovery, message routing, stale peer cleanup |
| `server.ts` | MCP stdio server. One per Claude Code session. Registers with broker, polls for messages, pushes channel notifications |
| `cli.ts` | Terminal utility for inspecting broker state and sending messages |
| `shared/types.ts` | Shared TypeScript types for the broker API |
| `shared/summarize.ts` | Optional auto-summary via OpenAI |

## Authentication

All POST endpoints require a Bearer token. The `/health` endpoint is open for monitoring.

```bash
# Generate a token
python3 -c "import secrets; print(secrets.token_urlsafe(32))"

# Both broker and clients use the same token
CLAUDE_PEERS_TOKEN=your-token bun broker.ts
```

## Channels, users and per-user tokens

The Bun broker can split the fleet into **channels**. Each token belongs to one
**user** and one **channel**; a session only sees, messages and mutates peers in
its token's channel, and peers in other channels look exactly like missing
ones. The `default` channel always exists. A user can hold several live tokens
in a channel, one per device label (the unlabelled token is the default), so
each PC gets its own token and can be reissued or revoked on its own. The
broker stores only each token's SHA-256 hash and shows the token once.

Peer tokens are only peer credentials: **no token, not even the shared fleet
token, can use the admin API.** Admins log in with a username and password
(argon2id) and get a session (12 h by default).

Existing `CLAUDE_PEERS_TOKEN`/`CLAUDE_PEERS_TOKENS`/`CLAUDE_PEERS_TOKENS_FILE`
tokens keep working as peer tokens: they act as the non-admin `legacy` user in
`default`. Existing peers and messages migrate to `default` on first start. An
unauthenticated broker stays open only until the first channel token is minted.

Manage access on the broker host with the direct-DB CLI (`--db` opens
`CLAUDE_PEERS_DB`; no HTTP or token involved):

```bash
bun cli.ts --db users add nic --admin
bun cli.ts --db passwd nic            # prompts without echo; --stdin when piped
bun cli.ts --db channels add lab
bun cli.ts --db users add alice
bun cli.ts --db grant alice lab       # prints the token once + an mcpServers block
bun cli.ts --db grant alice lab "alice laptop"   # a second device, its own token
bun cli.ts --db reissue alice lab "alice laptop" # revoke and mint in one step
bun cli.ts --db revoke alice lab "alice laptop"  # just that device
bun cli.ts --db revoke alice lab      # without a label: every token alice has in lab
bun cli.ts --db users                 # users and their grants (never tokens)
```

Revoking a token, disabling or removing a user, or removing a channel takes
effect on the next request and drops the affected peers. To join two channels
from one session, add two MCP entries (e.g. `claude-peers` and
`claude-peers-lab`), each with its own token; `CLAUDE_PEERS_LABEL` tags each
entry's instructions and messages so the session can tell them apart. The
label is only a display name: the channel always comes from the token (see
[Configuration](#configuration)).

The dashboard's **Access** view does the same from a browser. Admins log in
with username and password; the dashboard keeps the session in an HttpOnly,
SameSite=Strict cookie, and every admin call also needs a same-origin
`X-Peers-Admin` header. Admins get users (admin flag, password, disable,
remove), channels, per-user grants with create/revoke/reissue (one row per
device token; **Add device** asks for the label), and live peers
by channel. Pasting a peer token gives a read-only list of its own channel.
The dashboard's own `CLAUDE_PEERS_TOKEN` is never used for any of this. Broker
routes: [`docs/peers-broker-CONTRACT.md`](docs/peers-broker-CONTRACT.md) §2a.

### Network access: direct and edge

Every request is **external**, **direct**, or refused with `403`:

- **External**: it carries `X-Peers-Edge-Secret` matching
  `CLAUDE_PEERS_EDGE_SECRET`; the client is `X-Peers-Client-IP`. Any
  edge-secret header that does not match (empty, stale, or the broker has no
  secret) is refused; it never falls back to the socket address.
- **Direct**: a valid dashboard `X-Peers-Proxy-Secret` (from any address), a
  request on the optional local-only listener, or a socket address inside
  `CLAUDE_PEERS_DIRECT_CIDRS` (default `127.0.0.0/8,::1/128`; add your LAN, e.g.
  `127.0.0.0/8,::1/128,10.1.2.0/24`).
  Docker bridge ranges are deliberately not direct: traffic masqueraded from
  other docker networks (Caddy's included) arrives from the bridge gateway
  (172.21.0.1). The docker host's own connections to its LAN address arrive
  from that LAN address (DNAT, no masquerade), so they are direct already.
- **Local-only listener** (optional, off by default): `CLAUDE_PEERS_LOCAL_PORT`
  opens a second listener, bound to `CLAUDE_PEERS_LOCAL_HOST` (default
  `127.0.0.1`), whose requests are direct. It trusts the port, not the source
  address, so it must only ever be reachable from loopback: in docker, bind
  `0.0.0.0` inside the container and publish it on host loopback only
  (`127.0.0.1:<port>:<port>`), never on a LAN or public address.
- Anything else carrying `X-Peers-Client-IP` without a valid secret is
  refused, so a Caddy that drops or empties the secret header fails closed.

Direct requests behave as before. External requests also need the token's
user to have a matching CIDR in its allowlist (Access tab, or
`bun cli.ts --db ips <user> [add <cidr> [note] | rm <cidr>]`); an empty list
means no external access. External `GET /health` gets `403` unless the
address is on some enabled user's list; every external auth failure (missing
or bad token, unlisted address) is the same `403`; `/admin/*` is never served
externally. Refusals are logged (last 200, at most one row per address every
10 s, no tokens) under
**Recent blocked** on the Access tab, with a one-click "Allow for <user>".
`CLAUDE_PEERS_LEGACY_SEED_CIDRS` seeds the legacy (shared-token) user's list
once, so existing external peers keep working at deploy.

### Going live (docker deployment)

1. Rebuild and restart the broker and dashboard once (this drops peers for
   about a minute). The shared fleet token keeps working unchanged.
2. Create the first admin, either way:
   - add `CLAUDE_PEERS_ADMIN_PASSWORD: "${CLAUDE_PEERS_ADMIN_PASSWORD}"` (and
     optionally `CLAUDE_PEERS_ADMIN_USER`) to the broker's `environment:` in
     `docker-compose.yml` and the value to `.env` (visible to `docker inspect`).
     This is first-run bootstrap only: after the first start the variable is
     ignored (with a warning), even if that admin is later deleted, so remove
     it; or
   - `docker exec claude-peers-broker bun cli.ts --db users add nic --admin`, then
     `docker exec -it claude-peers-broker bun cli.ts --db passwd nic`.
3. Set `CLAUDE_PEERS_PUBLIC_BROKER_URL` on the dashboard service to the URL
   clients dial (the dashboard itself talks to `http://broker:7899`), so the
   generated `mcpServers` blocks point at the right broker.
4. Set the same random `CLAUDE_PEERS_PROXY_SECRET` on both the broker and the
   dashboard (`.env` plus both `environment:` lists). **The dashboard needs it
   to reach the broker at all** (its docker address is not direct), and admin
   login is refused (503) without it. The dashboard forwards each browser's socket
   address, so failed-login backoff applies per browser. This assumes the
   dashboard is reached directly on the LAN with no proxy in front;
   proxy headers such as `CF-Connecting-IP` are not trusted.
5. External access through Caddy. Add to `.env`:
   `CLAUDE_PEERS_EDGE_SECRET=<random, different from the proxy secret>`, and to
   the broker's `environment:`:

   ```yaml
   CLAUDE_PEERS_EDGE_SECRET: "${CLAUDE_PEERS_EDGE_SECRET:?set CLAUDE_PEERS_EDGE_SECRET in .env}"
   CLAUDE_PEERS_LEGACY_SEED_CIDRS: "203.0.113.7/32,198.51.100.7/32"
   CLAUDE_PEERS_DIRECT_CIDRS: "127.0.0.0/8,::1/128,10.1.2.0/24"   # your LAN
   ```

   Give the Caddy container the same `CLAUDE_PEERS_EDGE_SECRET` in its
   environment, or paste the value in place of the placeholder. Then replace
   the `peers.example.com` site block (keep any existing `tls`/`log` lines):

   ```caddyfile
   peers.example.com {
   	respond /admin/* 404
   	reverse_proxy 10.1.2.29:7899 {
   		# header_up replaces whatever the client sent.
   		header_up X-Peers-Client-IP {remote_host}
   		header_up X-Peers-Edge-Secret {env.CLAUDE_PEERS_EDGE_SECRET}
   		header_up -X-Peers-Proxy-Secret
   	}
   }
   ```

   The old `@allowed remote_ip` matcher goes away; the seeded legacy list
   carries those addresses.
6. Verify:
   - from an allowlisted address, through Caddy:
     `curl -s https://peers.example.com/health` returns `{"status":"ok",…}`
     and a peer session using that URL registers and lists peers. **This is
     the only check that proves Caddy sends a valid edge secret**; a `403`
     from an unlisted address (next check) looks the same whether the secret
     is right or wrong;
   - from an address on no list (e.g. a phone hotspot):
     `curl -s -o /dev/null -w '%{http_code}\n' https://peers.example.com/health` prints `403`,
     and the attempt shows under Recent blocked;
   - the fail-closed path. Each of these must print or show `403`:
     - Caddy's own traffic without the secret (masqueraded to 172.21.0.1):
       `docker exec caddy wget -q -S -O /dev/null http://10.1.2.29:7899/health 2>&1 | grep HTTP/`
     - a spoofed client address with an empty secret header, from the broker host
       (`-H 'Name;'` is how curl sends an empty header; `-H 'Name: '` drops it):
       `curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Peers-Client-IP: 10.1.2.10' -H 'X-Peers-Edge-Secret;' http://10.1.2.29:7899/health`
     - from another LAN host (a direct address), a stale and an empty secret:
       `curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Peers-Edge-Secret: stale' http://10.1.2.29:7899/health`
       and `curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Peers-Edge-Secret;' http://10.1.2.29:7899/health`;
   - direct access still works: `curl -s http://10.1.2.29:7899/health`
     on the broker host and from another LAN host returns `{"status":"ok",…}` (the broker host's own
     sessions keep their current URL), and the dashboard shows peers.
7. Log in on the dashboard's Access tab, add channels and users, grant
   tokens, and add external CIDRs for users who connect from outside.

## Rotating the fleet token

The Bun broker accepts the union of `CLAUDE_PEERS_TOKEN` (the legacy single
value), `CLAUDE_PEERS_TOKENS` (comma or newline separated), and
`CLAUDE_PEERS_TOKENS_FILE` (a path to a UTF-8 file containing one token per line).
Empty list/file lines are ignored and duplicates count once. Clients continue
sending one bearer token. All accepted tokens are compared in constant time using
fixed-size SHA-256 digests; logs contain only the count, never token values.

Use a mode `600` token file owned by the broker's user. For systemd, point
`Environment=CLAUDE_PEERS_TOKENS_FILE=/absolute/path/to/tokens` at a file refreshed
privately from `opa` before startup (the `ExecStartPre` pattern already used by the
fleet dashboard units). Write a replacement file with mode `600` and atomically
rename it over the old file; preserve the new mtime. The file contains raw tokens,
not shell `KEY=value` assignments. Keep secret values out of command lines/logs.

Before deploying this feature, fast-forward the broker host's checkout to the reviewed, merged main. That activation needs a separately scheduled broker restart; this change does not deploy or restart anything. Once this version runs with the file configured, rotations need no broker restart:

1. Add the new token alongside the old token in the file.
2. Send SIGHUP with `systemctl --user kill --kill-whom=main --signal=HUP claude-peers-broker.service`,
   or let the next authenticated request after the check interval reload it
   (checks run at most once every 10 seconds; with no requests, reload waits).
   Verify the broker logs `accepted tokens: N` and both credentials work.
3. Move clients to the new token one by one, reconnecting cached MCP/edge clients
   as needed, and verify each seat can authenticate and send/receive.
4. Remove the old token from the file, then send SIGHUP again (or wait for the
   request-driven check). Verify the new token works and the old token gets 401.

`SIGHUP` rereads the configured file; it cannot change a running process's env.
**Remove the old token from the broker's env during initial file setup**, or it
will remain accepted through the union even after removal from the file.
Startup fails if a configured file cannot be read. Reload read failures keep the
last complete accepted set and log an error; an empty readable file revokes its
tokens and does not switch to open mode. With no token configuration, legacy
open mode still warns; `CLAUDE_PEERS_REQUIRE_AUTH=1` rejects startup with zero
accepted tokens. Startup and every successful reload log the deduplicated count.

## Peer lifecycle

1. **Registration** — MCP server registers with the broker on session start (PID, cwd, git root, machine name)
2. **Heartbeat** — MCP server pings the broker every 15 seconds
3. **Discovery** — Any peer can list others, scoped by fleet/machine/directory/repo
4. **Messaging** — Send by peer ID; broker queues the message; recipient's MCP server polls and pushes via channel notification. A send to an absent or unknown peer is still accepted and queued (see [docs/wake.md](docs/wake.md)); the reply's `wake` field says whether anything was woken
5. **Cleanup** — Local peers: PID-checked every 30s. Remote peers: expire after `CLAUDE_PEERS_TTL_MINUTES` (default 20) without activity. Undelivered messages whose recipient is not in their channel are dropped after 24 hours
6. **Unregister** — MCP server unregisters on clean session exit

Unacknowledged leased messages become claimable again after the broker's
visibility timeout (30 seconds by default). Each client session pushes a given
message to the host inbox or channel at most once every five minutes after a
successful write. `check_messages` still returns recoverable messages during that
cooldown; draining the buffer does not reset it. Failed writes can retry on the
next claim. Successful application acks also remove buffered copies and fence
pending claims and writes, even before the first push or after reminder expiry.
This separate acknowledgment history retains the most recent 4,096 IDs per
session; ack does not clear reminder timestamps. Both histories reset on MCP
restart. Writes already handed to a transport before ack cannot be retracted.

## Running as a service

### systemd (Linux)

```ini
# ~/.config/systemd/user/claude-peers-broker.service
[Unit]
Description=Claude Peers Broker
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/claude-peers-mcp
Environment=PATH=%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=CLAUDE_PEERS_TOKEN=your-secret-token
ExecStart=%h/.bun/bin/bun broker.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-peers-broker
```

### launchd (macOS)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-peers.broker</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/.bun/bin/bun</string>
        <string>/path/to/claude-peers-mcp/broker.ts</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_PEERS_TOKEN</key>
        <string>your-secret-token</string>
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

## CLI

```bash
export CLAUDE_PEERS_BROKER_URL=http://your-broker-ip:7899
export CLAUDE_PEERS_TOKEN=your-secret-token

bun cli.ts status              # Broker status + all peers
bun cli.ts peers               # List peers across the fleet
bun cli.ts send <id> <message> # Send a message to a peer
bun cli.ts kill-broker         # Stop the broker (local only)
```

## Auto-summary

If `OPENAI_API_KEY` is set, each instance generates a brief summary on startup using `gpt-5.4-nano` describing what you're likely working on based on directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PEERS_BROKER_URL` | `http://127.0.0.1:7899` | Broker URL (MCP server + CLI) |
| `CLAUDE_PEERS_PORT` | `7899` | Broker listen port |
| `CLAUDE_PEERS_TOKEN` | — | Bearer token for authentication |
| `CLAUDE_PEERS_TOKENS` | — | Additional accepted tokens, comma/newline separated (broker only) |
| `CLAUDE_PEERS_TOKENS_FILE` | — | Reloadable one-token-per-line file, mode 600 (broker only) |
| `CLAUDE_PEERS_MACHINE` | `hostname` | Machine name for this peer |
| `CLAUDE_PEERS_LABEL` | — | Display name for this MCP entry, up to 64 chars (MCP server only). Not the channel: the token decides that. With two claude-peers entries in one session (e.g. one per channel), it is added to each entry's instructions and to its messages (`label="..."`) so the session replies through the right one. `cli.ts grant` sets it to the channel name for non-default channels |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | SQLite database path (broker only) |
| `OPENAI_API_KEY` | — | Enables auto-summary generation |

## Requirements

- [Bun](https://bun.sh) v1.0+
- Claude Code v2.1.71+
- Network connectivity between machines (Tailscale, LAN, VPN, etc.)

## Fleet values stay out

Hostnames, addresses, home paths, and deploy notes do not belong in new commits. `.gitleaks.toml` refuses them. The check says: fleet value; put it in the operator's private deploy notes (see CLAUDE.md).

Values already in the source stay, on purpose. Those lines are allowlisted so an unrelated edit in the same file still commits. A new line is refused.

Do not set `core.hooksPath`. Do not write a hook outside this clone. `git rev-parse --git-path hooks` follows a global hooks path; do not use it.

If `git config --global core.hooksPath` is already set, add one line to that existing pre-commit: run `scripts/precommit-gitleaks.sh` when the repo contains a `.gitleaks.toml`. On this fleet that edit belongs to the autopush hook owner. The step is in the operator's private deploy notes. This repo does not make it.

Otherwise copy the script into this clone:

```sh
hooks="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
mkdir -p "$hooks"
cp scripts/precommit-gitleaks.sh "$hooks/pre-commit"
chmod +x "$hooks/pre-commit"
```

## Credits

Forked from [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp). Original: single-machine peer discovery via localhost broker. This fork adds fleet-wide federation, token authentication, machine-aware peer tracking, and cross-machine message routing.
