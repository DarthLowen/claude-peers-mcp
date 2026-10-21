import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";

const LEGACY = "fake-legacy-admin";
const cleanups: Array<() => Promise<void>> = [];

type Json = any;

async function startBroker(setup?: (dbPath: string) => void) {
  const dir = mkdtempSync(`${import.meta.dir}/.channels-test-`);
  const dbPath = `${dir}/broker.db`;
  setup?.(dbPath);
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  const proc = Bun.spawn(["bun", "broker.ts"], {
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
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  cleanups.push(async () => {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  async function post(path: string, body: Json, token = LEGACY): Promise<{ status: number; json: Json }> {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { post, dbPath };
    } catch { /* Waiting for this isolated process. */ }
    await Bun.sleep(25);
  }
  throw new Error("isolated channels broker did not start");
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
  for (const name of ["red", "blue"]) expect((await b.post("/admin/create-channel", { name })).status).toBe(200);
  for (const name of ["alice", "bob"]) expect((await b.post("/admin/create-user", { name })).status).toBe(200);
  const red = (await b.post("/admin/grant", { user: "alice", channel: "red" })).json.token as string;
  const blue = (await b.post("/admin/grant", { user: "bob", channel: "blue" })).json.token as string;
  const redPeer = (await b.post("/register", registration("red-peer", "instance-red", 61001), red)).json;
  const bluePeer = (await b.post("/register", registration("blue-peer", "instance-blue", 61002), blue)).json;
  expect(redPeer.channel).toBe("red");
  expect(bluePeer.channel).toBe("blue");
  return { red, blue, redPeer, bluePeer };
}

const fleet = { scope: "fleet", cwd: "/tmp", git_root: null };
const ids = (peers: Json[]) => peers.map((p) => p.id).sort();

test("legacy env token is the bootstrap admin in the default channel", async () => {
  const b = await startBroker();
  expect((await b.post("/whoami", {})).json).toEqual({ user: "admin", channel: "default", is_admin: true });
  const users = (await b.post("/admin/list-users", {})).json;
  expect(users.map((u: Json) => [u.name, u.is_admin, u.bootstrap])).toEqual([["admin", true, true]]);
  expect((await b.post("/admin/delete-user", { name: "admin" })).status).toBe(400);
  expect((await b.post("/admin/delete-channel", { name: "default" })).status).toBe(400);
  const peer = await b.post("/register", registration("legacy-peer", "instance-legacy", 61000));
  expect(peer.json.channel).toBe("default");
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
  expect((await b.post("/admin/revoke", { user: "bob", channel: "blue" })).json).toEqual({ ok: true });
  expect((await b.post("/list-peers", fleet, blue)).status).toBe(401);
  expect((await b.post("/admin/list-peers", { channel: "blue" })).json).toEqual([]);

  expect((await b.post("/admin/delete-user", { name: "alice" })).json.peers_removed).toBe(1);
  expect((await b.post("/list-peers", fleet, red)).status).toBe(401);
  expect((await b.post("/admin/list-peers", {})).json).toEqual([]);
});

test("disabling a user rejects its tokens until re-enabled", async () => {
  const b = await startBroker();
  const { red } = await twoChannels(b);
  await b.post("/admin/update-user", { name: "alice", disabled: true });
  expect((await b.post("/whoami", {}, red)).status).toBe(401);
  expect((await b.post("/admin/list-peers", { user: "alice" })).json).toEqual([]);
  await b.post("/admin/update-user", { name: "alice", disabled: false });
  expect((await b.post("/whoami", {}, red)).json).toEqual({ user: "alice", channel: "red", is_admin: false });
});

test("exactly one live token per user and channel; reissue replaces it", async () => {
  const b = await startBroker();
  const { red } = await twoChannels(b);
  expect((await b.post("/admin/grant", { user: "alice", channel: "red" })).status).toBe(409);
  const reissued = await b.post("/admin/reissue", { user: "alice", channel: "red" });
  expect(reissued.status).toBe(200);
  expect(reissued.json.token).not.toBe(red);
  expect((await b.post("/whoami", {}, red)).status).toBe(401);
  expect((await b.post("/whoami", {}, reissued.json.token)).json.channel).toBe("red");

  const tokens = (await b.post("/admin/list-tokens", { user: "alice" })).json;
  expect(tokens.length).toBe(1);
  expect(Object.keys(tokens[0]).sort()).toEqual(["channel", "created_at", "last_used_at", "revoked_at", "user"]);
  expect((await b.post("/admin/list-tokens", { user: "alice", include_revoked: true })).json.length).toBe(2);
  // A second channel for the same user is a separate grant.
  expect((await b.post("/admin/grant", { user: "alice", channel: "blue" })).status).toBe(200);
});

test("deleting a channel revokes its tokens and drops its peers", async () => {
  const b = await startBroker();
  const { red, blue } = await twoChannels(b);
  expect((await b.post("/admin/delete-channel", { name: "blue" })).json).toEqual({ ok: true, peers_removed: 1 });
  expect((await b.post("/whoami", {}, blue)).status).toBe(401);
  expect((await b.post("/whoami", {}, red)).status).toBe(200);
});

test("non-admin tokens cannot reach admin endpoints", async () => {
  const b = await startBroker();
  const { red } = await twoChannels(b);
  for (const path of ["/admin/list-users", "/admin/create-user", "/admin/grant", "/admin/list-peers", "/admin/nope"]) {
    const res = await b.post(path, { name: "mallory", user: "alice", channel: "red" }, red);
    expect([path, res.status, res.json]).toEqual([path, 403, { error: "forbidden" }]);
  }
  await b.post("/admin/update-user", { name: "alice", is_admin: true });
  expect((await b.post("/admin/list-users", {}, red)).status).toBe(200);
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
  await b.post("/admin/create-channel", { name: "red" });
  await b.post("/admin/create-user", { name: "alice" });
  const red = (await b.post("/admin/grant", { user: "alice", channel: "red" })).json.token;
  expect((await b.post("/list-peers", fleet, red)).json).toEqual([]);
});
