import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Mailbox, ringDoorbell } from "./butler-inbox-edge";

test("durable mailbox: all kinds survive restart, duplicate capture and repeated ack", () => {
  const dir = mkdtempSync(join(import.meta.dir, ".mail-test-"));
  try {
    let mail = new Mailbox(join(dir, "mail.sqlite"));
    const messages = ["request", "reply", "notification"].map((kind, i) => ({ id: i + 1, kind, text: kind }));
    mail.save(messages);
    mail.ack([1]);
    mail.db.close();
    mail = new Mailbox(join(dir, "mail.sqlite"));
    mail.save(messages);
    expect(mail.unread().map(m => m.kind)).toEqual(["reply", "notification"]);
    expect(mail.ack([1, 2, 3])).toBe(2);
    expect(mail.ack([1, 2, 3])).toBe(0);
    expect(mail.unread()).toEqual([]);
    mail.db.close();
  } finally { rmSync(dir, { recursive: true }); }
});

test("doorbell: absent path, content-free POST, five-minute debounce across restart, failures and empty mail", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".bell-test-"));
  try {
    let mail = new Mailbox(join(dir, "mail.sqlite"));
    mail.save([{ id: 1, kind: "notification", text: "private mail" }]);
    let calls = 0;
    const logs: string[] = [];
    const post: typeof fetch = (async (url: any, opts: any) => {
      calls++;
      expect(String(url)).toBe("http://100.103.170.84:3773/api/hooks/test-id/test-token");
      expect(opts.body).toBe('{"doorbell":true}');
      return new Response("", { status: 202 });
    }) as any;
    const now = 1_800_000;
    await ringDoorbell(mail, dir, now, post, s => logs.push(s));
    await ringDoorbell(mail, dir, now + 1, post, s => logs.push(s));
    expect(logs).toEqual(["no doorbell path"]);
    expect(calls).toBe(0);
    writeFileSync(join(dir, "doorbell"), "/api/hooks/test-id/test-token", { mode: 0o600 });
    await ringDoorbell(mail, dir, now + 2, post, s => logs.push(s));
    expect(calls).toBe(1);
    mail.db.close();
    mail = new Mailbox(join(dir, "mail.sqlite"));
    await ringDoorbell(mail, dir, now + 299_999, post, s => logs.push(s));
    expect(calls).toBe(1);
    await ringDoorbell(mail, dir, now + 300_002, post, s => logs.push(s));
    expect(calls).toBe(2);
    const fail = (async () => { calls++; throw new Error("secret URL must not reach logs"); }) as typeof fetch;
    await ringDoorbell(mail, dir, now + 600_002, fail, s => logs.push(s));
    await ringDoorbell(mail, dir, now + 600_003, fail, s => logs.push(s));
    expect(calls).toBe(3);
    expect(logs.at(-1)).toBe("doorbell failed (network/timeout)");
    mail.ack([1]);
    await ringDoorbell(mail, dir, now + 600_004, post, s => logs.push(s));
    expect(calls).toBe(3);
    mail.save([{ id: 2, kind: "notification", text: "new burst" }]);
    await ringDoorbell(mail, dir, now + 600_005, post, s => logs.push(s));
    expect(calls).toBe(4);
    mail.db.close();
  } finally { rmSync(dir, { recursive: true }); }
});
