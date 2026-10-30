# claude-peers

Peer discovery and messaging for Claude and Codex sessions. Bun + TypeScript.

- `broker.ts` HTTP daemon on :7899 + SQLite. Run it as the user systemd unit `claude-peers-broker.service` on the host you choose.
- `server.ts` MCP stdio server, one per Claude session. `codex-server.ts` same for Codex. `grok-edge.ts` Grok bridge. `dashboard-server.ts` :8799.
- `shared/types.ts` broker API types. `cli.ts` inspects broker state: `bun cli.ts status|peers|send <id> <msg>`; access management opens the DB directly: `bun cli.ts --db users|channels|ips|passwd|grant|reissue|revoke`.
- `broker-access.ts` users, channels, per-(user, channel) peer tokens, admin passwords/sessions and `/admin/*` routes. Peer tokens never unlock `/admin/*`. Channel scoping in `broker.ts` lives in `authenticate`, `foreignPeer` and `FOREIGN_PEER_RESPONSES`.
- `broker-net.ts` IP/CIDR parsing and the direct/external/refused decision (edge secret + `CLAUDE_PEERS_DIRECT_CIDRS`); per-user external allowlists live in `broker-access.ts`, the gate at the top of `broker.ts`'s fetch.

Canonical remote: `git@github.com:hinescreative/claude-peers-mcp.git` main. The louislva fork is not ours.

Operator fleet values live in the operator's private deploy notes, never in this repo. The pre-commit scanner refuses them. See the operator's private repo.

- Use Bun: `bun test`, `bunx tsc --noEmit -p .`, `bun install`, `bun:sqlite`. No node, npm, vite, express.
- Restarting the live broker drops every peer for about a minute. Do it once, deliberately, after the code is verified.
- Test harness must scrub `CLAUDE_CODE_MESSAGING_SOCKET` or fixtures land in a live session.
- Never commit or print `CLAUDE_PEERS_TOKEN`, `GROK_MCP_TOKEN`, or anything from `~/.fleet-secrets/`.
- Contract: `docs/peers-broker-CONTRACT.md`.
