import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

const cleanups: Array<() => Promise<void>> = [];

async function startBroker(env: Record<string, string> = {}, contents?: string) {
  const dir = mkdtempSync(`${import.meta.dir}/.auth-test-`);
  const file = `${dir}/tokens`;
  if (contents !== undefined) writeFileSync(file, contents, { mode: 0o600 });
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  let logs = "";
  const proc = Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_CODE_MESSAGING_SOCKET: "",
      CLAUDE_CODE_MESSAGING_TOKEN: "",
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: `${dir}/broker.db`,
      CLAUDE_PEERS_TOKEN: "",
      CLAUDE_PEERS_TOKENS: "",
      CLAUDE_PEERS_TOKENS_FILE: contents === undefined ? "" : file,
      CLAUDE_PEERS_REQUIRE_AUTH: "",
      ...env,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const pump = (async () => {
    for await (const chunk of proc.stderr) logs += new TextDecoder().decode(chunk);
  })();
  const base = `http://127.0.0.1:${port}`;
  const fixture = {
    dir, file, proc, pump,
    logs: () => logs,
    async post(token?: string) {
      return fetch(`${base}/capabilities`, {
        method: "POST",
        headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
        body: "{}",
      });
    },
  };
  cleanups.push(async () => {
    proc.kill();
    await proc.exited;
    await pump;
    rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return fixture;
    } catch { /* Waiting for this isolated process. */ }
    await Bun.sleep(25);
  }
  throw new Error("isolated auth broker did not start");
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

test("single-token auth still requires the exact bearer", async () => {
  const f = await startBroker({ CLAUDE_PEERS_TOKEN: "fake-single" });
  expect((await f.post("fake-single")).status).toBe(200);
  expect((await f.post("fake-single-extra")).status).toBe(401);
  expect((await f.post()).status).toBe(401);
});

test("legacy env, comma/newline list, and file tokens form a deduplicated union", async () => {
  const f = await startBroker({
    CLAUDE_PEERS_TOKEN: "fake-legacy",
    CLAUDE_PEERS_TOKENS: " fake-new, fake-third\n fake-new\n\n",
  }, "fake-file\nfake-new\n");
  for (const token of ["fake-legacy", "fake-new", "fake-third", "fake-file"]) {
    expect((await f.post(token)).status).toBe(200);
  }
  expect((await f.post("fake-unknown")).status).toBe(401);
  expect(f.logs()).toContain("accepted tokens: 4");
  for (const token of ["fake-legacy", "fake-new", "fake-third", "fake-file"]) {
    expect(f.logs()).not.toContain(token);
  }
});

test("SIGHUP reload adds and removes file tokens while keeping env tokens", async () => {
  const f = await startBroker({ CLAUDE_PEERS_TOKEN: "fake-env" }, "fake-old\n");
  expect((await f.post("fake-old")).status).toBe(200);
  writeFileSync(f.file, "fake-added\n");
  f.proc.kill("SIGHUP");
  for (let i = 0; i < 80 && (await f.post("fake-added")).status !== 200; i++) {
    await Bun.sleep(25);
  }
  expect((await f.post("fake-added")).status).toBe(200);
  expect((await f.post("fake-old")).status).toBe(401);
  expect((await f.post("fake-env")).status).toBe(200);
});

test("request mtime check reloads the file after at most ten seconds", async () => {
  const f = await startBroker({}, "fake-old\n");
  expect((await f.post("fake-old")).status).toBe(200);
  writeFileSync(f.file, "fake-added\n");
  // The first request just checked the file; subsequent requests are throttled.
  expect((await f.post("fake-added")).status).toBe(401);
  await Bun.sleep(10_050);
  expect((await f.post("fake-added")).status).toBe(200);
  expect((await f.post("fake-old")).status).toBe(401);
}, 15_000);

test("failed reload retains the last accepted set without logging secrets", async () => {
  const f = await startBroker({}, "fake-retained\n");
  rmSync(f.file);
  f.proc.kill("SIGHUP");
  await Bun.sleep(50);
  expect((await f.post("fake-retained")).status).toBe(200);
  expect((await f.post("fake-unknown")).status).toBe(401);
  expect(f.logs()).toContain("token file reload failed");
  expect(f.logs()).not.toContain("fake-retained");
});

test("empty file reload revokes all file tokens without opening the broker", async () => {
  const f = await startBroker({}, "fake-revoke\n");
  writeFileSync(f.file, "\n");
  f.proc.kill("SIGHUP");
  await Bun.sleep(50);
  expect((await f.post("fake-revoke")).status).toBe(401);
  expect((await f.post()).status).toBe(401);
  expect(f.logs()).toContain("accepted tokens: 0");
});

test("no auth configuration preserves legacy open mode and warns", async () => {
  const f = await startBroker();
  expect((await f.post()).status).toBe(200);
  expect(f.logs()).toContain("accepted tokens: 0");
  expect(f.logs()).toContain("WARNING");
});
