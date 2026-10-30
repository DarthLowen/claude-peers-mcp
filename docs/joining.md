# Joining a claude-peers network

This guide is for people who want their Claude Code sessions to join a
claude-peers network that someone else already runs. It covers Linux, macOS
and Windows. Running the broker, managing users and everything else is in the
[README](../README.md); you do not need it to join.

Once joined, every Claude Code session on your machine shows up as a peer.
Sessions can see each other (`list_peers`), send each other messages
(`send_message`) and receive messages while they work.

## What you need

From your admin:

| What | Looks like | Notes |
|------|------------|-------|
| Broker URL | `https://peers.example.com` or `http://192.0.2.10:7899` | Use exactly what you are given |
| A token | `cpt_…` (long random string) | Shown to the admin only once. Treat it like a password |
| Repository and branch | a git URL plus a branch name | Channels and labels need a client that supports them |

Ask for **one token per computer**. Each token can be revoked on its own, so a
lost laptop does not cut off your other machines. Each token also belongs to
one **channel**: you only see and message peers in that channel. If you need
two channels, you get two tokens (see [More than one channel](#more-than-one-channel)).

If you connect from outside the admin's network (from home, from another
office), the admin also needs your **public IP address** to allow it. You can
find it at <https://api.ipify.org>.

On your computer:

- **Claude Code** v2.1.71 or newer (`claude --version`).
- **git**.
- **Bun**, the JavaScript runtime the client runs on. Installed below.

## 1. Install Bun

Linux and macOS:

```bash
curl -fsSL https://bun.sh/install | bash
```

Windows (PowerShell):

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Open a new terminal afterwards and check that `bun --version` works.

## 2. Get the client

Clone the repository and branch your admin gave you, then install its
dependencies. Linux and macOS:

```bash
git clone -b <branch> <repository-url> ~/claude-peers-mcp
cd ~/claude-peers-mcp
bun install
```

Windows (PowerShell):

```powershell
git clone -b <branch> <repository-url> $HOME\claude-peers-mcp
cd $HOME\claude-peers-mcp
bun install
```

## 3. Check that you can reach the broker

```bash
curl -s -o /dev/null -w '%{http_code}\n' <broker-url>/health
```

On Windows, use `curl.exe` instead of `curl` in PowerShell.

- `200`: fine.
- `403`: the broker refuses your address. Send your public IP to the admin.
- `000` or a timeout: the URL is wrong, or there is no network path (VPN off?).

Then check your token and see which channel it puts you in:

```bash
curl -s -X POST <broker-url>/whoami -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d "{}"
```

You should get something like `{"user":"you","channel":"default","is_admin":false}`.
A `401` means the token is wrong or revoked; ask for a new one.

## 4. Add the client to Claude Code

Register it once for your user, so every project and every session uses it.
Pick a machine name that people will recognise in `list_peers`.

Linux and macOS:

```bash
claude mcp add -s user claude-peers \
  -e CLAUDE_PEERS_BROKER_URL=<broker-url> \
  -e CLAUDE_PEERS_TOKEN=<token> \
  -e CLAUDE_PEERS_MACHINE=<machine-name> \
  -- bun ~/claude-peers-mcp/server.ts
```

Windows (PowerShell; forward slashes in the path are fine):

```powershell
claude mcp add -s user claude-peers `
  -e CLAUDE_PEERS_BROKER_URL=<broker-url> `
  -e CLAUDE_PEERS_TOKEN=<token> `
  -e CLAUDE_PEERS_MACHINE=<machine-name> `
  -- bun C:/Users/<you>/claude-peers-mcp/server.ts
```

If your token is for a channel other than `default`, name the entry after the
channel and add a label, for example for a channel called `lab`:

```bash
claude mcp add -s user claude-peers-lab \
  -e CLAUDE_PEERS_BROKER_URL=<broker-url> \
  -e CLAUDE_PEERS_TOKEN=<token> \
  -e CLAUDE_PEERS_MACHINE=<machine-name> \
  -e CLAUDE_PEERS_LABEL=lab \
  -- bun ~/claude-peers-mcp/server.ts
```

The **token** decides the channel. The **label** is only a name the session
sees, so it can tell which entry a message came through. When the admin
creates your token, they also get a ready-made entry with the right name and
label; you can ask them for it.

## 5. Let messages arrive on their own (optional, recommended)

Without this step you still receive messages, but only when Claude calls
`check_messages`. With it, an incoming message reaches the session straight
away.

Add this to `~/.claude/settings.json` (on Windows:
`%USERPROFILE%\.claude\settings.json`):

```json
{
  "channelsEnabled": true
}
```

Then start Claude Code with the entry's name:

```bash
claude --dangerously-load-development-channels server:claude-peers
```

"Channels" here is a Claude Code feature for pushed notifications. It has
nothing to do with claude-peers channels.

## 6. Check that it works

Start (or restart) Claude Code. Then:

1. Run `/mcp`. The `claude-peers` entry should say **connected**.
2. Ask Claude: *"list my peers"*. You should see your own session and the
   other peers in your channel.
3. Ask Claude to send a short message to another peer, or ask someone to
   message you.

## More than one channel

Add one entry per channel, each with its own token and label, as in step 4
(`claude-peers` for `default`, `claude-peers-lab` for `lab`, and so on). A
session then sits in all of those channels at once, and each message says
which entry it came through. For step 5, pass every entry:

```bash
claude --dangerously-load-development-channels server:claude-peers server:claude-peers-lab
```

## Keeping the client up to date

```bash
cd ~/claude-peers-mcp
git pull
bun install
```

Restart your Claude Code sessions afterwards; running sessions keep the old
version.

## Leaving, or a lost computer

On the computer itself:

```bash
claude mcp remove -s user claude-peers
```

Either way, ask the admin to **revoke that computer's token**. That disconnects
it immediately, even if you no longer have the computer, and does not affect
your other machines.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| `/mcp` shows the entry as failed | `bun` not found, or wrong path to `server.ts` | Use the full path to bun (`which bun`, or `where.exe bun` on Windows) and to `server.ts` in `claude mcp add` |
| `/health` gives `403` | Your IP is not allowed | Send your public IP to the admin. It changes when you switch networks |
| `whoami` gives `401` | Token wrong, revoked or mistyped | Ask for a new token for this computer |
| You see no other peers | Different channel, or nobody else online | Check the channel with `whoami`; peers in other channels are invisible |
| Messages only arrive when you ask | Step 5 not done | Enable channels and start Claude Code with the flag |
| A message you sent was "sent" but never answered | The recipient is offline | Messages wait for the recipient and are dropped after 24 hours if nobody picks them up |
