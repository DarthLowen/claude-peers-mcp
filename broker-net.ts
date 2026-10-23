/**
 * Network trust for the broker: IP/CIDR parsing and the per-request decision
 * between "direct" (socket address inside CLAUDE_PEERS_DIRECT_CIDRS, the
 * dashboard's proxy secret, or the local-only listener), "external"
 * (forwarded by the edge proxy, proven by CLAUDE_PEERS_EDGE_SECRET) and
 * "refused". Pure functions only, so the decision is testable without
 * faking socket addresses.
 */

import { createHash, timingSafeEqual } from "node:crypto";

// No docker bridge ranges: their gateway address is also the masquerade
// source of every other docker network, the edge proxy's included.
export const DEFAULT_DIRECT_CIDRS = "127.0.0.0/8,::1/128,10.1.2.0/24";

export interface ParsedIp {
  family: 4 | 6;
  bytes: Uint8Array; // 4 or 16 bytes
}

export interface Cidr extends ParsedIp {
  prefix: number;
  text: string; // canonical "addr/prefix"
}

function parseV4(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^(0|[1-9]\d{0,2})$/.test(parts[i]!)) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseV6(s: string): Uint8Array | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  // An embedded IPv4 tail may only end the address.
  if (halves.length === 2 && halves[0]!.includes(".")) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      if (i === groups.length - 1 && g.includes(".")) {
        const v4 = parseV4(g);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(g)) {
        out.push(parseInt(g, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = groupsOf(halves[0]!);
  const tail = halves.length === 2 ? groupsOf(halves[1]!) : [];
  if (!head || !tail) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  });
  return bytes;
}

const isV4Mapped = (b: Uint8Array) =>
  b.length === 16 && b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;

// Accepts IPv4, IPv6 (compressed, bracketed, zone id) and IPv4-mapped IPv6,
// which is folded to plain IPv4.
export function parseIp(input: string): ParsedIp | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s || s.length > 64) return null;
  const v4 = parseV4(s);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseV6(s);
  if (!v6) return null;
  return isV4Mapped(v6) ? { family: 4, bytes: v6.slice(12) } : { family: 6, bytes: v6 };
}

// RFC 5952 text form: lowercase, no leading zeros, longest zero run as "::".
export function formatIp(ip: ParsedIp): string {
  if (ip.family === 4) return [...ip.bytes].join(".");
  const groups = Array.from({ length: 8 }, (_, i) => (ip.bytes[i * 2]! << 8) | ip.bytes[i * 2 + 1]!);
  let bestStart = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}

export function normalizeIp(input: string): string | null {
  const ip = parseIp(input);
  return ip ? formatIp(ip) : null;
}

// Parses "addr" or "addr/prefix"; a bare address becomes /32 or /128 and host
// bits are cleared, so "10.0.0.5/24" is stored as "10.0.0.0/24".
export function parseCidr(input: string): Cidr | null {
  const trimmed = input.trim();
  const slash = trimmed.indexOf("/");
  const addr = slash < 0 ? trimmed : trimmed.slice(0, slash);
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.family === 4 ? 32 : 128;
  let prefix = max;
  if (slash >= 0) {
    const text = trimmed.slice(slash + 1);
    if (!/^(0|[1-9]\d{0,2})$/.test(text)) return null;
    prefix = Number(text);
    // An IPv4-mapped IPv6 prefix counts from bit 96.
    if (ip.family === 4 && addr.includes(":")) {
      if (prefix < 96 || prefix > 128) return null;
      prefix -= 96;
    }
    if (prefix > max) return null;
  }
  const bytes = ip.bytes.slice();
  for (let bit = prefix; bit < max; bit++) bytes[bit >> 3]! &= ~(0x80 >> (bit & 7));
  const masked = { family: ip.family, bytes };
  return { ...masked, prefix, text: `${formatIp(masked)}/${prefix}` };
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  if (cidr.family !== ip.family) return false;
  const full = cidr.prefix >> 3;
  for (let i = 0; i < full; i++) if (cidr.bytes[i] !== ip.bytes[i]) return false;
  const rest = cidr.prefix & 7;
  if (!rest) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (cidr.bytes[full]! & mask) === (ip.bytes[full]! & mask);
}

// Comma or whitespace separated; throws on the first invalid entry.
export function parseCidrList(input: string): Cidr[] {
  return input.split(/[\s,]+/).filter(Boolean).map((entry) => {
    const cidr = parseCidr(entry);
    if (!cidr) throw new Error(`invalid CIDR: ${entry}`);
    return cidr;
  });
}

export function anyContains(cidrs: Cidr[], ip: ParsedIp | null): boolean {
  return ip !== null && cidrs.some((c) => cidrContains(c, ip));
}

export type NetDecision =
  | { kind: "direct"; ip: string }
  | { kind: "external"; ip: string }
  | { kind: "refused"; ip: string };

export const edgeSecretHash = (secret: string) => createHash("sha256").update(secret).digest();

const secretMatches = (presented: string | null, hash: Buffer | null) =>
  Boolean(hash && presented && timingSafeEqual(edgeSecretHash(presented), hash));

// Fail closed. On the broker host, docker masquerades traffic from other networks (the
// edge proxy included) so it arrives from the bridge gateway, which is why
// the socket address alone can never vouch for a request that looks proxied:
//   1. Any X-Peers-Edge-Secret header (even empty, even with no secret
//      configured) must match, or the request is refused. A match makes it
//      external, with X-Peers-Client-IP as the client.
//   2. A valid dashboard proxy secret makes it direct from any address.
//   3. Any other request carrying X-Peers-Client-IP is refused.
//   4. Requests on the local-only listener are direct.
//   5. Otherwise the socket address must be inside the direct CIDRs.
export function classifyRequest(input: {
  socketIp: string;
  forwardedIp: string | null;
  presentedSecret: string | null;
  secretHash: Buffer | null;
  presentedProxySecret?: string | null;
  proxySecretHash?: Buffer | null;
  localListener?: boolean;
  directCidrs: Cidr[];
}): NetDecision {
  const socket = parseIp(input.socketIp);
  const socketText = socket ? formatIp(socket) : input.socketIp.slice(0, 64);
  if (input.presentedSecret !== null) {
    if (!secretMatches(input.presentedSecret, input.secretHash)) return { kind: "refused", ip: socketText };
    const forwarded = input.forwardedIp ? parseIp(input.forwardedIp) : null;
    return forwarded
      ? { kind: "external", ip: formatIp(forwarded) }
      : { kind: "refused", ip: (input.forwardedIp ?? socketText).slice(0, 64) };
  }
  if (secretMatches(input.presentedProxySecret ?? null, input.proxySecretHash ?? null)) {
    return { kind: "direct", ip: socketText };
  }
  if (input.forwardedIp !== null) return { kind: "refused", ip: socketText };
  if (input.localListener) return { kind: "direct", ip: socketText };
  return anyContains(input.directCidrs, socket) ? { kind: "direct", ip: socketText } : { kind: "refused", ip: socketText };
}
