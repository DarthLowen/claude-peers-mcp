import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { matchWorktree, parentDied, planWake, wakeCommandId, WAKE_TEXT } from "./protocol.mjs";

const THREAD = "mcp:36a41ff7-8eef-49ab-a947-55027c14f468";
const WORKTREE = "/Users/wesleyhines/.t3/worktrees/bell-proof/codex";

test("a broker wake uses one command id and the fixed line", () => {
  expect(wakeCommandId(7)).toBe(wakeCommandId(7));
  expect(wakeCommandId(7)).not.toBe(wakeCommandId(8));
  expect(wakeCommandId(7)[14]).toBe("5");
  const planned = planWake({
    routes: { "mac-shaw": { threadId: THREAD } },
    to_id: "mac-shaw",
    message_id: 7,
    from_id: "mac-sender",
    cwd: "/tmp/root",
  });
  expect(planned.text).toBe(WAKE_TEXT);
  expect(planned.commandId).toBe(wakeCommandId(7));
  expect(planned.text).not.toContain("secret");
});

test("a worktree match is one live non-fork thread, and a route file wins", () => {
  const threads = [{ id: THREAD, worktreePath: WORKTREE, archivedAt: null }];
  expect(matchWorktree(threads, WORKTREE)).toBe(THREAD);
  expect(matchWorktree(threads, "/Users/wesleyhines/hines/assistant-claude")).toBeNull();
  expect(matchWorktree([{ id: "mcp:22222222-2222-4222-8222-222222222222:fork", worktreePath: WORKTREE, archivedAt: null }], WORKTREE)).toBeNull();
  expect(matchWorktree([
    { id: THREAD, worktreePath: WORKTREE, archivedAt: null },
    { id: "mcp:33333333-3333-4333-8333-333333333333", worktreePath: WORKTREE, archivedAt: null },
  ], WORKTREE)).toBeNull();
  const routed = planWake({
    routes: { "codex-seat": { threadId: "mcp:44444444-4444-4444-8444-444444444444" } },
    to_id: "codex-seat",
    message_id: 1,
    cwd: WORKTREE,
    threads,
  });
  expect(routed.threadId).toBe("mcp:44444444-4444-4444-8444-444444444444");
  const matched = planWake({ routes: {}, to_id: "codex-seat", message_id: 1, cwd: WORKTREE, threads });
  expect(matched.threadId).toBe(THREAD);
  const missing = planWake({ routes: {}, to_id: "codex-seat", message_id: 1, cwd: "/tmp/nope", threads });
  expect(missing.error).toBe("no-route");
});

test("the parent-death predicate notices a new parent and ignores pid 1", () => {
  expect(parentDied(10, 11)).toBe(true);
  expect(parentDied(10, 10)).toBe(false);
  expect(parentDied(1, 50)).toBe(false);
});

test("a channel-disabled seat registers as poll", () => {
  expect(readFileSync(new URL("./server.ts", import.meta.url), "utf8")).toContain('...(CHANNEL_DISABLED ? { runtime: "poll" } : {})');
});

const probe = Bun.serve({ port: 0, fetch() { return new Response(""); } });
const PORT = probe.port;
probe.stop(true);
const edgeProbe = Bun.serve({ port: 0, fetch() { return new Response(""); } });
const EDGE_PORT = edgeProbe.port;
edgeProbe.stop(true);
const DB = `/tmp/claude-peers-wake-${process.pid}.db`;
const BASE = `http://127.0.0.1:${PORT}`;
const wakes: any[] = [];
let edgeMode: "ok" | "no-route" | "hold" = "ok";
const edge = Bun.serve({
  port: EDGE_PORT,
  fetch: async (req) => {
    const body = await req.json();
    wakes.push(body);
    if (edgeMode === "hold") await new Promise(() => {});
    if (edgeMode === "no-route") return Response.json({ ok: false, error: "no-route" });
    return Response.json({ ok: true, threadId: THREAD, dispatchMode: "start_immediately" });
  },
});
let proc: ReturnType<typeof Bun.spawn> | null = null;

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function seat(id: string, extra: Record<string, unknown> = {}) {
  return { requested_id: id, pid: process.pid, cwd: WORKTREE, git_root: null, tty: null, machine: "mac", summary: id, ...extra };
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(PORT),
      CLAUDE_PEERS_DB: DB,
      CLAUDE_PEERS_TOKEN: "test-token",
      CLAUDE_PEERS_TOKENS: "",
      CLAUDE_PEERS_TOKENS_FILE: "",
      LEAD_WAKE_URL: `http://127.0.0.1:${EDGE_PORT}/wake`,
      CLAUDE_CODE_MESSAGING_SOCKET: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return; } catch { /* not up */ }
    await Bun.sleep(50);
  }
  throw new Error("broker did not start");
});

afterAll(() => {
  proc?.kill();
  edge.stop(true);
});

test("a live seat with a socket is not forwarded", async () => {
  expect((await post("/register", seat("mac-live", { runtime: "claude" }))).status).toBe(200);
  expect((await post("/register", seat("mac-sender", { pid: 7 }))).status).toBe(200);
  const before = wakes.length;
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "mac-live", text: "hello" });
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBeUndefined();
  expect(wakes.length).toBe(before);
});

test("a missing seat is forwarded", async () => {
  const before = wakes.length;
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "missing-seat", text: "where" });
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("sent");
  expect(wakes.length).toBe(before + 1);
  expect(wakes.at(-1).to_id).toBe("missing-seat");
  expect(wakes.at(-1).message_id).toBe(sent.json.message_id);
});

test("a stale seat is forwarded", async () => {
  expect((await post("/register", seat("mac-stale", { runtime: "claude" }))).status).toBe(200);
  const { Database } = await import("bun:sqlite");
  const db = new Database(DB);
  db.run("UPDATE peers SET last_seen = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", "mac-stale"]);
  db.close();
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "mac-stale", text: "old" });
  expect(sent.json.wake).toBe("sent");
  expect(wakes.at(-1).cwd).toBe(WORKTREE);
});

test("a poll-only seat is forwarded", async () => {
  expect((await post("/register", seat("mac-poll", { runtime: "poll" }))).status).toBe(200);
  const before = wakes.length;
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "mac-poll", text: "ping" });
  expect(sent.json.wake).toBe("sent");
  expect(wakes.length).toBe(before + 1);
});

test("an unknown recipient is stored and not forwarded", async () => {
  const before = wakes.length;
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "bad id", text: "nope" });
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("no-route");
  expect(wakes.length).toBe(before);
});

test("the edge's no-route and sent statuses come back unchanged", async () => {
  edgeMode = "no-route";
  const missed = await post("/send-message", { from_id: "mac-sender", to_id: "nobody-home", text: "x" });
  expect(missed.json.ok).toBe(true);
  expect(missed.json.wake).toBe("no-route");
  edgeMode = "ok";
  const hit = await post("/send-message", { from_id: "mac-sender", to_id: "somebody-home", text: "y" });
  expect(hit.json.wake).toBe("sent");
});

test("a stuck edge comes back failed within 3 seconds and the mail stays", async () => {
  edgeMode = "hold";
  const started = Date.now();
  const sent = await post("/send-message", { from_id: "mac-sender", to_id: "slow-seat", text: "wait" });
  const elapsed = Date.now() - started;
  edgeMode = "ok";
  expect(elapsed).toBeGreaterThan(2500);
  expect(elapsed).toBeLessThan(3900);
  expect(sent.json.ok).toBe(true);
  expect(sent.json.wake).toBe("failed");
  expect(sent.json.message_id).toBeGreaterThan(0);
}, 15_000);

test("an unset lead-wake url is unconfigured and does not call the edge", async () => {
  const bare = Bun.serve({ port: 0, fetch() { return new Response(""); } });
  const port = bare.port;
  bare.stop(true);
  const db = `/tmp/claude-peers-wake-off-${process.pid}.db`;
  const child = Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: db,
      CLAUDE_PEERS_TOKEN: "test-token",
      CLAUDE_PEERS_TOKENS: "",
      CLAUDE_PEERS_TOKENS_FILE: "",
      LEAD_WAKE_URL: "",
      CLAUDE_CODE_MESSAGING_SOCKET: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up */ }
      await Bun.sleep(50);
    }
    const reg = await fetch(`http://127.0.0.1:${port}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify(seat("off-sender")),
    });
    expect(reg.ok).toBe(true);
    const before = wakes.length;
    const res = await fetch(`http://127.0.0.1:${port}/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ from_id: "off-sender", to_id: "off-target", text: "z" }),
    });
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.wake).toBe("unconfigured");
    expect(wakes.length).toBe(before);
  } finally {
    child.kill();
  }
});
