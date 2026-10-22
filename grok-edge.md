# Grok Chat MCP edge

Thin public MCP in front of the broker. Not a second bus.

```
Grok Chat custom connector
  → your tunnel → 127.0.0.1:8787/mcp
  → CLAUDE_PEERS_BROKER_URL (default http://127.0.0.1:7899)
```

## Tools

- `list_peers`
- `send_message` (`to_id`, `message`) — `from_id` pinned to the edge's peer id
- `check_messages` — poll that peer's queue

No `set_summary`, `register`, `unregister`, `set_state`, jobs, infer, FS, CRM.

## Run

On the broker host, or any host that can reach the broker:

```sh
cd /path/to/claude-peers-mcp

GROK_MCP_TOKEN="$(openssl rand -hex 24)" \
CLAUDE_PEERS_TOKEN="$CLAUDE_PEERS_TOKEN" \
CLAUDE_PEERS_BROKER_URL=http://127.0.0.1:7899 \
CLAUDE_PEERS_MACHINE=my-host \
GROK_EDGE_HOST=127.0.0.1 \
GROK_EDGE_PORT=8787 \
bun grok-edge.ts
```

Optional allowlist of peer ids:

```sh
GROK_PEER_ALLOWLIST=peer-a,peer-b
```

## Tunnel

Point a hostname you control at `http://127.0.0.1:8787`. Do not point it at the broker port.

```text
your-host.example → http://127.0.0.1:8787
```

Grok Chat → Connectors → Custom:

```text
URL:  https://your-host.example/mcp
Auth: Bearer GROK_MCP_TOKEN
```

Do not put `CLAUDE_PEERS_TOKEN` in the connector. That token stays with the broker.

An identity-aware proxy in front will likely break the connector handshake. Use the edge bearer first.

## Seat

On boot the edge registers its peer id and heartbeats every 15s so replies have a mailbox. If the edge dies, the broker TTL (20 min) drops the seat and undelivered mail.

Peers reply to the peer id, not to a nickname.
