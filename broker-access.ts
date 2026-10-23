/**
 * Users, channels, per-(user, channel) peer tokens and admin sessions.
 *
 * Every peer request resolves to an AccessContext: one user and one channel.
 * Peers and messages carry the channel they were created in, and the broker
 * only lets a request see or touch rows in its own channel.
 *
 * Peer tokens never grant admin rights. /admin/* only accepts a session from
 * POST /admin/login, which needs an enabled admin user with a password.
 *
 * Tokens and session ids are stored as SHA-256 digests only; passwords as
 * argon2id hashes. Legacy CLAUDE_PEERS_TOKEN(S) values never touch the DB; the
 * broker maps them to the non-admin legacy user in the default channel.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { anyContains, parseCidr, parseIp, type Cidr } from "./broker-net.ts";

export const DEFAULT_CHANNEL = "default";
const LAST_USED_WRITE_MS = 60_000;
const MAX_LOGIN_BACKOFF_MS = 60_000;
const MAX_SOFT_DELAY_MS = 500;
const MAX_FAILURE_ENTRIES = 10_000;
const MAX_IN_FLIGHT_PER_ADDRESS = 4;
const MAX_REJECTIONS = 200;
const REJECTION_DEDUPE_MS = 5_000;
const FAILURE_MEMORY_MS = 15 * 60_000;
const MIN_PASSWORD_LENGTH = 10;

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
  password_hash: string | null;
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

export interface AccessOptions {
  // Backs legacy env/file tokens and open mode. Never an admin. The broker
  // passes it and records the user's id in meta; the direct-DB CLI omits it
  // and reads that id back, so both always protect the same row.
  legacyUser?: string;
  // First-run bootstrap: with adminPassword set, this admin is created if missing.
  adminUser?: string;
  adminPassword?: string;
  sessionTtlMs?: number;
  // Seeded once into the legacy user's external allowlist (meta-guarded).
  legacySeedCidrs?: string[];
  loginBackoffMs?: number;
  // Defaults suit the direct-DB CLI; the broker passes its own helpers.
  hooks?: Partial<Hooks>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

function optionalFlag(value: unknown, what: string): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value;
  throw new AccessError(400, `${what} must be true or false`);
}

function normalizeName(value: unknown, what: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(name)) {
    throw new AccessError(400, `${what} name must be 1-48 chars of letters, digits, '.', '_' or '-'`);
  }
  return name;
}

export function createAccess(db: Database, options: AccessOptions) {
  const hooks: Hooks = {
    dropPeer: (id) => {
      db.run("DELETE FROM peer_leases WHERE peer_id = ?", [id]);
      db.run("DELETE FROM peers WHERE id = ?", [id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [id]);
    },
    cleanStalePeers: () => {},
    ...options.hooks,
  };
  const sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60_000;
  const loginBackoffMs = options.loginBackoffMs ?? 1000;
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
  db.run(`
    CREATE TABLE IF NOT EXISTS user_cidrs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cidr TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE (user_id, cidr)
    )
  `);
  // Recent external rejections for the admin page; never holds tokens.
  db.run(`
    CREATE TABLE IF NOT EXISTS net_rejections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      ip TEXT NOT NULL,
      user TEXT,
      route TEXT NOT NULL,
      reason TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_hash BLOB NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  // In-place migration: pre-channel rows land in the default channel.
  const addColumns = (table: string, columns: Record<string, string>) => {
    const existing = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.has(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  addColumns("peers", { channel: `TEXT NOT NULL DEFAULT '${DEFAULT_CHANNEL}'`, user_id: "INTEGER", token_id: "INTEGER" });
  addColumns("messages", { channel: `TEXT NOT NULL DEFAULT '${DEFAULT_CHANNEL}'` });
  addColumns("users", { password_hash: "TEXT" });
  // Retry dedupe is per channel, so a label in one channel cannot collide with another's.
  db.run("DROP INDEX IF EXISTS idx_messages_client_id");
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_channel_client_id ON messages(channel, from_id, client_message_id) WHERE client_message_id IS NOT NULL");

  // One-way switch: once any channel token has been minted, legacy open mode
  // is gone for good, even if every token is later revoked.
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  if (db.query("SELECT 1 FROM tokens LIMIT 1").get()) {
    db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('auth_enabled', '1')");
  }
  const selectAuthEnabled = db.prepare("SELECT 1 FROM meta WHERE key = 'auth_enabled'");
  let authEnabled = Boolean(selectAuthEnabled.get());

  const now = () => new Date().toISOString();
  const killSessions = (userId: number) => db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
  db.run("INSERT OR IGNORE INTO channels (name, created_at) VALUES (?, ?)", [DEFAULT_CHANNEL, now()]);

  // The legacy user backs shared env/file tokens: a plain peer identity that
  // can never become an admin or hold a password.
  let legacyUser: UserRow;
  if (options.legacyUser !== undefined) {
    const legacyName = normalizeName(options.legacyUser, "legacy user");
    db.run("INSERT OR IGNORE INTO users (name, created_at) VALUES (?, ?)", [legacyName, now()]);
    db.run("UPDATE users SET is_admin = 0, password_hash = NULL WHERE name = ?", [legacyName]);
    legacyUser = db.query("SELECT * FROM users WHERE name = ?").get(legacyName) as UserRow;
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_user_id', ?)", [String(legacyUser.id)]);
    killSessions(legacyUser.id);
    // One-time seed (e.g. the old edge allowlist) so shared-token peers keep
    // external access; later admin edits are never undone.
    const seeds = (options.legacySeedCidrs ?? []).map((entry) => {
      const cidr = parseCidr(entry);
      if (!cidr) throw new Error(`invalid legacy seed CIDR: ${entry}`);
      return cidr.text;
    });
    if (seeds.length && !db.query("SELECT 1 FROM meta WHERE key = 'legacy_cidrs_seeded'").get()) {
      for (const cidr of seeds) {
        db.run("INSERT OR IGNORE INTO user_cidrs (user_id, cidr, note, created_at) VALUES (?, ?, 'seeded from the previous edge allowlist', ?)", [legacyUser.id, cidr, now()]);
      }
      db.run("INSERT INTO meta (key, value) VALUES ('legacy_cidrs_seeded', ?)", [now()]);
    }
  } else {
    const meta = db.query("SELECT value FROM meta WHERE key = 'legacy_user_id'").get() as { value: string } | null;
    const row = meta ? db.query("SELECT * FROM users WHERE id = ?").get(Number(meta.value)) as UserRow | null : null;
    if (!row) throw new Error("the broker has not initialised this database yet; start it once first");
    legacyUser = row;
  }

  // First-run bootstrap only: once meta.admin_bootstrapped is set (or the
  // user already exists) nothing is touched, so a later disable, demote,
  // password clear or delete survives restarts.
  if (options.adminPassword) {
    const adminName = normalizeName(options.adminUser || "admin", "admin user");
    if (adminName === legacyUser.name) throw new Error("CLAUDE_PEERS_ADMIN_USER must differ from the legacy-token user");
    const bootstrapped = db.query("SELECT 1 FROM meta WHERE key = 'admin_bootstrapped'").get();
    if (bootstrapped || db.query("SELECT 1 FROM users WHERE name = ?").get(adminName)) {
      console.error(`[claude-peers broker] CLAUDE_PEERS_ADMIN_PASSWORD ignored: the first admin was already bootstrapped (first-run only; remove the variable).`);
    } else {
      db.run(
        "INSERT INTO users (name, is_admin, password_hash, created_at) VALUES (?, 1, ?, ?)",
        [adminName, Bun.password.hashSync(options.adminPassword, { algorithm: "argon2id" }), now()],
      );
    }
    db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('admin_bootstrapped', ?)", [now()]);
  }

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

  // Context for legacy env/file tokens and open mode; null while disabled.
  const legacyContext = (): AccessContext | null => {
    const row = db.query("SELECT disabled FROM users WHERE id = ?").get(legacyUser.id) as { disabled: number } | null;
    if (!row || row.disabled) return null;
    return { user_id: legacyUser.id, user: legacyUser.name, channel: DEFAULT_CHANNEL, is_admin: false, token_id: null };
  };

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
      [user.id, channel.id, sha256(token), createdAt],
    );
    db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('auth_enabled', '1')");
    authEnabled = true;
    // The only time the raw token exists outside the client.
    return { user: user.name, channel: channel.name, token, created_at: createdAt };
  };
  // Never includes the password hash.
  const publicUser = (user: UserRow) => ({
    name: user.name,
    is_admin: Boolean(user.is_admin),
    disabled: Boolean(user.disabled),
    has_password: Boolean(user.password_hash),
    legacy: user.id === legacyUser.id,
    created_at: user.created_at,
  });
  const guardLegacy = (user: UserRow, what: string) => {
    if (user.id === legacyUser.id) throw new AccessError(400, `cannot ${what} the legacy-token user`);
  };

  type Body = Record<string, unknown>;
  const routes: Record<string, (body: Body) => unknown> = {
    "list-users": () => (db.query("SELECT * FROM users ORDER BY name").all() as UserRow[]).map(publicUser),
    "create-user": (body) => {
      const name = normalizeName(body.name, "user");
      const isAdmin = optionalFlag(body.is_admin, "is_admin") ?? false;
      if (db.query("SELECT 1 FROM users WHERE name = ?").get(name)) throw new AccessError(409, "user already exists");
      db.run("INSERT INTO users (name, is_admin, created_at) VALUES (?, ?, ?)", [name, isAdmin ? 1 : 0, now()]);
      return publicUser(getUser(name));
    },
    "update-user": (body) => {
      const user = getUser(body.name);
      const isAdmin = optionalFlag(body.is_admin, "is_admin");
      const disabled = optionalFlag(body.disabled, "disabled");
      if (isAdmin !== undefined) {
        if (isAdmin) guardLegacy(user, "promote");
        else killSessions(user.id);
        db.run("UPDATE users SET is_admin = ? WHERE id = ?", [isAdmin ? 1 : 0, user.id]);
      }
      if (disabled !== undefined) {
        // Disabling the legacy user is the kill switch for shared env tokens.
        if (disabled) {
          killSessions(user.id);
          dropPeersWhere("user_id = ?", [user.id]);
        }
        db.run("UPDATE users SET disabled = ? WHERE id = ?", [disabled ? 1 : 0, user.id]);
      }
      return publicUser(getUser(user.name));
    },
    "delete-user": (body) => {
      const user = getUser(body.name);
      guardLegacy(user, "delete");
      killSessions(user.id);
      const peers = dropPeersWhere("user_id = ?", [user.id]);
      db.run("DELETE FROM tokens WHERE user_id = ?", [user.id]);
      db.run("DELETE FROM user_cidrs WHERE user_id = ?", [user.id]);
      db.run("DELETE FROM users WHERE id = ?", [user.id]);
      return { ok: true, peers_removed: peers };
    },
    "set-password": async (body) => {
      const user = getUser(body.name);
      guardLegacy(user, "give a password to");
      const password = body.password;
      if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > 1024) {
        throw new AccessError(400, `password must be ${MIN_PASSWORD_LENGTH}-1024 characters`);
      }
      const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
      db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, user.id]);
      killSessions(user.id);
      return { ok: true };
    },
    "clear-password": (body) => {
      const user = getUser(body.name);
      db.run("UPDATE users SET password_hash = NULL WHERE id = ?", [user.id]);
      killSessions(user.id);
      return { ok: true };
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
    // External (edge) access per user. An empty list means no external access.
    "list-cidrs": (body) => {
      const params: string[] = [];
      let where = "";
      if (body.user !== undefined) { where = "WHERE u.name = ?"; params.push(normalizeName(body.user, "user")); }
      return db.query(`
        SELECT u.name AS user, c.cidr, c.note, c.created_at
        FROM user_cidrs c JOIN users u ON u.id = c.user_id ${where} ORDER BY u.name, c.cidr
      `).all(...params);
    },
    "add-cidr": (body) => {
      const user = getUser(body.user);
      const cidr = typeof body.cidr === "string" ? parseCidr(body.cidr) : null;
      if (!cidr) throw new AccessError(400, "cidr must be an IPv4/IPv6 address or CIDR, e.g. 203.0.113.7 or 2001:db8::/48");
      if (body.note !== undefined && typeof body.note !== "string") throw new AccessError(400, "note must be a string");
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
      if (db.query("SELECT 1 FROM user_cidrs WHERE user_id = ? AND cidr = ?").get(user.id, cidr.text)) {
        throw new AccessError(409, "that CIDR is already allowed for this user");
      }
      db.run("INSERT INTO user_cidrs (user_id, cidr, note, created_at) VALUES (?, ?, ?, ?)", [user.id, cidr.text, note, now()]);
      return { user: user.name, cidr: cidr.text, note };
    },
    "remove-cidr": (body) => {
      const user = getUser(body.user);
      const cidr = typeof body.cidr === "string" ? parseCidr(body.cidr) : null;
      if (!cidr) throw new AccessError(400, "invalid cidr");
      const result = db.run("DELETE FROM user_cidrs WHERE user_id = ? AND cidr = ?", [user.id, cidr.text]);
      if (!result.changes) throw new AccessError(404, "that CIDR is not allowed for this user");
      return { ok: true };
    },
    "list-rejections": () => db.query("SELECT at, ip, user, route, reason FROM net_rejections ORDER BY id DESC").all(),
    "clear-rejections": () => {
      db.run("DELETE FROM net_rejections");
      return { ok: true };
    },
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

  // --- Admin sessions ---

  const selectSession = db.prepare(`
    SELECT s.id AS session_id, s.expires_at, u.id, u.name
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.session_hash = ? AND s.expires_at > ?
      AND u.is_admin = 1 AND u.disabled = 0 AND u.password_hash IS NOT NULL
  `);
  // Hard backoff is per (user, client address), so failures elsewhere can
  // never lock an admin out; the per-user count only adds a short delay.
  // Bounded: oldest entries are evicted first.
  const failures = new Map<string, { count: number; at: number; until: number }>();
  const inFlight = new Set<string>();
  // Per-address in-flight count, so one address cannot fill the global cap
  // by spraying many user names.
  const inFlightByAddress = new Map<string, number>();
  let dummyHash: string | null = null;

  const recentCount = (key: string, nowMs = Date.now()) => {
    const entry = failures.get(key);
    return entry && entry.at > nowMs - FAILURE_MEMORY_MS ? entry.count : 0;
  };
  const recordFailure = (keys: string[]) => {
    const nowMs = Date.now();
    for (const key of keys) {
      const count = recentCount(key, nowMs) + 1;
      failures.delete(key);
      failures.set(key, { count, at: nowMs, until: nowMs + Math.min(loginBackoffMs * 2 ** (count - 1), MAX_LOGIN_BACKOFF_MS) });
    }
    if (failures.size > MAX_FAILURE_ENTRIES) {
      for (const [key, entry] of failures) if (entry.at < nowMs - FAILURE_MEMORY_MS) failures.delete(key);
      for (const key of failures.keys()) {
        if (failures.size <= MAX_FAILURE_ENTRIES) break;
        failures.delete(key);
      }
    }
  };
  const tooMany = () => new AccessError(429, "too many failed logins; retry later");

  async function login(body: Body, ip: string) {
    let name = "";
    try {
      name = normalizeName(body.user, "user");
    } catch {
      // Invalid names fail exactly like a wrong password.
    }
    const password = typeof body.password === "string" ? body.password : "";
    const address = ip.slice(0, 64);
    const pairKey = `pair:${name.toLowerCase()}|${address}`;
    const userKey = name ? `user:${name.toLowerCase()}` : "";
    // Reserve the attempt before any await, so parallel guesses cannot all
    // pass the check while the first verify is still running.
    const addressInFlight = inFlightByAddress.get(address) ?? 0;
    if (
      inFlight.has(pairKey) ||
      inFlight.size >= MAX_FAILURE_ENTRIES ||
      addressInFlight >= MAX_IN_FLIGHT_PER_ADDRESS ||
      (failures.get(pairKey)?.until ?? 0) > Date.now()
    ) {
      throw tooMany();
    }
    inFlight.add(pairKey);
    inFlightByAddress.set(address, addressInFlight + 1);
    try {
      const softDelay = userKey ? Math.min(recentCount(userKey) * 100, MAX_SOFT_DELAY_MS) : 0;
      if (softDelay) await Bun.sleep(softDelay);
      const user = name ? (db.query("SELECT * FROM users WHERE name = ?").get(name) as UserRow | null) : null;
      // Verify against a throwaway hash for unknown users so timing does not reveal names.
      dummyHash ??= await Bun.password.hash(randomBytes(16).toString("hex"), { algorithm: "argon2id" });
      const verified = password !== "" && await Bun.password.verify(password, user?.password_hash ?? dummyHash);
      if (!verified || !user || !user.is_admin || user.disabled || !user.password_hash) {
        recordFailure(userKey ? [pairKey, userKey] : [pairKey]);
        throw new AccessError(401, "invalid credentials");
      }
      return createSession(user, [pairKey, userKey]);
    } finally {
      inFlight.delete(pairKey);
      const remaining = (inFlightByAddress.get(address) ?? 1) - 1;
      if (remaining > 0) inFlightByAddress.set(address, remaining);
      else inFlightByAddress.delete(address);
    }
  }

  function createSession(user: UserRow, clearKeys: string[]) {
    for (const key of clearKeys) failures.delete(key);
    db.run("DELETE FROM sessions WHERE expires_at <= ?", [Date.now()]);
    const session = `cps_${randomBytes(32).toString("base64url")}`;
    const expiresAt = Date.now() + sessionTtlMs;
    db.run(
      "INSERT INTO sessions (user_id, session_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
      [user.id, sha256(session), now(), expiresAt],
    );
    return { user: user.name, session, expires_at: new Date(expiresAt).toISOString() };
  }

  // --- External access checks ---

  const cidrCache = new Map<string, Cidr | null>();
  const toCidrs = (rows: { cidr: string }[]) => rows.flatMap(({ cidr }) => {
    if (!cidrCache.has(cidr)) cidrCache.set(cidr, parseCidr(cidr));
    const parsed = cidrCache.get(cidr);
    return parsed ? [parsed] : [];
  });
  const selectUserCidrs = db.prepare("SELECT cidr FROM user_cidrs WHERE user_id = ?");
  const selectEnabledCidrs = db.prepare("SELECT c.cidr FROM user_cidrs c JOIN users u ON u.id = c.user_id WHERE u.disabled = 0");

  function ipAllowedFor(userId: number, ip: string): boolean {
    return anyContains(toCidrs(selectUserCidrs.all(userId) as { cidr: string }[]), parseIp(ip));
  }

  // For unauthenticated external requests: is this address anyone's?
  function ipListedForAnyone(ip: string): boolean {
    return anyContains(toCidrs(selectEnabledCidrs.all() as { cidr: string }[]), parseIp(ip));
  }

  const recentRejections = new Map<string, number>();
  // Keeps the last MAX_REJECTIONS; repeats of the same rejection within a few
  // seconds are written once, so a flood costs little.
  function recordRejection(entry: { ip: string; user: string | null; route: string; reason: string }) {
    const nowMs = Date.now();
    const key = `${entry.ip}|${entry.user ?? ""}|${entry.route}|${entry.reason}`;
    if (nowMs - (recentRejections.get(key) ?? 0) < REJECTION_DEDUPE_MS) return;
    if (recentRejections.size > 1000) recentRejections.clear();
    recentRejections.set(key, nowMs);
    db.run(
      "INSERT INTO net_rejections (at, ip, user, route, reason) VALUES (?, ?, ?, ?, ?)",
      [new Date(nowMs).toISOString(), entry.ip.slice(0, 64), entry.user, entry.route.slice(0, 128), entry.reason],
    );
    db.run("DELETE FROM net_rejections WHERE id <= (SELECT MAX(id) FROM net_rejections) - ?", [MAX_REJECTIONS]);
  }

  async function runAdmin(route: string, body: Body): Promise<unknown> {
    const handler = Object.hasOwn(routes, route) ? routes[route] : undefined;
    if (!handler) throw new AccessError(404, "not found");
    return handler(body ?? {});
  }

  // Entry point for /admin/*. Bearer (peer) tokens are always refused, even
  // for admin users; only a login session unlocks these routes.
  async function handleAdmin(route: string, body: Body, authorization: string | null, ip: string): Promise<unknown> {
    if (route === "login") return login(body ?? {}, ip);
    if (authorization?.startsWith("Bearer ")) throw new AccessError(403, "forbidden: peer tokens cannot use admin routes");
    const row = authorization?.startsWith("Session ")
      ? selectSession.get(sha256(authorization.slice(8)), Date.now()) as { session_id: number; expires_at: number; name: string } | null
      : null;
    if (!row) throw new AccessError(401, "admin session required");
    if (route === "logout") {
      db.run("DELETE FROM sessions WHERE id = ?", [row.session_id]);
      return { ok: true };
    }
    if (route === "whoami") return { user: row.name, is_admin: true, expires_at: new Date(row.expires_at).toISOString() };
    return runAdmin(route, body);
  }

  return {
    legacyContext,
    resolveToken,
    handleAdmin,
    runAdmin,
    ipAllowedFor,
    ipListedForAnyone,
    recordRejection,
    liveTokenCount: () => (countLiveTokens.get() as { n: number }).n,
    // Re-read while off so a grant made by the direct-DB CLI takes effect.
    authEnabled: () => (authEnabled ||= Boolean(selectAuthEnabled.get())),
  };
}
