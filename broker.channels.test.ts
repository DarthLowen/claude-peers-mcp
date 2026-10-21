import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";

const LEGACY = "fake-legacy-token";
const ADMIN_PASSWORD = "fake-admin-password";
const PROXY_SECRET = "fake-proxy-secret";
const cleanups: Array<() => Promise<void>> = [];

type Json = any;

async function startBroker(setup?: (dbPath: string) => void, envOverrides: Record<string, string> = {}) {
  const dir = mkdtempSync(`${import.meta.dir}/.channels-test-`);
  const dbPath = `${dir}/broker.db`;
  setup?.(dbPath);
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  const spawn = () => Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_CODE_MESSAGING_SOCKET: "",
      CLAUDE_CODE_MESSAGING_TOKEN: "",
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
      CLAUDE_PEERS_TOKEN: LEGACY,
      CLAUDE_PEERS_TOKENS: "",
      CLAUDE_PEERS_TOKENS_FILE: "",
      CLAUDE_PEERS_REQUIRE_AUTH: "1",
      CLAUDE_PEERS_ADMIN_USER: "",
      CLAUDE_PEERS_ADMIN_PASSWORD: ADMIN_PASSWORD,
      CLAUDE_PEERS_LEGACY_USER: "",
      CLAUDE_PEERS_LOGIN_BACKOFF_MS: "200",
      CLAUDE_PEERS_SESSION_TTL_SECONDS: "",
      CLAUDE_PEERS_PROXY_SECRET: PROXY_SECRET,
      ...envOverrides,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  let proc = spawn();
  cleanups.push(async () => {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  async function raw(path: string, body: Json, authorization?: string): Promise<{ status: number; json: Json }> {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { ...(authorization ? { Authorization: authorization } : {}), "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }
  const post = (path: string, body: Json, token: string | null = LEGACY) =>
    raw(path, body, token === null ? undefined : `Bearer ${token}`);
  const login = (user: string, password: string) => raw("/admin/login", { user, password });
  // Login as forwarded by a proxy that knows (or fakes) the shared secret.
  const loginFrom = async (user: string, password: string, ip: string, secret = PROXY_SECRET) => {
    const res = await fetch(`${base}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Peers-Client-IP": ip, "X-Peers-Proxy-Secret": secret },
      body: JSON.stringify({ user, password }),
    });
    return { status: res.status, json: await res.json() as Json };
  };
  let adminSession = "";
  // Admin calls as the env-bootstrapped admin, logging in on first use.
  async function admin(route: string, body: Json = {}) {
    if (!adminSession) adminSession = (await login("admin", ADMIN_PASSWORD)).json.session;
    return raw(`/admin/${route}`, body, `Session ${adminSession}`);
  }
  async function waitForHealth() {
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) return;
      } catch { /* Waiting for this isolated process. */ }
      await Bun.sleep(25);
    }
    throw new Error("isolated channels broker did not start");
  }
  // Restarts on the same DB and port; resolves with the old process's stderr.
  async function restart(): Promise<string> {
    proc.kill();
    const [logs] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    proc = spawn();
    adminSession = "";
    await waitForHealth();
    return logs;
  }
  await waitForHealth();
  return { post, raw, login, loginFrom, admin, restart, dbPath };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function registration(requestedId: string, instanceId: string, pid: number) {
  return {
    payload_version: 2,
    requested_id: requestedId,
    instance_id: instanceId,
    pid,
    cwd: `/tmp/${requestedId}`,
    git_root: null,
    tty: null,
    machine: "channels-testbox",
    summary: `peer ${requestedId}`,
  };
}

type Broker = Awaited<ReturnType<typeof startBroker>>;

// Two channels, one user each, each with one registered v2 peer.
async function twoChannels(b: Broker) {
  for (const name of ["red", "blue"]) expect((await b.admin("create-channel", { name })).status).toBe(200);
  for (const name of ["alice", "bob"]) expect((await b.admin("create-user", { name })).status).toBe(200);
  const red = (await b.admin("grant", { user: "alice", channel: "red" })).json.token as string;
  const blue = (await b.admin("grant", { user: "bob", channel: "blue" })).json.token as string;
  const redPeer = (await b.post("/register", registration("red-peer", "instance-red", 61001), red)).json;
  const bluePeer = (await b.post("/register", registration("blue-peer", "instance-blue", 61002), blue)).json;
  expect(redPeer.channel).toBe("red");
  expect(bluePeer.channel).toBe("blue");
  return { red, blue, redPeer, bluePeer };
}

const fleet = { scope: "fleet", cwd: "/tmp", git_root: null };
const ids = (peers: Json[]) => peers.map((p) => p.id).sort();

test("legacy env token is a non-admin peer identity in the default channel", async () => {
  const b = await startBroker();
  expect((await b.post("/whoami", {})).json).toEqual({ user: "legacy", channel: "default", is_admin: false });
  expect((await b.post("/admin/list-users", {})).status).toBe(403);
  const users = (await b.admin("list-users", {})).json;
  expect(users.map((u: Json) => [u.name, u.is_admin, u.has_password, u.legacy])).toEqual([
    ["admin", true, true, false],
    ["legacy", false, false, true],
  ]);
  expect(JSON.stringify(users)).not.toContain("argon2");
  expect((await b.admin("delete-user", { name: "legacy" })).status).toBe(400);
  expect((await b.admin("update-user", { name: "legacy", is_admin: true })).status).toBe(400);
  expect((await b.admin("set-password", { name: "legacy", password: "long-enough-pw" })).status).toBe(400);
  expect((await b.admin("delete-channel", { name: "default" })).status).toBe(400);
  const peer = await b.post("/register", registration("legacy-peer", "instance-legacy", 61000));
  expect(peer.json.channel).toBe("default");
  // Disabling the legacy user is the kill switch for shared tokens.
  await b.admin("update-user", { name: "legacy", disabled: true });
  expect((await b.post("/whoami", {})).status).toBe(401);
});

test("list, send and claim are isolated per channel", async () => {
  const b = await startBroker();
  const { red, blue, redPeer, bluePeer } = await twoChannels(b);
  expect(ids((await b.post("/list-peers", fleet, red)).json)).toEqual(["red-peer"]);
  expect(ids((await b.post("/list-peers", fleet, blue)).json)).toEqual(["blue-peer"]);
  expect(ids((await b.post("/list-peers", fleet)).json)).toEqual([]);

  const send = (to: string, token: string, from = redPeer) =>
    b.post("/send-message", { from_id: from.id, to_id: to, text: "hi", instance_id: from === redPeer ? "instance-red" : "instance-blue", lease_id: from.lease_id }, token);
  const crossChannel = await send("blue-peer", red);
  const missing = await send("nobody-here", red);
  expect(crossChannel.status).toBe(missing.status);
  expect(JSON.stringify(crossChannel.json).replace("blue-peer", "X")).toBe(JSON.stringify(missing.json).replace("nobody-here", "X"));
  expect(crossChannel.json.ok).toBe(false);

  // Same-channel delivery still works, and the other channel cannot drain it.
  const sent = await send("blue-peer", blue, bluePeer);
  expect(sent.json.ok).toBe(true);
  const claimAsRed = await b.post("/claim-messages", { id: "blue-peer", instance_id: "instance-blue", lease_id: bluePeer.lease_id }, red);
  const claimMissing = await b.post("/claim-messages", { id: "nobody-here", instance_id: "x-instance", lease_id: "x" }, red);
  expect([claimAsRed.status, claimAsRed.json]).toEqual([claimMissing.status, claimMissing.json]);
  expect((await b.post("/poll-messages", { id: "blue-peer" }, red)).json).toEqual({ messages: [] });
  const claimed = await b.post("/claim-messages", { id: "blue-peer", instance_id: "instance-blue", lease_id: bluePeer.lease_id }, blue);
  expect(claimed.json.messages.map((m: Json) => m.text)).toEqual(["hi"]);
});

test("a token cannot mutate a peer in another channel, and responses match unknown ids", async () => {
  const b = await startBroker();
  const { red, blue, bluePeer } = await twoChannels(b);
  const creds = { instance_id: "instance-blue", lease_id: bluePeer.lease_id };
  for (const [path, extra] of [
    ["/heartbeat", {}],
    ["/set-summary", { summary: "hijacked" }],
    ["/set-nickname", { nickname: "hijacked" }],
    ["/set-context", { context_note: "hijacked" }],
    ["/set-state", { blocked_on: "hijacked" }],
    ["/ack-messages", { message_ids: [1] }],
    ["/unregister", {}],
  ] as const) {
    const foreign = await b.post(path, { id: "blue-peer", ...creds, ...extra }, red);
    const unknown = await b.post(path, { id: "nobody-here", ...creds, ...extra }, red);
    expect([path, foreign.status, foreign.json]).toEqual([path, unknown.status, unknown.json]);
  }
  const [peer] = (await b.post("/list-peers", fleet, blue)).json;
  expect(peer.id).toBe("blue-peer");
  expect(peer.summary).toBe("peer blue-peer");
  expect(peer.nickname).not.toBe("hijacked");
  expect(peer.blocked_on).toBeNull();
});

test("a colliding requested id in another channel gets its own id and leaves the original intact", async () => {
  const b = await startBroker();
  const { red, blue } = await twoChannels(b);
  const legacyV1 = { requested_id: "red-peer", pid: 61003, cwd: "/tmp", git_root: null, tty: null, machine: "channels-testbox", summary: "v1 intruder" };
  const v1 = await b.post("/register", legacyV1, blue);
  const v2 = await b.post("/register", registration("red-peer", "instance-intruder", 61004), blue);
  expect(v1.status).toBe(200);
  expect(v2.status).toBe(200);
  expect(v1.json.id).not.toBe("red-peer");
  expect(v2.json.id).not.toBe("red-peer");
  const [redPeer] = (await b.post("/list-peers", fleet, red)).json;
  expect([redPeer.id, redPeer.summary]).toEqual(["red-peer", "peer red-peer"]);
  expect(ids((await b.post("/list-peers", fleet, blue)).json)).toEqual(["blue-peer", v1.json.id, v2.json.id].sort());
});

test("revoking a token or deleting a user takes effect on the next request", async () => {
  const b = await startBroker();
  const { red, blue } = await twoChannels(b);
  expect((await b.admin("revoke", { user: "bob", channel: "blue" })).json).toEqual({ ok: true });
  expect((await b.post("/list-peers", fleet, blue)).status).toBe(401);
  expect((await b.admin("list-peers", { channel: "blue" })).json).toEqual([]);

  expect((await b.admin("delete-user", { name: "alice" })).json.peers_removed).toBe(1);
  expect((await b.post("/list-peers", fleet, red)).status).toBe(401);
  expect((await b.admin("list-peers", {})).json).toEqual([]);
});

test("disabling a user rejects its tokens until re-enabled", async () => {
  const b = await startBroker();
  const { red } = await twoChannels(b);
  await b.admin("update-user", { name: "alice", disabled: true });
  expect((await b.post("/whoami", {}, red)).status).toBe(401);
  expect((await b.admin("list-peers", { user: "alice" })).json).toEqual([]);
  await b.admin("update-user", { name: "alice", disabled: false });
  expect((await b.post("/whoami", {}, red)).json).toEqual({ user: "alice", channel: "red", is_admin: false });
});

test("exactly one live token per user and channel; reissue replaces it", async () => {
  const b = await startBroker();
  const { red } = await twoChannels(b);
  expect((await b.admin("grant", { user: "alice", channel: "red" })).status).toBe(409);
  const reissued = await b.admin("reissue", { user: "alice", channel: "red" });
  expect(reissued.status).toBe(200);
  expect(reissued.json.token).not.toBe(red);
  expect((await b.post("/whoami", {}, red)).status).toBe(401);
  expect((await b.post("/whoami", {}, reissued.json.token)).json.channel).toBe("red");

  const tokens = (await b.admin("list-tokens", { user: "alice" })).json;
  expect(tokens.length).toBe(1);
  expect(Object.keys(tokens[0]).sort()).toEqual(["channel", "created_at", "last_used_at", "revoked_at", "user"]);
  expect((await b.admin("list-tokens", { user: "alice", include_revoked: true })).json.length).toBe(2);
  // A second channel for the same user is a separate grant.
  expect((await b.admin("grant", { user: "alice", channel: "blue" })).status).toBe(200);
});

test("deleting a channel revokes its tokens and drops its peers", async () => {
  const b = await startBroker();
  const { red, blue } = await twoChannels(b);
  expect((await b.admin("delete-channel", { name: "blue" })).json).toEqual({ ok: true, peers_removed: 1 });
  expect((await b.post("/whoami", {}, blue)).status).toBe(401);
  expect((await b.post("/whoami", {}, red)).status).toBe(200);
});

test("peer tokens never reach admin routes, even for admin users", async () => {
  const b = await startBroker();
  const { red } = await twoChannels(b);
  await b.admin("update-user", { name: "alice", is_admin: true });
  expect((await b.post("/whoami", {}, red)).json.is_admin).toBe(true);
  for (const token of [red, LEGACY, "not-a-token"]) {
    for (const path of ["/admin/list-users", "/admin/create-user", "/admin/grant", "/admin/list-peers", "/admin/whoami", "/admin/nope"]) {
      const res = await b.post(path, { name: "mallory", user: "alice", channel: "red" }, token);
      expect([path, res.status]).toEqual([path, 403]);
    }
  }
  expect((await b.raw("/admin/list-users", {})).status).toBe(401);
  expect((await b.raw("/admin/list-users", {}, "Session cps_bogus")).status).toBe(401);
});

test("login needs an enabled admin with a password and backs off after failures", async () => {
  const b = await startBroker();
  await b.admin("create-user", { name: "carol" });
  await b.admin("set-password", { name: "carol", password: "carol-password" });
  // A password alone is not enough: carol is not an admin.
  expect((await b.login("carol", "carol-password")).status).toBe(401);
  expect((await b.admin("set-password", { name: "carol", password: "short" })).status).toBe(400);
  await b.admin("update-user", { name: "carol", is_admin: true });
  await Bun.sleep(250);

  const ok = await b.login("carol", "carol-password");
  expect(ok.status).toBe(200);
  expect(ok.json.session).toMatch(/^cps_/);
  expect((await b.raw("/admin/whoami", {}, `Session ${ok.json.session}`)).json.user).toBe("carol");

  expect((await b.login("carol", "wrong-password")).json).toEqual({ error: "invalid credentials" });
  // During the backoff even the right password is refused.
  expect((await b.login("carol", "carol-password")).status).toBe(429);
  await Bun.sleep(250);
  expect((await b.login("carol", "wrong-again")).status).toBe(401);
  // The second failure doubles the wait.
  await Bun.sleep(250);
  expect((await b.login("carol", "carol-password")).status).toBe(429);
  await Bun.sleep(200);
  expect((await b.login("carol", "carol-password")).status).toBe(200);
  // Unknown users get the same answer as a wrong password.
  expect((await b.login("nobody", "whatever-password")).json).toEqual({ error: "invalid credentials" });

  expect((await b.raw("/admin/logout", {}, `Session ${ok.json.session}`)).json).toEqual({ ok: true });
  expect((await b.raw("/admin/whoami", {}, `Session ${ok.json.session}`)).status).toBe(401);
});

test("sessions expire", async () => {
  const b = await startBroker(undefined, { CLAUDE_PEERS_SESSION_TTL_SECONDS: "1" });
  const { json } = await b.login("admin", ADMIN_PASSWORD);
  expect((await b.raw("/admin/list-users", {}, `Session ${json.session}`)).status).toBe(200);
  await Bun.sleep(1100);
  expect((await b.raw("/admin/list-users", {}, `Session ${json.session}`)).status).toBe(401);
});

test("disabling, demoting, deleting or changing a password ends a user's sessions", async () => {
  const b = await startBroker();
  const sessionFor = async (name: string) => {
    await b.admin("create-user", { name, is_admin: true });
    await b.admin("set-password", { name, password: `${name}-password` });
    return `Session ${(await b.login(name, `${name}-password`)).json.session}`;
  };
  const alive = (session: string) => b.raw("/admin/whoami", {}, session).then((r) => r.status);
  for (const [name, change] of [
    ["dora", { route: "update-user", body: { disabled: true } }],
    ["ezra", { route: "update-user", body: { is_admin: false } }],
    ["fern", { route: "delete-user", body: {} }],
    ["gus", { route: "set-password", body: { password: "brand-new-password" } }],
    ["hana", { route: "clear-password", body: {} }],
  ] as const) {
    const session = await sessionFor(name);
    expect(await alive(session)).toBe(200);
    expect((await b.admin(change.route, { name, ...change.body })).status).toBe(200);
    expect([name, await alive(session)]).toEqual([name, 401]);
  }
});

test("the env bootstrap password is applied on startup", async () => {
  const b = await startBroker(undefined, { CLAUDE_PEERS_ADMIN_USER: "root-admin", CLAUDE_PEERS_ADMIN_PASSWORD: "env-bootstrap-pw" });
  expect((await b.login("root-admin", "env-bootstrap-pw")).status).toBe(200);
  expect((await b.login("admin", ADMIN_PASSWORD)).status).toBe(401);
});

test("the direct-DB CLI sets passwords and grants tokens", async () => {
  const b = await startBroker(undefined, { CLAUDE_PEERS_ADMIN_PASSWORD: "" });
  const cli = async (args: string[], stdin?: string) => {
    const proc = Bun.spawn(["bun", "cli.ts", `--db=${b.dbPath}`, ...args], {
      cwd: import.meta.dir,
      env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: "", CLAUDE_PEERS_LEGACY_USER: "" },
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { out, code };
  };
  expect((await b.login("admin", ADMIN_PASSWORD)).status).toBe(401);
  expect((await cli(["users", "add", "ivy", "--admin"])).code).toBe(0);
  expect((await cli(["passwd", "ivy", "--stdin"], "ivy-cli-password\n")).code).toBe(0);
  expect((await b.login("ivy", "ivy-cli-password")).status).toBe(200);

  const granted = await cli(["grant", "ivy", "default"]);
  expect(granted.code).toBe(0);
  const token = granted.out.match(/cpt_[A-Za-z0-9_-]+/)?.[0];
  expect(token).toBeDefined();
  expect((await b.post("/whoami", {}, token!)).json).toEqual({ user: "ivy", channel: "default", is_admin: true });
  expect((await b.post("/admin/list-users", {}, token!)).status).toBe(403);
  expect((await cli(["users"])).out).toContain("ivy  (admin, password)");
});

test("a database created with the pre-channel schema migrates in place", async () => {
  const now = new Date().toISOString();
  const b = await startBroker((dbPath) => {
    // Upstream 78e5f67 schema, before channels existed.
    const db = new Database(dbPath);
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, pid INTEGER NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT,
      machine TEXT NOT NULL DEFAULT 'unknown', nickname TEXT NOT NULL DEFAULT '',
      context_window INTEGER, context_used INTEGER, context_note TEXT NOT NULL DEFAULT '',
      tier TEXT NOT NULL DEFAULT 'production', payload_version INTEGER NOT NULL DEFAULT 1,
      instance_id TEXT, parent_id TEXT, runtime TEXT, rings TEXT, blocked_on TEXT, blocked_since TEXT,
      summary TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL, last_seen TEXT NOT NULL)`);
    db.run(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL, text TEXT NOT NULL,
      sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, claim_expires_at TEXT,
      claimed_by_lease_fingerprint TEXT, delivery_attempts INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'request', reply_to_id INTEGER, client_message_id TEXT)`);
    db.run(`CREATE TABLE peer_leases (
      peer_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, lease_id TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.run(
      "INSERT INTO peers (id, pid, cwd, machine, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["old-peer", 1, "/tmp/old", "migration-box", "from before", now, now],
    );
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", ["someone", "old-peer", "kept", now]);
    db.close();
  });
  const [peer] = (await b.post("/list-peers", fleet)).json;
  expect([peer.id, peer.channel, peer.summary]).toEqual(["old-peer", "default", "from before"]);
  expect((await b.post("/poll-messages", { id: "old-peer" })).json.messages.map((m: Json) => m.text)).toEqual(["kept"]);
  // A fresh channel cannot see migrated rows.
  await b.admin("create-channel", { name: "red" });
  await b.admin("create-user", { name: "alice" });
  const red = (await b.admin("grant", { user: "alice", channel: "red" })).json.token;
  expect((await b.post("/list-peers", fleet, red)).json).toEqual([]);
});

test("minting a channel token turns open mode off for good", async () => {
  const b = await startBroker(undefined, { CLAUDE_PEERS_TOKEN: "", CLAUDE_PEERS_REQUIRE_AUTH: "" });
  const anon = (path: string, body: Json = {}) => b.post(path, body, null);
  expect((await anon("/whoami")).json).toEqual({ user: "legacy", channel: "default", is_admin: false });
  expect((await anon("/admin/list-users")).status).toBe(401);
  await b.admin("create-channel", { name: "red" });
  await b.admin("create-user", { name: "alice" });
  await b.admin("grant", { user: "alice", channel: "red" });
  expect((await anon("/whoami")).status).toBe(401);
  // Removing every token must not reopen the broker.
  expect((await b.admin("revoke", { user: "alice", channel: "red" })).status).toBe(200);
  expect((await anon("/whoami")).status).toBe(401);
});

test("client_message_id dedupe is per channel, so a foreign label cannot block the real sender", async () => {
  const b = await startBroker();
  const { red, blue, redPeer } = await twoChannels(b);
  const spoof = await b.post("/send-message", { from_id: "red-peer", to_id: "blue-peer", text: "spoof", client_message_id: "dup-1" }, blue);
  expect(spoof.json.ok).toBe(true);
  const real = await b.post("/send-message", {
    from_id: "red-peer", to_id: "red-peer", text: "real", client_message_id: "dup-1",
    instance_id: "instance-red", lease_id: redPeer.lease_id,
  }, red);
  expect([real.status, real.json.ok, real.json.duplicate]).toEqual([200, true, false]);
});

test("unexpected errors return a fixed message", async () => {
  const b = await startBroker();
  const res = await b.post("/list-peers", "{not json");
  expect([res.status, res.json]).toEqual([500, { error: "internal error" }]);
});

test("admin flags must be real booleans", async () => {
  const b = await startBroker();
  expect((await b.admin("create-user", { name: "eve", is_admin: "false" })).status).toBe(400);
  expect((await b.admin("create-user", { name: "eve" })).json.is_admin).toBe(false);
  expect((await b.admin("update-user", { name: "eve", is_admin: "false" })).status).toBe(400);
  expect((await b.admin("update-user", { name: "eve", disabled: 1 })).status).toBe(400);
  const [eve] = (await b.admin("list-users", {})).json.filter((u: Json) => u.name === "eve");
  expect([eve.is_admin, eve.disabled]).toEqual([false, false]);
});

test("parallel wrong logins cannot skip the backoff", async () => {
  const b = await startBroker();
  const results = await Promise.all(Array.from({ length: 20 }, () => b.login("admin", "wrong-password")));
  const statuses = results.map((r) => r.status);
  expect(statuses.filter((s) => s === 401).length).toBe(1);
  expect(statuses.filter((s) => s === 429).length).toBe(19);
});

test("failed logins block only that user from that client address", async () => {
  const b = await startBroker();
  expect((await b.loginFrom("admin", "wrong-password", "10.0.0.1")).status).toBe(401);
  expect((await b.loginFrom("admin", ADMIN_PASSWORD, "10.0.0.1")).status).toBe(429);
  // Another client, and another user from the same client, are not locked out.
  expect((await b.loginFrom("admin", ADMIN_PASSWORD, "10.0.0.2")).status).toBe(200);
  expect((await b.loginFrom("someone-else", "x-password", "10.0.0.1")).status).toBe(401);
  // Without the right secret the forwarded address is ignored.
  expect((await b.loginFrom("admin", "wrong-password", "10.0.0.3", "wrong-secret")).status).toBe(401);
  expect((await b.loginFrom("admin", ADMIN_PASSWORD, "10.0.0.4", "wrong-secret")).status).toBe(429);
});

test("oversized login names fail like any other bad login", async () => {
  const b = await startBroker();
  const huge = await b.loginFrom("a".repeat(200_000), "whatever-password", "10.0.0.5");
  expect([huge.status, huge.json]).toEqual([401, { error: "invalid credentials" }]);
  expect((await b.loginFrom("admin", ADMIN_PASSWORD, "10.0.0.5")).status).toBe(200);
});

test("the env admin password only bootstraps a missing user", async () => {
  const b = await startBroker();
  await b.admin("create-user", { name: "ops", is_admin: true });
  await b.admin("set-password", { name: "ops", password: "ops-password" });
  expect((await b.admin("update-user", { name: "admin", disabled: true })).status).toBe(200);
  const logs = await b.restart();
  expect(logs).not.toContain(ADMIN_PASSWORD);
  expect((await b.login("admin", ADMIN_PASSWORD)).status).toBe(401);
  const opsSession = (await b.login("ops", "ops-password")).json.session;
  const [admin] = (await b.raw("/admin/list-users", {}, `Session ${opsSession}`)).json.filter((u: Json) => u.name === "admin");
  expect(admin.disabled).toBe(true);
  const restartLogs = await b.restart();
  expect(restartLogs).toContain("CLAUDE_PEERS_ADMIN_PASSWORD ignored");
  expect(restartLogs).not.toContain(ADMIN_PASSWORD);
});

test("the CLI finds the legacy user from the broker database, not its own env", async () => {
  const b = await startBroker();
  const cli = async (args: string[]) => {
    const proc = Bun.spawn(["bun", "cli.ts", `--db=${b.dbPath}`, ...args], {
      cwd: import.meta.dir,
      env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: "", CLAUDE_PEERS_LEGACY_USER: "someone-else" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { out, code };
  };
  expect((await cli(["users", "rm", "legacy"])).code).not.toBe(0);
  expect((await cli(["users", "admin", "legacy", "on"])).code).not.toBe(0);
  const listing = (await cli(["users"])).out;
  expect(listing).toContain("legacy  (legacy tokens)");
  expect(listing).not.toContain("someone-else");
  expect((await b.post("/whoami", {})).json.user).toBe("legacy");
});
