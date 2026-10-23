import { expect, test } from "bun:test";
import {
  anyContains,
  classifyRequest,
  cidrContains,
  edgeSecretHash,
  normalizeIp,
  parseCidr,
  parseCidrList,
  parseIp,
  DEFAULT_DIRECT_CIDRS,
} from "./broker-net.ts";

const contains = (cidr: string, ip: string) => cidrContains(parseCidr(cidr)!, parseIp(ip)!);

test("parses and normalizes IPv4, IPv6 and IPv4-mapped addresses", () => {
  expect(normalizeIp("10.1.2.5")).toBe("10.1.2.5");
  expect(normalizeIp("::ffff:10.1.2.5")).toBe("10.1.2.5");
  expect(normalizeIp("::FFFF:0a01:0205")).toBe("10.1.2.5");
  expect(normalizeIp("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
  expect(normalizeIp("[fe80::1%eth0]")).toBe("fe80::1");
  expect(normalizeIp("::")).toBe("::");
  expect(normalizeIp("1:0:0:2:0:0:0:3")).toBe("1:0:0:2::3");
  expect(normalizeIp("::1.2.3.4")).toBe("::102:304");
  for (const bad of ["", "256.1.1.1", "1.2.3", "01.2.3.4", "1.2.3.4.5", "1::2::3", "12345::", "1:2:3:4:5:6:7:8:9", "1.2.3.4::", "host.example"]) {
    expect([bad, parseIp(bad)]).toEqual([bad, null]);
  }
});

test("CIDRs normalize single addresses and clear host bits", () => {
  expect(parseCidr("203.0.113.7")!.text).toBe("203.0.113.7/32");
  expect(parseCidr("10.1.2.3/8")!.text).toBe("10.0.0.0/8");
  expect(parseCidr("2001:db8::1")!.text).toBe("2001:db8::1/128");
  expect(parseCidr("2001:db8:abcd::/33")!.text).toBe("2001:db8:8000::/33");
  expect(parseCidr("::ffff:10.0.0.0/104")!.text).toBe("10.0.0.0/8");
  for (const bad of ["10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/", "10.0.0.0/08", "::/129", "::ffff:10.0.0.0/95", "nope/8"]) {
    expect([bad, parseCidr(bad)]).toEqual([bad, null]);
  }
});

test("IPv4 matching edges: /0, /32 and range boundaries", () => {
  expect(contains("0.0.0.0/0", "203.0.113.9")).toBe(true);
  expect(contains("0.0.0.0/0", "::1")).toBe(false);
  expect(contains("203.0.113.9/32", "203.0.113.9")).toBe(true);
  expect(contains("203.0.113.9/32", "203.0.113.10")).toBe(false);
  expect(contains("10.1.2.0/24", "10.1.2.0")).toBe(true);
  expect(contains("10.1.2.0/24", "10.1.2.255")).toBe(true);
  expect(contains("10.1.2.0/24", "192.168.87.0")).toBe(false);
  expect(contains("10.1.2.0/24", "192.168.85.255")).toBe(false);
  expect(contains("172.16.0.0/12", "172.31.255.255")).toBe(true);
  expect(contains("172.16.0.0/12", "172.32.0.0")).toBe(false);
  expect(contains("10.0.0.0/7", "11.255.255.255")).toBe(true);
  expect(contains("10.0.0.0/7", "12.0.0.0")).toBe(false);
  expect(contains("127.0.0.0/8", "::ffff:127.0.0.1")).toBe(true);
});

test("IPv6 matching", () => {
  expect(contains("::/0", "2001:db8::1")).toBe(true);
  expect(contains("::1/128", "::1")).toBe(true);
  expect(contains("::1/128", "::2")).toBe(false);
  expect(contains("2001:db8::/32", "2001:db8:ffff::1")).toBe(true);
  expect(contains("2001:db8::/32", "2001:db9::")).toBe(false);
  expect(contains("2001:db8::/31", "2001:db9::")).toBe(true);
  expect(contains("fe80::/10", "febf::1")).toBe(true);
  expect(contains("fe80::/10", "fec0::1")).toBe(false);
  expect(contains("::/0", "1.2.3.4")).toBe(false);
});

test("lists parse and reject invalid entries", () => {
  expect(parseCidrList(DEFAULT_DIRECT_CIDRS).map((c) => c.text)).toEqual([
    "127.0.0.0/8", "::1/128", "10.1.2.0/24", "172.21.0.0/16",
  ]);
  expect(() => parseCidrList("10.0.0.0/8, bogus")).toThrow("invalid CIDR: bogus");
  expect(anyContains(parseCidrList("10.0.0.0/8"), null)).toBe(false);
});

test("request classification trusts forwarded addresses only with the edge secret", () => {
  const secretHash = edgeSecretHash("edge-secret");
  const directCidrs = parseCidrList(DEFAULT_DIRECT_CIDRS);
  const classify = (socketIp: string, forwardedIp: string | null, presentedSecret: string | null, hash: Buffer | null = secretHash) =>
    classifyRequest({ socketIp, forwardedIp, presentedSecret, secretHash: hash, directCidrs });

  // Valid secret: external, with the forwarded address.
  expect(classify("192.168.16.2", "203.0.113.9", "edge-secret")).toEqual({ kind: "external", ip: "203.0.113.9" });
  expect(classify("192.168.16.2", "::ffff:203.0.113.9", "edge-secret")).toEqual({ kind: "external", ip: "203.0.113.9" });
  expect(classify("192.168.16.2", "garbage", "edge-secret").kind).toBe("refused");
  expect(classify("192.168.16.2", null, "edge-secret").kind).toBe("refused");
  // Edge proxy forgetting the secret: its own address is not direct.
  expect(classify("192.168.16.2", "203.0.113.9", null)).toEqual({ kind: "refused", ip: "192.168.16.2" });
  // Wrong secret counts as direct; a spoofed client address is ignored.
  expect(classify("192.168.16.2", "10.1.2.5", "wrong")).toEqual({ kind: "refused", ip: "192.168.16.2" });
  expect(classify("10.1.2.5", "203.0.113.9", "wrong")).toEqual({ kind: "direct", ip: "10.1.2.5" });
  expect(classify("::ffff:172.21.0.1", "203.0.113.9", null)).toEqual({ kind: "direct", ip: "172.21.0.1" });
  expect(classify("127.0.0.1", null, null).kind).toBe("direct");
  // No edge secret configured: nothing is ever external.
  expect(classify("192.168.16.2", "203.0.113.9", "edge-secret", null).kind).toBe("refused");
  expect(classify("", null, null).kind).toBe("refused");
});
