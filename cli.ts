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
 *   bun cli.ts --db[=path] users|channels|grant|reissue|revoke|passwd
 *                              — Manage access by opening the broker DB directly
 *
 * Access management never goes over HTTP: peer tokens cannot reach admin
 * routes, so these commands open CLAUDE_PEERS_DB (or --db=path) on the broker
 * host, e.g. `docker exec -it claude-peers-broker bun cli.ts --db passwd nic`.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { createAccess } from "./broker-access.ts";

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
    signal: AbortSignal.timeout(path === "/send-message" ? 10_000 : 3000),
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

const cliArgs = process.argv.slice(2);
const dbFlag = cliArgs.find((a) => a === "--db" || a.startsWith("--db="));
const positional = cliArgs.filter((a) => !a.startsWith("--"));
const [cmd, arg1, arg2, arg3] = positional;

let directAccess: ReturnType<typeof createAccess> | null = null;

// Direct-DB mode: the same admin routes the broker serves, minus the session.
function openAccess(): ReturnType<typeof createAccess> {
  if (directAccess) return directAccess;
  if (!dbFlag) {
    console.error("Access management needs --db (run on the broker host; reads CLAUDE_PEERS_DB or --db=path).");
    process.exit(1);
  }
  const path = dbFlag.startsWith("--db=") ? dbFlag.slice(5) : process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
  if (!existsSync(path)) {
    console.error(`No broker database at ${path}; start the broker once first.`);
    process.exit(1);
  }
  const db = new Database(path);
  db.run("PRAGMA busy_timeout = 3000");
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'peers'").get()) {
    console.error(`${path} is not a claude-peers broker database.`);
    process.exit(1);
  }
  try {
    // No legacyUser: the broker recorded which row backs legacy tokens.
    directAccess = createAccess(db, {});
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  return directAccess;
}

// Reads a password with no echo from a TTY, or the first line of piped stdin.
async function readPassword(prompt: string): Promise<string> {
  if (cliArgs.includes("--stdin") || !process.stdin.isTTY) {
    const text = await new Response(Bun.stdin.stream()).text();
    return text.split(/\r?\n/)[0] ?? "";
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = [...value].slice(0, -1).join("");
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

async function admin<T>(route: string, body: Record<string, unknown> = {}): Promise<T> {
  try {
    return (await openAccess().runAdmin(route, body)) as T;
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

type Grant = { user: string; channel: string; label: string; token: string; created_at: string };

function printGrant(grant: Grant) {
  console.log(`Token for ${grant.user} in ${grant.channel}${grant.label ? ` ("${grant.label}")` : ""} (shown once):\n${grant.token}\n`);
  console.log(mcpServersBlock(grant.channel, grant.token));
}

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
      const result = await brokerFetch<{ ok: boolean; error?: string; message_id?: number; wake?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        const wake = result.wake ? `\nwake: ${result.wake}` : "";
        console.log(`Message sent to ${toId}.${wake}`);
        if (result.wake === "no-route" || result.wake === "failed") process.exitCode = 1;
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
      await admin("create-user", { name: arg2, is_admin: cliArgs.includes("--admin") });
      console.log(`Added user ${arg2}`);
    } else if (arg1 === "rm" && arg2) {
      const result = await admin<{ peers_removed: number }>("delete-user", { name: arg2 });
      console.log(`Removed user ${arg2} (${result.peers_removed} peer(s) dropped)`);
    } else if (arg1 === "admin" && arg2) {
      const on = arg3 !== "off";
      await admin("update-user", { name: arg2, is_admin: on });
      console.log(`${arg2} is ${on ? "now" : "no longer"} an admin`);
    } else if ((arg1 === "disable" || arg1 === "enable") && arg2) {
      await admin("update-user", { name: arg2, disabled: arg1 === "disable" });
      console.log(`${arg2} is ${arg1}d`);
    } else if (!arg1) {
      const users = await admin<Array<{ name: string; is_admin: boolean; disabled: boolean; has_password: boolean; legacy: boolean }>>("list-users");
      const tokens = await admin<Array<{ user: string; channel: string; created_at: string; last_used_at: string | null }>>("list-tokens");
      for (const u of users) {
        const flags = [u.is_admin && "admin", u.has_password && "password", u.disabled && "disabled", u.legacy && "legacy tokens"].filter(Boolean).join(", ");
        console.log(`${u.name}${flags ? `  (${flags})` : ""}`);
        for (const t of tokens.filter((t) => t.user === u.name)) {
          console.log(`    ${t.channel}  created ${t.created_at}  last used ${t.last_used_at ?? "never"}`);
        }
      }
    } else {
      console.error("Usage: bun cli.ts --db users [add <name> [--admin] | rm <name> | admin <name> [on|off] | disable|enable <name>]");
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
      console.error("Usage: bun cli.ts --db channels [add <name> | rm <name>]");
      process.exit(1);
    }
    break;
  }

  case "ips": {
    if (!arg1 || (arg2 && !["add", "rm"].includes(arg2)) || (arg2 && !arg3)) {
      console.error("Usage: bun cli.ts --db ips <user> [add <cidr> [note...] | rm <cidr>]");
      process.exit(1);
    }
    if (arg2 === "add") {
      const added = await admin<{ cidr: string }>("add-cidr", { user: arg1, cidr: arg3, note: positional.slice(4).join(" ") });
      console.log(`Allowed ${added.cidr} for ${arg1}`);
    } else if (arg2 === "rm") {
      await admin("remove-cidr", { user: arg1, cidr: arg3 });
      console.log(`Removed ${arg3} for ${arg1}`);
    } else {
      const cidrs = await admin<Array<{ cidr: string; note: string }>>("list-cidrs", { user: arg1 });
      if (!cidrs.length) console.log(`${arg1}: external access: none`);
      for (const c of cidrs) console.log(`${c.cidr}  ${c.note}`.trimEnd());
    }
    break;
  }

  case "passwd": {
    if (!arg1) {
      console.error("Usage: bun cli.ts --db passwd <user> [--stdin | --clear]");
      process.exit(1);
    }
    openAccess();
    if (cliArgs.includes("--clear")) {
      await admin("clear-password", { name: arg1 });
      console.log(`Cleared ${arg1}'s password`);
      break;
    }
    const password = await readPassword(`New password for ${arg1}: `);
    if (process.stdin.isTTY && !cliArgs.includes("--stdin") && password !== await readPassword("Repeat password: ")) {
      console.error("Passwords do not match.");
      process.exit(1);
    }
    await admin("set-password", { name: arg1, password });
    console.log(`Set ${arg1}'s password (existing sessions ended)`);
    break;
  }

  case "grant":
  case "reissue":
  case "revoke": {
    if (!arg1 || !arg2) {
      console.error(`Usage: bun cli.ts --db ${cmd} <user> <channel> [label]`);
      process.exit(1);
    }
    const label = arg3;
    if (cmd === "revoke") {
      await admin("revoke", { user: arg1, channel: arg2, label });
      console.log(`Revoked ${arg1}'s ${label ? `"${label}" token` : "tokens"} for ${arg2}`);
    } else {
      printGrant(await admin<Grant>(cmd, { user: arg1, channel: arg2, label }));
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

Access management opens the broker DB directly (run on the broker host,
e.g. docker exec -it claude-peers-broker bun cli.ts --db ...):
  bun cli.ts --db users                        List users and their channel grants
  bun cli.ts --db users add <name> [--admin]   Add a user
  bun cli.ts --db users rm <name>              Remove a user, its tokens and peers
  bun cli.ts --db users admin <name> [on|off]  Set or clear the admin flag
  bun cli.ts --db users disable|enable <name>  Block or unblock a user's tokens
  bun cli.ts --db passwd <user> [--stdin]      Set a password (admins log in with it)
  bun cli.ts --db passwd <user> --clear        Remove a password
  bun cli.ts --db channels [add|rm <name>]     List, add or remove channels
  bun cli.ts --db ips <user> [add <cidr> [note] | rm <cidr>]
                                               External (edge) allowlist; empty = none
  bun cli.ts --db grant <user> <channel> [label]    Mint a token (printed once); one per label, e.g. per device
  bun cli.ts --db reissue <user> <channel> [label]  Revoke and mint in one step
  bun cli.ts --db revoke <user> <channel> [label]   Revoke that label's token, or all of them without one
  --db uses CLAUDE_PEERS_DB (default ~/.claude-peers.db); --db=<path> overrides.

Environment:
  CLAUDE_PEERS_BROKER_URL         Broker URL (default: http://127.0.0.1:7899)
  CLAUDE_PEERS_TOKEN              Auth token for broker
  CLAUDE_PEERS_PUBLIC_BROKER_URL  Broker URL written into generated client config`);
}
