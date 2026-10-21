import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

async function spawn(script: string, env: Record<string, string>, healthUrl: string) {
  const proc = Bun.spawn(["bun", script], {
    cwd: import.meta.dir,
    env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: "", CLAUDE_CODE_MESSAGING_TOKEN: "", ...env },
    stdout: "ignore",
    stderr: "pipe",
  });
  cleanups.push(async () => {
    proc.kill();
    await proc.exited;
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(healthUrl)).ok) return proc;
    } catch { /* Waiting for this isolated process. */ }
    await Bun.sleep(25);
  }
  throw new Error(`${script} did not start`);
}

async function startPair(proxySecret: string) {
  const dir = mkdtempSync(`${import.meta.dir}/.dashboard-test-`);
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  const brokerPort = freePort();
  const dashboardPort = freePort();
  await spawn("broker.ts", {
    CLAUDE_PEERS_PORT: String(brokerPort),
    CLAUDE_PEERS_DB: `${dir}/broker.db`,
    CLAUDE_PEERS_TOKEN: "fake-legacy-token",
    CLAUDE_PEERS_TOKENS: "",
    CLAUDE_PEERS_TOKENS_FILE: "",
    CLAUDE_PEERS_REQUIRE_AUTH: "1",
    CLAUDE_PEERS_ADMIN_USER: "",
    CLAUDE_PEERS_ADMIN_PASSWORD: "fake-admin-password",
    CLAUDE_PEERS_LEGACY_USER: "",
    CLAUDE_PEERS_PROXY_SECRET: proxySecret || "fake-broker-only-secret",
  }, `http://127.0.0.1:${brokerPort}/health`);
  const dashboard = await spawn("dashboard-server.ts", {
    CLAUDE_PEERS_DASHBOARD_PORT: String(dashboardPort),
    CLAUDE_PEERS_DASHBOARD_HOST: "127.0.0.1",
    CLAUDE_PEERS_BROKER_URL: `http://127.0.0.1:${brokerPort}`,
    CLAUDE_PEERS_TOKEN: "fake-legacy-token",
    CLAUDE_PEERS_PROXY_SECRET: proxySecret,
    CLAUDE_PEERS_DASHBOARD_ALLOWED_EMAILS: "",
  }, `http://127.0.0.1:${dashboardPort}/api/health`);
  const login = (password: string) => fetch(`http://127.0.0.1:${dashboardPort}/api/session/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Peers-Admin": "1" },
    body: JSON.stringify({ user: "admin", password }),
  });
  return { dashboard, login };
}

test("dashboard refuses admin login without a proxy secret", async () => {
  const { dashboard, login } = await startPair("");
  const res = await login("fake-admin-password");
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toContain("CLAUDE_PEERS_PROXY_SECRET");
  dashboard.kill();
  const logs = await new Response(dashboard.stderr).text();
  expect(logs).toContain("WARNING");
  expect(logs).toContain("CLAUDE_PEERS_PROXY_SECRET");
});

test("dashboard admin login works with the proxy secret and sets an HttpOnly cookie", async () => {
  const { login } = await startPair("fake-proxy-secret");
  const res = await login("fake-admin-password");
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
  expect(JSON.stringify(await res.json())).not.toContain("cps_");
});
