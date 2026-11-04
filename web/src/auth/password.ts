// No "server-only" or next/* imports: vitest and the break-glass CLI load this outside Next.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** OWASP-listed scrypt setting, about 64 MiB per hash. Tests lower it; nothing else should. */
export const hashParams: ScryptParams = { N: 2 ** 16, r: 8, p: 2 };

const KEY_LENGTH = 32;
const MAX_N = 2 ** 18; // a stored hash can never make us allocate more than this (r and p are bounded below)

// Each hash takes ~64 MiB and the web container has 1 GiB, so cap how many run at once.
export const MAX_CONCURRENT = 2;
/** At most this many hashes wait behind the running ones; more are refused. About 1-2 seconds of backlog. */
export const MAX_WAITING = 16;
let running = 0;
const waiting: (() => void)[] = [];

/** Thrown instead of queueing another hash when MAX_WAITING are already waiting. */
export class HashQueueFull extends Error {
  constructor() {
    super("password hashing queue is full");
  }
}

/** True when the next hash would be refused. Check it before doing anything that must not happen for a refused attempt. */
export function hashQueueFull(): boolean {
  return waiting.length >= MAX_WAITING;
}

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (hashQueueFull()) throw new HashQueueFull();
  while (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function derive(password: string, salt: Buffer, { N, r, p }: ScryptParams): Promise<Buffer> {
  return slot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
          err ? reject(err) : resolve(key),
        );
      }),
  );
}

/** `scrypt$N$r$p$salt$hash`, so the parameters can be raised later and old hashes still verify. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, hashParams);
  const { N, r, p } = hashParams;
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

function parse(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const [scheme, n, r, p, salt, key, extra] = stored.split("$");
  if (scheme !== "scrypt" || !key || extra !== undefined) return null;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  const valid = Object.values(params).every((v) => Number.isInteger(v) && v > 0) && params.N <= MAX_N && params.r <= 16 && params.p <= 4 && (params.N & (params.N - 1)) === 0;
  return valid ? { params, salt: Buffer.from(salt!, "base64url"), key: Buffer.from(key, "base64url") } : null;
}

/** False for a wrong password and for a malformed hash; never throws on bad input. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed.params);
  return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
}

export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  return !parsed || parsed.params.N !== hashParams.N || parsed.params.r !== hashParams.r || parsed.params.p !== hashParams.p;
}

let dummy: Promise<string> | undefined;

/** Burns the same time as a real check, so an unknown email is not faster than a wrong password. */
export async function verifyDummy(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(16).toString("hex")).catch((err) => {
    dummy = undefined; // do not cache a failure: it would make unknown emails fail differently from known ones
    throw err;
  });
  await verifyPassword(password, await dummy);
}
