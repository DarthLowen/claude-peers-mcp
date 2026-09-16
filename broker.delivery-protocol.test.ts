import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const probe = Bun.serve({
  port: 0,
  fetch() {
    return new Response("");
  },
});
const PORT = probe.port;
probe.stop(true);

const DB = `/tmp/claude-peers-delivery-${process.pid}.db`;
const BASE = `http://127.0.0.1:${PORT}`;
const VISIBILITY_TIMEOUT_MS = 100;

let broker: ReturnType<typeof Bun.spawn> | null = null;

type JsonObject = Record<string, unknown>;

async function post(path: string, body: JsonObject) {
  const response = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as JsonObject,
  };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(BASE + "/health");
      if (response.ok) return;
    } catch {
      // Broker has not started listening yet.
    }
    await Bun.sleep(25);
  }
  throw new Error("isolated broker did not start");
}

function registration(requestedId: string, instanceId: string, pid: number) {
  return {
    payload_version: 2,
    requested_id: requestedId,
    instance_id: instanceId,
    pid,
    cwd: `/tmp/${requestedId}`,
    git_root: null,
    tty: null,
    machine: "delivery-protocol-testbox",
    summary: "delivery protocol integration test",
  };
}

async function listPeer(id: string) {
  const response = await post("/list-peers", {
    scope: "fleet",
    cwd: "/tmp",
    git_root: null,
  });
  expect(response.status).toBe(200);
  if (!Array.isArray(response.json)) return undefined;
  return response.json.find(
    (peer): peer is JsonObject =>
      typeof peer === "object" && peer !== null && peer.id === id,
  );
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(DB + suffix).delete();
    } catch {
      // No prior isolated database file.
    }
  }

  broker = Bun.spawn(["bun", "broker.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(PORT),
      CLAUDE_PEERS_DB: DB,
      CLAUDE_PEERS_TOKEN: "",
      CLAUDE_PEERS_REQUIRE_AUTH: "",
      CLAUDE_PEERS_LEASE_TTL_MS: "500",
      CLAUDE_PEERS_VISIBILITY_TIMEOUT_MS: String(VISIBILITY_TIMEOUT_MS),
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  await waitForHealth();
});

afterAll(async () => {
  broker?.kill();
  if (broker) await broker.exited;

  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(DB + suffix).delete();
    } catch {
      // Ignore already-removed SQLite artifacts.
    }
  }
});

describe("payload v2 runtime ownership", () => {
  test("the first instance owns the stable peer id and a duplicate gets its own id", async () => {
    const first = await post(
      "/register",
      registration("lease-owner-test", "instance-first", 51001),
    );
    expect(first.status).toBe(200);
    expect(first.json.id).toBe("lease-owner-test");
    expect(first.json.role).toBe("owner");
    expect(typeof first.json.lease_id).toBe("string");
    expect((first.json.lease_id as string).length).toBeGreaterThan(0);
    expect(typeof first.json.lease_expires_at).toBe("string");

    await Bun.sleep(20);
    const renewed = await post(
      "/register",
      {
        ...registration("lease-owner-test", "instance-first", 51001),
        lease_id: first.json.lease_id,
      },
    );
    expect(renewed.status).toBe(200);
    expect(renewed.json.role).toBe("owner");
    expect(renewed.json.lease_id).toBe(first.json.lease_id);
    expect(
      Date.parse(renewed.json.lease_expires_at as string),
    ).toBeGreaterThan(Date.parse(first.json.lease_expires_at as string));

    // A second concurrent instance in the same directory used to be handed
    // role: "standby", which left it deaf and mute. It now gets an id of its
    // own and a real owner lease, while the base id stays with the first.
    const second = await post(
      "/register",
      registration("lease-owner-test", "instance-second", 51002),
    );
    expect(second.status).toBe(200);
    expect(second.json.id).not.toBe("lease-owner-test");
    expect(second.json.id as string).toStartWith("lease-owner-test-");
    expect(second.json.role).toBe("owner");
    expect(typeof second.json.lease_id).toBe("string");

    const visibleOwner = await listPeer("lease-owner-test");
    expect(visibleOwner?.pid).toBe(51001);
    expect(visibleOwner?.instance_id).toBeUndefined();

    for (const leaseId of [undefined, "wrong-owner-lease"]) {
      const stolenRenewal = await post("/register", {
        ...registration("lease-owner-test", "instance-first", 51099),
        ...(leaseId ? { lease_id: leaseId } : {}),
      });
      expect(stolenRenewal.status).toBe(409);
      expect(stolenRenewal.json.lease_id).toBeUndefined();
    }
    expect(Object.hasOwn(visibleOwner ?? {}, "lease_id")).toBe(false);

    const standbyClaim = await post("/claim-messages", {
      id: "lease-owner-test",
      instance_id: "instance-second",
      lease_id: "not-an-owner-lease",
    });
    expect(standbyClaim.status).toBe(409);

    const leasedPoll = await post("/poll-messages", { id: "lease-owner-test" });
    expect(leasedPoll.status).toBe(409);

    const legacyTakeover = await post("/register", {
      ...registration("lease-owner-test", "ignored-by-v1", 51003),
      payload_version: 1,
    });
    expect(legacyTakeover.status).toBe(409);
    expect((await listPeer("lease-owner-test"))?.pid).toBe(51001);
  });

  test("payload v2 rejects an invalid instance id instead of silently becoming v1", async () => {
    const invalid = await post("/register", {
      ...registration("lease-invalid-instance", "valid-instance", 51501),
      instance_id: " contains whitespace ",
    });
    expect(invalid.status).toBe(400);
    expect(await listPeer("lease-invalid-instance")).toBeUndefined();
  });

  test("a stale lease cannot heartbeat or unregister the current owner", async () => {
    const owner = await post(
      "/register",
      registration("lease-fence-test", "instance-owner", 52001),
    );
    expect(owner.status).toBe(200);
    expect(owner.json.role).toBe("owner");

    const before = await listPeer("lease-fence-test");
    const beforeLastSeen = before?.last_seen;
    await Bun.sleep(20);

    const staleHeartbeat = await post("/heartbeat", {
      id: "lease-fence-test",
      instance_id: "stale-instance",
      lease_id: "stale-lease",
    });
    expect(staleHeartbeat.status).toBe(409);

    const afterHeartbeat = await listPeer("lease-fence-test");
    expect(afterHeartbeat?.pid).toBe(52001);
    expect(afterHeartbeat?.last_seen).toBe(beforeLastSeen);

    const staleUnregister = await post("/unregister", {
      id: "lease-fence-test",
      instance_id: "stale-instance",
      lease_id: "stale-lease",
    });
    expect(staleUnregister.status).toBe(409);

    const afterUnregister = await listPeer("lease-fence-test");
    expect(afterUnregister?.pid).toBe(52001);
  });

  test("a duplicate instance takes the base id only after the original lease expires", async () => {
    const first = await post(
      "/register",
      registration("lease-takeover-test", "instance-original", 52501),
    );
    expect(first.status).toBe(200);
    expect(first.json.role).toBe("owner");

    // While the original lease is live the duplicate gets its own id rather
    // than the old deaf standby role, and must NOT hold the base.
    const duplicate = await post(
      "/register",
      registration("lease-takeover-test", "instance-standby", 52502),
    );
    expect(duplicate.status).toBe(200);
    expect(duplicate.json.role).toBe("owner");
    expect(duplicate.json.id).not.toBe("lease-takeover-test");
    expect((await listPeer("lease-takeover-test"))?.pid).toBe(52501);

    await Bun.sleep(550);

    const takeover = await post(
      "/register",
      registration("lease-takeover-test", "instance-standby", 52502),
    );
    expect(takeover.status).toBe(200);
    expect(takeover.json.role).toBe("owner");
    expect(typeof takeover.json.lease_id).toBe("string");
    expect(takeover.json.lease_id).not.toBe(first.json.lease_id);

    const visibleOwner = await listPeer("lease-takeover-test");
    expect(visibleOwner?.pid).toBe(52502);

    const staleHeartbeat = await post("/heartbeat", {
      id: "lease-takeover-test",
      instance_id: "instance-original",
      lease_id: first.json.lease_id,
    });
    expect(staleHeartbeat.status).toBe(409);
  });

  test("an expired v2 lease permits a legacy rollback without exposing the old lease", async () => {
    const owner = await post(
      "/register",
      registration("lease-legacy-rollback", "instance-v2", 52601),
    );
    expect(owner.json.role).toBe("owner");
    await Bun.sleep(550);

    const legacy = await post("/register", {
      requested_id: "lease-legacy-rollback",
      pid: 52602,
      cwd: "/tmp/lease-legacy-rollback",
      git_root: null,
      tty: null,
      machine: "delivery-protocol-testbox",
      summary: "legacy rollback",
    });
    expect(legacy.status).toBe(200);
    expect(legacy.json).toEqual({ id: "lease-legacy-rollback" });

    const heartbeat = await post("/heartbeat", { id: "lease-legacy-rollback" });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.json.found).toBe(true);
  });
});

describe("leased message delivery", () => {
  test("an unacked claim is redelivered after visibility timeout and ack is final", async () => {
    const sender = await post("/register", {
      requested_id: "lease-sender-test",
      pid: 53001,
      cwd: "/tmp/lease-sender-test",
      git_root: null,
      tty: null,
      machine: "delivery-protocol-testbox",
      summary: "legacy sender",
    });
    expect(sender.status).toBe(200);

    const receiver = await post(
      "/register",
      registration("lease-delivery-test", "instance-receiver", 53002),
    );
    expect(receiver.status).toBe(200);
    expect(receiver.json.role).toBe("owner");
    const leaseId = receiver.json.lease_id;
    expect(typeof leaseId).toBe("string");

    const sent = await post("/send-message", {
      from_id: "lease-sender-test",
      to_id: "lease-delivery-test",
      text: "redeliver until explicitly acknowledged",
    });
    expect(sent.status).toBe(200);
    expect(sent.json.ok).toBe(true);

    const claimBody = {
      id: "lease-delivery-test",
      instance_id: "instance-receiver",
      lease_id: leaseId,
    };
    const firstClaim = await post("/claim-messages", claimBody);
    expect(firstClaim.status).toBe(200);
    const firstMessages = firstClaim.json.messages as Array<JsonObject>;
    expect(firstMessages).toHaveLength(1);
    expect(firstMessages[0]?.text).toBe("redeliver until explicitly acknowledged");
    const messageId = firstMessages[0]?.id;
    expect(typeof messageId).toBe("number");

    const hiddenClaim = await post("/claim-messages", claimBody);
    expect(hiddenClaim.status).toBe(200);
    expect(hiddenClaim.json.messages).toEqual([]);

    await Bun.sleep(VISIBILITY_TIMEOUT_MS + 50);
    const redelivery = await post("/claim-messages", claimBody);
    expect(redelivery.status).toBe(200);
    const redeliveredMessages = redelivery.json.messages as Array<JsonObject>;
    expect(redeliveredMessages.map((message) => message.id)).toEqual([messageId]);

    const ack = await post("/ack-messages", {
      ...claimBody,
      message_ids: [messageId],
    });
    expect(ack.status).toBe(200);
    expect(ack.json.ok).toBe(true);
    expect(ack.json.acked).toBe(1);

    await Bun.sleep(VISIBILITY_TIMEOUT_MS + 50);
    const afterAck = await post("/claim-messages", claimBody);
    expect(afterAck.status).toBe(200);
    expect(afterAck.json.messages).toEqual([]);
  });

  test("leased sender identity is fenced on mutation endpoints", async () => {
    const sender = await post(
      "/register",
      registration("lease-mutation-sender", "instance-mutation", 53501),
    );
    expect(sender.status).toBe(200);
    const receiver = await post("/register", {
      requested_id: "lease-mutation-receiver",
      pid: 53502,
      cwd: "/tmp/lease-mutation-receiver",
      git_root: null,
      tty: null,
      machine: "delivery-protocol-testbox",
      summary: "legacy receiver",
    });
    expect(receiver.status).toBe(200);

    const staleSummary = await post("/set-summary", {
      id: "lease-mutation-sender",
      summary: "must not apply",
      instance_id: "stale-instance",
      lease_id: "stale-lease",
    });
    expect(staleSummary.status).toBe(409);

    const spoofedSend = await post("/send-message", {
      from_id: "lease-mutation-sender",
      to_id: "lease-mutation-receiver",
      text: "must not enqueue",
    });
    expect(spoofedSend.status).toBe(409);

    const authorizedSend = await post("/send-message", {
      from_id: "lease-mutation-sender",
      to_id: "lease-mutation-receiver",
      text: "lease-authenticated send",
      instance_id: "instance-mutation",
      lease_id: sender.json.lease_id,
    });
    expect(authorizedSend.status).toBe(200);
    expect(authorizedSend.json.ok).toBe(true);

    const received = await post("/poll-messages", { id: "lease-mutation-receiver" });
    expect((received.json.messages as Array<JsonObject>).map((message) => message.text)).toEqual([
      "lease-authenticated send",
    ]);
  });
});

describe("legacy delivery compatibility", () => {
  test("payload v1 registration and destructive poll continue to work", async () => {
    const sender = await post("/register", {
      requested_id: "legacy-poll-sender",
      pid: 54001,
      cwd: "/tmp/legacy-poll-sender",
      git_root: null,
      tty: null,
      machine: "delivery-protocol-testbox",
      summary: "legacy sender",
    });
    const receiver = await post("/register", {
      requested_id: "legacy-poll-receiver",
      pid: 54002,
      cwd: "/tmp/legacy-poll-receiver",
      git_root: null,
      tty: null,
      machine: "delivery-protocol-testbox",
      summary: "legacy receiver",
    });
    expect(sender.status).toBe(200);
    expect(receiver.status).toBe(200);

    const sent = await post("/send-message", {
      from_id: "legacy-poll-sender",
      to_id: "legacy-poll-receiver",
      text: "legacy poll payload",
    });
    expect(sent.json.ok).toBe(true);

    const firstPoll = await post("/poll-messages", { id: "legacy-poll-receiver" });
    expect(firstPoll.status).toBe(200);
    const firstMessages = firstPoll.json.messages as Array<JsonObject>;
    expect(firstMessages).toHaveLength(1);
    expect(firstMessages[0]?.text).toBe("legacy poll payload");

    const secondPoll = await post("/poll-messages", { id: "legacy-poll-receiver" });
    expect(secondPoll.status).toBe(200);
    expect(secondPoll.json.messages).toEqual([]);
  });
});

// Every tty-less session in one directory computes the same stablePeerId, so
// the broker gives each concurrent instance an id derived from its instance_id.
// The base holder keeps the bare id so existing addresses keep resolving.
describe("per-instance peer ids", () => {
  test("two instances in one directory each get their own owned id", async () => {
    const first = await post(
      "/register",
      registration("dup-dir-test", "dup-instance-a", 61001),
    );
    expect(first.status).toBe(200);
    expect(first.json.id).toBe("dup-dir-test");
    expect(first.json.role).toBe("owner");

    const second = await post(
      "/register",
      registration("dup-dir-test", "dup-instance-b", 61002),
    );
    expect(second.status).toBe(200);
    expect(second.json.role).toBe("owner");
    expect(typeof second.json.lease_id).toBe("string");

    const secondId = second.json.id as string;
    expect(secondId).not.toBe("dup-dir-test");
    expect(secondId).toStartWith("dup-dir-test-");

    // Both are real, separately addressable roster rows.
    expect((await listPeer("dup-dir-test"))?.pid).toBe(61001);
    expect((await listPeer(secondId))?.pid).toBe(61002);
  });

  test("the same instance re-registering keeps one id and one row", async () => {
    const base = await post(
      "/register",
      registration("idem-dir-test", "idem-holder", 62001),
    );
    expect(base.status).toBe(200);
    expect(base.json.id).toBe("idem-dir-test");

    const firstTry = await post(
      "/register",
      registration("idem-dir-test", "idem-second", 62002),
    );
    expect(firstTry.status).toBe(200);
    const assignedId = firstTry.json.id as string;
    expect(assignedId).toStartWith("idem-dir-test-");

    // Re-registering with the same instance_id must land on the SAME id, via
    // the owner path, rather than minting a fresh row on every retry. This is
    // why the suffix is derived from instance_id and is not random.
    const secondTry = await post("/register", {
      ...registration("idem-dir-test", "idem-second", 62002),
      lease_id: firstTry.json.lease_id,
    });
    expect(secondTry.status).toBe(200);
    expect(secondTry.json.id).toBe(assignedId);
    expect(secondTry.json.role).toBe("owner");

    const all = await post("/list-peers", {
      scope: "fleet",
      cwd: "/tmp",
      git_root: null,
    });
    const rows = (all.json as unknown as Array<JsonObject>).filter(
      (peer) => peer.pid === 62002,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(assignedId);
  });

  test("the bare base id still reaches the base holder and not its sibling", async () => {
    const holder = await post(
      "/register",
      registration("route-base-test", "route-holder", 63001),
    );
    expect(holder.status).toBe(200);
    expect(holder.json.id).toBe("route-base-test");

    const sibling = await post(
      "/register",
      registration("route-base-test", "route-sibling", 63002),
    );
    const siblingId = sibling.json.id as string;
    expect(siblingId).not.toBe("route-base-test");

    const sent = await post("/send-message", {
      from_id: "route-base-test",
      to_id: "route-base-test",
      instance_id: "route-holder",
      lease_id: holder.json.lease_id,
      text: "addressed to the bare base id",
    });
    expect(sent.status).toBe(200);

    // The sibling must not be able to claim a message addressed to the base.
    const siblingClaim = await post("/claim-messages", {
      id: siblingId,
      instance_id: "route-sibling",
      lease_id: sibling.json.lease_id,
    });
    expect(siblingClaim.status).toBe(200);
    expect(siblingClaim.json.messages).toEqual([]);

    const holderClaim = await post("/claim-messages", {
      id: "route-base-test",
      instance_id: "route-holder",
      lease_id: holder.json.lease_id,
    });
    expect(holderClaim.status).toBe(200);
    const delivered = holderClaim.json.messages as Array<JsonObject>;
    expect(delivered.map((message) => message.text)).toEqual([
      "addressed to the bare base id",
    ]);
  });

  test("a suffixed sibling can be addressed directly — the capability standby lacked", async () => {
    const holder = await post(
      "/register",
      registration("route-sib-test", "sib-holder", 64001),
    );
    expect(holder.status).toBe(200);

    const sibling = await post(
      "/register",
      registration("route-sib-test", "sib-second", 64002),
    );
    const siblingId = sibling.json.id as string;
    expect(siblingId).toStartWith("route-sib-test-");

    const sent = await post("/send-message", {
      from_id: "route-sib-test",
      to_id: siblingId,
      instance_id: "sib-holder",
      lease_id: holder.json.lease_id,
      text: "addressed to the second session directly",
    });
    expect(sent.status).toBe(200);
    expect(sent.json.ok).toBe(true);

    const claim = await post("/claim-messages", {
      id: siblingId,
      instance_id: "sib-second",
      lease_id: sibling.json.lease_id,
    });
    expect(claim.status).toBe(200);
    const messages = claim.json.messages as Array<JsonObject>;
    expect(messages.map((message) => message.text)).toEqual([
      "addressed to the second session directly",
    ]);
  });

  test("payload v1 against a leased base is unchanged", async () => {
    const leased = await post(
      "/register",
      registration("v1-guard-test", "v1-guard-holder", 65001),
    );
    expect(leased.status).toBe(200);
    expect(leased.json.id).toBe("v1-guard-test");

    // v1 clients send no instance_id, so they cannot be disambiguated and must
    // keep the pre-existing 409 rather than silently getting a suffixed id.
    const legacy = await post("/register", {
      ...registration("v1-guard-test", "ignored-by-v1", 65002),
      payload_version: 1,
    });
    expect(legacy.status).toBe(409);
    expect((await listPeer("v1-guard-test"))?.pid).toBe(65001);
  });

  test("a base long enough to need truncation keeps its suffix and fits in 64 chars", async () => {
    const longBase = "t".repeat(64);
    expect(longBase).toHaveLength(64);

    const first = await post(
      "/register",
      registration(longBase, "long-holder", 66001),
    );
    expect(first.status).toBe(200);
    expect(first.json.id).toBe(longBase);

    const second = await post(
      "/register",
      registration(longBase, "long-second", 66002),
    );
    expect(second.status).toBe(200);
    const secondId = second.json.id as string;

    // Truncating after appending would slice the suffix off and recreate the
    // collision, so assert both the length cap and a surviving suffix.
    expect(secondId.length).toBeLessThanOrEqual(64);
    expect(secondId).not.toBe(longBase);
    expect(secondId).toMatch(/-[0-9a-f]{4,8}$/);
    expect(second.json.role).toBe("owner");
  });
});
