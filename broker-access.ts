/**
 * Users, channels and per-(user, channel) access tokens for the broker.
 *
 * Every authenticated request resolves to an AccessContext: one user and one
 * channel. Peers and messages carry the channel they were created in, and the
 * broker only lets a request see or touch rows in its own channel.
 *
 * Tokens are stored as SHA-256 digests only. Legacy CLAUDE_PEERS_TOKEN(S)
 * values never touch this table; the broker maps them to the bootstrap admin
 * user in the default channel.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_CHANNEL = "default";
const LAST_USED_WRITE_MS = 60_000;

export interface AccessContext {
  user_id: number;
  user: string;
  channel: string;
  is_admin: boolean;
  // null for legacy env/file tokens and legacy open mode.
  token_id: number | null;
}

export class AccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface UserRow {
  id: number;
  name: string;
  is_admin: number;
  disabled: number;
  created_at: string;
}

interface ChannelRow {
  id: number;
  name: string;
  created_at: string;
}

interface Hooks {
  // Drops one peer, its lease, and its undelivered mail (broker's own helper).
  dropPeer(id: string): void;
  // Prunes stale peers before an admin listing.
  cleanStalePeers(): void;
}

function normalizeName(value: unknown, what: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(name)) {
    throw new AccessError(400, `${what} name must be 1-48 chars of letters, digits, '.', '_' or '-'`);
  }
  return name;
}

export function createAccess(db: Database, bootstrapUserName: string, hooks: Hooks) {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL,
      token_hash BLOB NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    )
  `);
  // Exactly one live token per (user, channel); revoked rows stay for audit.
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_live_grant ON tokens(user_id, channel_id) WHERE revoked_at IS NULL");

  // In-place migration: pre-channel rows land in the default channel.
  const addColumns = (table: string, columns: Record<string, string>) => {
    const existing = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.has(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  addColumns("peers", { channel: `TEXT NOT NULL DEFAULT '${DEFAULT_CHANNEL}'`, user_id: "INTEGER", token_id: "INTEGER" });
  addColumns("messages", { channel: `TEXT NOT NULL DEFAULT '${DEFAULT_CHANNEL}'` });

  const now = () => new Date().toISOString();
  db.run("INSERT OR IGNORE INTO channels (name, created_at) VALUES (?, ?)", [DEFAULT_CHANNEL, now()]);
  const bootstrapName = normalizeName(bootstrapUserName, "bootstrap user");
  db.run("INSERT OR IGNORE INTO users (name, is_admin, created_at) VALUES (?, 1, ?)", [bootstrapName, now()]);
  // The bootstrap admin backs legacy tokens, so it is always an enabled admin.
  db.run("UPDATE users SET is_admin = 1, disabled = 0 WHERE name = ?", [bootstrapName]);
  const bootstrapUser = db.query("SELECT * FROM users WHERE name = ?").get(bootstrapName) as UserRow;

  const selectLiveTokens = db.prepare(`
    SELECT t.id, t.token_hash, t.last_used_at, u.id AS user_id, u.name AS user, u.is_admin, c.name AS channel
    FROM tokens t
    JOIN users u ON u.id = t.user_id
    JOIN channels c ON c.id = t.channel_id
    WHERE t.revoked_at IS NULL AND u.disabled = 0
  `);
  const countLiveTokens = db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NULL");
  const touchToken = db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?");
  const lastUsedWrites = new Map<number, number>();

  const bootstrapContext = (): AccessContext => ({
    user_id: bootstrapUser.id,
    user: bootstrapUser.name,
    channel: DEFAULT_CHANNEL,
    is_admin: true,
    token_id: null,
  });

  // Compares the candidate against every live token digest, like the legacy
  // multi-token check, so timing does not depend on which row matches.
  function resolveToken(candidate: Buffer): AccessContext | null {
    const rows = selectLiveTokens.all() as {
      id: number; token_hash: Uint8Array; user_id: number; user: string; is_admin: number; channel: string;
    }[];
    let match: (typeof rows)[number] | null = null;
    for (const row of rows) {
      if (timingSafeEqual(candidate, row.token_hash)) match = row;
    }
    if (!match) return null;
    const nowMs = Date.now();
    if (nowMs - (lastUsedWrites.get(match.id) ?? 0) > LAST_USED_WRITE_MS) {
      lastUsedWrites.set(match.id, nowMs);
      touchToken.run(new Date(nowMs).toISOString(), match.id);
    }
    return {
      user_id: match.user_id,
      user: match.user,
      channel: match.channel,
      is_admin: Boolean(match.is_admin),
      token_id: match.id,
    };
  }

  // --- Admin helpers ---

  const getUser = (value: unknown): UserRow => {
    const user = db.query("SELECT * FROM users WHERE name = ?").get(normalizeName(value, "user")) as UserRow | null;
    if (!user) throw new AccessError(404, "user not found");
    return user;
  };
  const getChannel = (value: unknown): ChannelRow => {
    const channel = db.query("SELECT * FROM channels WHERE name = ?").get(normalizeName(value, "channel")) as ChannelRow | null;
    if (!channel) throw new AccessError(404, "channel not found");
    return channel;
  };
  const dropPeersWhere = (where: string, params: (string | number)[]): number => {
    const ids = db.query(`SELECT id FROM peers WHERE ${where}`).all(...params) as { id: string }[];
    for (const { id } of ids) hooks.dropPeer(id);
    return ids.length;
  };
  const revokeLive = (userId: number, channelId: number): number => {
    const live = db.query("SELECT id FROM tokens WHERE user_id = ? AND channel_id = ? AND revoked_at IS NULL")
      .all(userId, channelId) as { id: number }[];
    for (const { id } of live) {
      db.run("UPDATE tokens SET revoked_at = ? WHERE id = ?", [now(), id]);
      dropPeersWhere("token_id = ?", [id]);
    }
    return live.length;
  };
  const mint = (user: UserRow, channel: ChannelRow) => {
    const token = `cpt_${randomBytes(32).toString("base64url")}`;
    const createdAt = now();
    db.run(
      "INSERT INTO tokens (user_id, channel_id, token_hash, created_at) VALUES (?, ?, ?, ?)",
      [user.id, channel.id, createHash("sha256").update(token).digest(), createdAt],
    );
    // The only time the raw token exists outside the client.
    return { user: user.name, channel: channel.name, token, created_at: createdAt };
  };
  const publicUser = (user: UserRow) => ({
    name: user.name,
    is_admin: Boolean(user.is_admin),
    disabled: Boolean(user.disabled),
    bootstrap: user.id === bootstrapUser.id,
    created_at: user.created_at,
  });
  const guardBootstrap = (user: UserRow, what: string) => {
    if (user.id === bootstrapUser.id) throw new AccessError(400, `cannot ${what} the bootstrap admin (it backs legacy tokens)`);
  };

  type Body = Record<string, unknown>;
  const routes: Record<string, (body: Body) => unknown> = {
    "list-users": () => (db.query("SELECT * FROM users ORDER BY name").all() as UserRow[]).map(publicUser),
    "create-user": (body) => {
      const name = normalizeName(body.name, "user");
      if (db.query("SELECT 1 FROM users WHERE name = ?").get(name)) throw new AccessError(409, "user already exists");
      db.run("INSERT INTO users (name, is_admin, created_at) VALUES (?, ?, ?)", [name, body.is_admin ? 1 : 0, now()]);
      return publicUser(getUser(name));
    },
    "update-user": (body) => {
      const user = getUser(body.name);
      if (body.is_admin !== undefined) {
        if (!body.is_admin) guardBootstrap(user, "demote");
        db.run("UPDATE users SET is_admin = ? WHERE id = ?", [body.is_admin ? 1 : 0, user.id]);
      }
      if (body.disabled !== undefined) {
        if (body.disabled) {
          guardBootstrap(user, "disable");
          dropPeersWhere("user_id = ?", [user.id]);
        }
        db.run("UPDATE users SET disabled = ? WHERE id = ?", [body.disabled ? 1 : 0, user.id]);
      }
      return publicUser(getUser(user.name));
    },
    "delete-user": (body) => {
      const user = getUser(body.name);
      guardBootstrap(user, "delete");
      const peers = dropPeersWhere("user_id = ?", [user.id]);
      db.run("DELETE FROM tokens WHERE user_id = ?", [user.id]);
      db.run("DELETE FROM users WHERE id = ?", [user.id]);
      return { ok: true, peers_removed: peers };
    },
    "list-channels": () => db.query(`
      SELECT c.name, c.created_at,
        (SELECT COUNT(*) FROM peers p WHERE p.channel = c.name) AS peers,
        (SELECT COUNT(*) FROM tokens t WHERE t.channel_id = c.id AND t.revoked_at IS NULL) AS tokens
      FROM channels c ORDER BY c.name
    `).all(),
    "create-channel": (body) => {
      const name = normalizeName(body.name, "channel");
      if (db.query("SELECT 1 FROM channels WHERE name = ?").get(name)) throw new AccessError(409, "channel already exists");
      db.run("INSERT INTO channels (name, created_at) VALUES (?, ?)", [name, now()]);
      return getChannel(name);
    },
    "delete-channel": (body) => {
      const channel = getChannel(body.name);
      if (channel.name === DEFAULT_CHANNEL) throw new AccessError(400, "cannot delete the default channel");
      const peers = dropPeersWhere("channel = ?", [channel.name]);
      db.run("DELETE FROM tokens WHERE channel_id = ?", [channel.id]);
      db.run("DELETE FROM messages WHERE channel = ?", [channel.name]);
      db.run("DELETE FROM channels WHERE id = ?", [channel.id]);
      return { ok: true, peers_removed: peers };
    },
    // Metadata only: never the token or its digest.
    "list-tokens": (body) => {
      const where = ["1 = 1"];
      const params: string[] = [];
      if (body.user !== undefined) { where.push("u.name = ?"); params.push(normalizeName(body.user, "user")); }
      if (body.channel !== undefined) { where.push("c.name = ?"); params.push(normalizeName(body.channel, "channel")); }
      if (!body.include_revoked) where.push("t.revoked_at IS NULL");
      return db.query(`
        SELECT u.name AS user, c.name AS channel, t.created_at, t.last_used_at, t.revoked_at
        FROM tokens t JOIN users u ON u.id = t.user_id JOIN channels c ON c.id = t.channel_id
        WHERE ${where.join(" AND ")} ORDER BY u.name, c.name, t.created_at
      `).all(...params);
    },
    grant: db.transaction((body: Body) => {
      const user = getUser(body.user);
      const channel = getChannel(body.channel);
      if (db.query("SELECT 1 FROM tokens WHERE user_id = ? AND channel_id = ? AND revoked_at IS NULL").get(user.id, channel.id)) {
        throw new AccessError(409, "user already has a token for this channel; reissue it instead");
      }
      return mint(user, channel);
    }),
    revoke: db.transaction((body: Body) => {
      const user = getUser(body.user);
      const channel = getChannel(body.channel);
      if (!revokeLive(user.id, channel.id)) throw new AccessError(404, "no live token for this user and channel");
      return { ok: true };
    }),
    reissue: db.transaction((body: Body) => {
      const user = getUser(body.user);
      const channel = getChannel(body.channel);
      revokeLive(user.id, channel.id);
      return mint(user, channel);
    }),
    "list-peers": (body) => {
      hooks.cleanStalePeers();
      const where = ["1 = 1"];
      const params: string[] = [];
      if (body.user !== undefined) { where.push("u.name = ?"); params.push(normalizeName(body.user, "user")); }
      if (body.channel !== undefined) { where.push("p.channel = ?"); params.push(normalizeName(body.channel, "channel")); }
      return db.query(`
        SELECT p.id, p.nickname, p.machine, p.cwd, p.tty, p.pid, p.summary, p.last_seen, p.channel, u.name AS user
        FROM peers p LEFT JOIN users u ON u.id = p.user_id
        WHERE ${where.join(" AND ")} ORDER BY p.channel, p.id
      `).all(...params);
    },
  };

  function handleAdmin(route: string, body: Body, ctx: AccessContext): unknown {
    if (!ctx.is_admin) throw new AccessError(403, "forbidden");
    const handler = Object.hasOwn(routes, route) ? routes[route] : undefined;
    if (!handler) throw new AccessError(404, "not found");
    return handler(body ?? {});
  }

  return {
    bootstrapContext,
    resolveToken,
    handleAdmin,
    liveTokenCount: () => (countLiveTokens.get() as { n: number }).n,
  };
}
