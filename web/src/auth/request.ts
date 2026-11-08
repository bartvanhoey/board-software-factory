import { isIP } from "node:net";

/** The 8 groups of a canonical IPv6 address (as `new URL` prints it: lowercase, zeros compressed, no dotted quad). */
function groupsOf(canonical: string): number[] {
  const [head = "", tail] = canonical.split("::");
  const side = (s: string): number[] => (s === "" ? [] : s.split(":").map((g) => parseInt(g, 16)));
  const first = side(head);
  if (tail === undefined) return first;
  const last = side(tail);
  return [...first, ...Array<number>(8 - first.length - last.length).fill(0), ...last];
}

/**
 * One spelling per address: IPv4 as is, IPv6 lowercase with the zeros compressed, an IPv4-mapped IPv6 address
 * (::ffff:1.2.3.4) as plain IPv4. Null for anything that is not an IP address (a zone id such as %eth0 included).
 */
export function normalizeIp(value: string): string | null {
  if (value.length > 45 || value.includes("%")) return null;
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;
  const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const g = groupsOf(canonical);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  return canonical;
}

/**
 * The client IP, only when a proxy we control sets X-Forwarded-For (TRUST_PROXY). Otherwise null: Next does
 * not expose the socket address and the header is spoofable, so per-IP limits would be worthless.
 * The last entry is the one our proxy appended; it must be a valid IP address and is returned in its canonical form.
 */
export function clientIp(get: (name: string) => string | null, trustProxy: boolean): string | null {
  if (!trustProxy) return null;
  const last = get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return last ? normalizeIp(last) : null;
}

/**
 * The key a per-IP limit counts under. An IPv6 client usually owns a whole /64 (2^64 addresses), so counting per
 * address would let it dodge the limit by rotating addresses: IPv6 is counted per /64. IPv4 is counted per address.
 * Only for limits: the audit log keeps the full address.
 */
export function ipKey(ip: string): string {
  const normal = normalizeIp(ip) ?? ip;
  if (isIP(normal) !== 6) return normal;
  const g = groupsOf(normal);
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-session" : "session";
}
