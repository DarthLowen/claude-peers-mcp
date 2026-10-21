#!/usr/bin/env bun
/**
 * claude-peers CLI (federated)
 *
 * Utility commands for managing the broker and inspecting peers.
 * Supports remote brokers via CLAUDE_PEERS_BROKER_URL.
 *
 * Usage:
 *   bun cli.ts status          — Show broker status and all peers
 *   bun cli.ts peers           — List all peers
 *   bun cli.ts send <id> <msg> — Send a message to a peer
 *   bun cli.ts kill-broker     — Stop the broker daemon (local only)
 *   bun cli.ts users|channels|grant|reissue|revoke — Manage access (admin token)
 */

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = process.env.CLAUDE_PEERS_BROKER_URL ?? `http://127.0.0.1:${BROKER_PORT}`;
const AUTH_TOKEN = process.env.CLAUDE_PEERS_TOKEN ?? "";

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }
  return headers;
}

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// Ready-to-paste ~/.claude.json entry for a freshly minted channel token.
function mcpServersBlock(channel: string, token: string): string {
  const name = channel === "default" ? "claude-peers" : `claude-peers-${channel}`;
  const env: Record<string, string> = {
    CLAUDE_PEERS_BROKER_URL: process.env.CLAUDE_PEERS_PUBLIC_BROKER_URL || BROKER_URL,
    CLAUDE_PEERS_TOKEN: token,
    CLAUDE_PEERS_MACHINE: "<this-machine-name>",
  };
  if (channel !== "default") env.CLAUDE_PEERS_LABEL = channel;
  return JSON.stringify({
    mcpServers: { [name]: { type: "stdio", command: "bun", args: ["/path/to/claude-peers-mcp/server.ts"], env } },
  }, null, 2);
}

async function admin<T>(route: string, body: Record<string, unknown> = {}): Promise<T> {
  try {
    return await brokerFetch<T>(`/admin/${route}`, body);
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

type Grant = { user: string; channel: string; token: string; created_at: string };

function printGrant(grant: Grant) {
  console.log(`Token for ${grant.user} in ${grant.channel} (shown once):\n${grant.token}\n`);
  console.log(mcpServersBlock(grant.channel, grant.token));
}

const cmd = process.argv[2];
const [arg1, arg2] = process.argv.slice(3);

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);

      if (health.peers > 0) {
        const peers = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            cwd: string;
            git_root: string | null;
            tty: string | null;
            machine: string;
            summary: string;
            last_seen: string;
          }>
        >("/list-peers", {
          scope: "fleet",
          cwd: "/",
          git_root: null,
        });

        console.log("\nPeers:");
        for (const p of peers) {
          console.log(`  ${p.id}  [${p.machine}]  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log(`Broker at ${BROKER_URL} is not reachable.`);
    }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          cwd: string;
          git_root: string | null;
          tty: string | null;
          machine: string;
          summary: string;
          last_seen: string;
        }>
      >("/list-peers", {
        scope: "fleet",
        cwd: "/",
        git_root: null,
      });

      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          const parts = [`${p.id}  [${p.machine}]  PID:${p.pid}  ${p.cwd}`];
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          console.log(parts.join("\n"));
        }
      }
    } catch {
      console.log(`Broker at ${BROKER_URL} is not reachable.`);
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "kill-broker": {
    const isLocal = BROKER_URL.includes("127.0.0.1") || BROKER_URL.includes("localhost");
    if (!isLocal) {
      console.error(`Cannot kill a remote broker (${BROKER_URL}). SSH into the broker host to stop it.`);
      process.exit(1);
    }
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "whoami": {
    console.log(JSON.stringify(await brokerFetch("/whoami", {}), null, 2));
    break;
  }

  case "users": {
    if (arg1 === "add" && arg2) {
      await admin("create-user", { name: arg2, is_admin: process.argv.includes("--admin") });
      console.log(`Added user ${arg2}`);
    } else if (arg1 === "rm" && arg2) {
      const result = await admin<{ peers_removed: number }>("delete-user", { name: arg2 });
      console.log(`Removed user ${arg2} (${result.peers_removed} peer(s) dropped)`);
    } else if (arg1 === "admin" && arg2) {
      const on = process.argv[5] !== "off";
      await admin("update-user", { name: arg2, is_admin: on });
      console.log(`${arg2} is ${on ? "now" : "no longer"} an admin`);
    } else if (!arg1) {
      const users = await admin<Array<{ name: string; is_admin: boolean; disabled: boolean; bootstrap: boolean }>>("list-users");
      const tokens = await admin<Array<{ user: string; channel: string; created_at: string; last_used_at: string | null }>>("list-tokens");
      for (const u of users) {
        const flags = [u.is_admin && "admin", u.disabled && "disabled", u.bootstrap && "bootstrap"].filter(Boolean).join(", ");
        console.log(`${u.name}${flags ? `  (${flags})` : ""}`);
        for (const t of tokens.filter((t) => t.user === u.name)) {
          console.log(`    ${t.channel}  created ${t.created_at}  last used ${t.last_used_at ?? "never"}`);
        }
      }
    } else {
      console.error("Usage: bun cli.ts users [add <name> [--admin] | rm <name> | admin <name> [on|off]]");
      process.exit(1);
    }
    break;
  }

  case "channels": {
    if (arg1 === "add" && arg2) {
      await admin("create-channel", { name: arg2 });
      console.log(`Added channel ${arg2}`);
    } else if (arg1 === "rm" && arg2) {
      const result = await admin<{ peers_removed: number }>("delete-channel", { name: arg2 });
      console.log(`Removed channel ${arg2} (${result.peers_removed} peer(s) dropped)`);
    } else if (!arg1) {
      const channels = await admin<Array<{ name: string; peers: number; tokens: number }>>("list-channels");
      for (const c of channels) console.log(`${c.name}  ${c.peers} peer(s)  ${c.tokens} token(s)`);
    } else {
      console.error("Usage: bun cli.ts channels [add <name> | rm <name>]");
      process.exit(1);
    }
    break;
  }

  case "grant":
  case "reissue":
  case "revoke": {
    if (!arg1 || !arg2) {
      console.error(`Usage: bun cli.ts ${cmd} <user> <channel>`);
      process.exit(1);
    }
    if (cmd === "revoke") {
      await admin("revoke", { user: arg1, channel: arg2 });
      console.log(`Revoked ${arg1}'s token for ${arg2}`);
    } else {
      printGrant(await admin<Grant>(cmd, { user: arg1, channel: arg2 }));
    }
    break;
  }

  default:
    console.log(`claude-peers CLI (federated)

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers (across fleet)
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts kill-broker     Stop the broker daemon (local only)
  bun cli.ts whoami          Show the user and channel of CLAUDE_PEERS_TOKEN

Access management (CLAUDE_PEERS_TOKEN must belong to an admin):
  bun cli.ts users                       List users and their channel grants
  bun cli.ts users add <name> [--admin]  Add a user
  bun cli.ts users rm <name>             Remove a user, its tokens and peers
  bun cli.ts users admin <name> [on|off] Set or clear the admin flag
  bun cli.ts channels [add|rm <name>]    List, add or remove channels
  bun cli.ts grant <user> <channel>      Mint a token (printed once)
  bun cli.ts reissue <user> <channel>    Revoke and mint in one step
  bun cli.ts revoke <user> <channel>     Revoke a token

Environment:
  CLAUDE_PEERS_BROKER_URL         Broker URL (default: http://127.0.0.1:7899)
  CLAUDE_PEERS_TOKEN              Auth token for broker
  CLAUDE_PEERS_PUBLIC_BROKER_URL  Broker URL written into generated client config`);
}
