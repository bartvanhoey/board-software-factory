// No "server-only" or next/* imports: this is the testable core. Server actions only add cookies and redirects.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { audit } from "./audit";
import { transaction } from "./db";
import { HashQueueFull, hashPassword, hashQueueFull, needsRehash, verifyDummy, verifyPassword } from "./password";
import { checkPassword } from "./policy";
import { ipKey } from "./request";
import { createSession, deleteSession, purgeExpired, revokeSessions, validateSession } from "./sessions";
import { consume, recordFailure, releaseFailure, resetFailures, retryAfter } from "./throttle";
import { countAdmins, countPending, createUser, findUserByEmail, findUserById, grantRole, isPlainAddress, normalizeEmail } from "./users";

export interface Ctx {
  /** Null unless TRUST_PROXY is on; see request.ts. */
  ip: string | null;
  userAgent: string | null;
  now?: number;
}

export type Failure = { ok: false; error: string };
export type LoggedIn = { ok: true; token: string; expiresAt: number };

const HOUR = 3_600_000;
const REGISTER_PER_IP = 5;
const REGISTER_GLOBAL = 20;
const PENDING_CAP = 100;
const GENERIC_LOGIN_ERROR = "Wrong email or password.";
const EXISTS = "An account with this email already exists.";

const BUSY = "The server is busy. Try again in a moment.";

function wait(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  return `Too many attempts. Try again in ${minutes <= 1 ? "a minute" : `${minutes} minutes`}.`;
}

/** The throttle table is keyed by unauthenticated input, which may be a password typed into the wrong box. Never store it raw. */
function keyPart(raw: string): string {
  return createHash("sha256").update(raw.trim().toLowerCase().slice(0, 254)).digest("hex").slice(0, 32);
}

export const waitMessage = wait;

/** The login throttle key for an email, so an admin password reset can clear it. */
export const acctThrottleKey = (email: string): string => `login:acct:${keyPart(email)}`;

const isDuplicateEmail = (err: unknown): boolean => err instanceof Error && /UNIQUE constraint failed: users\.email/.test(err.message);

/**
 * Registration limits are a deliberate trade-off: without a trusted proxy there is only a global bucket, so a
 * determined attacker can use it up. Only well-formed attempts count, so plain junk cannot.
 */
export async function register(db: DatabaseSync, input: { email: string; password: string }, ctx: Ctx): Promise<LoggedIn | Failure> {
  const now = ctx.now ?? Date.now();
  const email = normalizeEmail(input.email);
  // New accounts only: an address a mailer would refuse can never receive a link, so it would be a dead account.
  if (!email || !isPlainAddress(email)) return { ok: false, error: "Enter a valid email address." };
  const policy = checkPassword(input.password, email);
  if (policy) return { ok: false, error: policy };
  if (countPending(db) >= PENDING_CAP) return { ok: false, error: "Registration is temporarily closed." };

  const allowed = ctx.ip
    ? consume(db, `register:ip:${ipKey(ctx.ip)}`, REGISTER_PER_IP, HOUR, now)
    : consume(db, "register:global", REGISTER_GLOBAL, HOUR, now);
  if (!allowed) return { ok: false, error: "Too many registrations. Try again later." };

  // Hash first: the check, the inserts and the session then run with no await in between, so two
  // simultaneous registrations for one email cannot both pass the check.
  const passwordHash = await hashPassword(input.password);
  try {
    return transaction(db, (): LoggedIn | Failure => {
      if (findUserByEmail(db, email)) return { ok: false, error: EXISTS };
      const id = createUser(db, { email, passwordHash }, now);
      audit(db, { action: "user.registered", actor: id, target: id, ip: ctx.ip }, now);
      return { ok: true, ...createSession(db, id, ctx, now) };
    });
  } catch (err) {
    if (isDuplicateEmail(err)) return { ok: false, error: EXISTS }; // another process won the race
    throw err;
  }
}

export async function login(db: DatabaseSync, input: { email: string; password: string }, ctx: Ctx): Promise<LoggedIn | Failure> {
  const now = ctx.now ?? Date.now();
  const email = normalizeEmail(input.email);
  const acctKey = acctThrottleKey(email ?? input.email);
  const keys = [acctKey, ...(ctx.ip ? [`login:ip:${ipKey(ctx.ip)}`] : [])];

  const blocked = Math.max(...keys.map((k) => retryAfter(db, k, now)));
  if (blocked > 0) return { ok: false, error: wait(blocked) };
  // Too many hashes already waiting (a flood of logins for different emails): refuse before this attempt is counted,
  // so the flood cannot also lock real accounts. The answer does not depend on the email.
  if (hashQueueFull()) return { ok: false, error: BUSY };
  // Count this attempt now, before the slow hash, so a burst of concurrent guesses cannot all pass the
  // check above while the count is still zero. It is taken back on success.
  for (const k of keys) recordFailure(db, k, now);

  const user = email ? findUserByEmail(db, email) : undefined;
  const valid = user ? await verifyPassword(input.password, user.password_hash) : (await verifyDummy(input.password), false);

  // Rehashing is slow too, so do it before the last read: from there to the new session there must be no await,
  // or MFA could be switched on in between and the session would be created without the second factor.
  // A full queue only skips the rehash: the password was right, and the next login tries again.
  const rehash =
    user && valid && needsRehash(user.password_hash)
      ? await hashPassword(input.password).catch((e: unknown) => {
          if (e instanceof HashQueueFull) return null;
          throw e;
        })
      : null;

  // The hashes above are slow. Re-read the row so a password reset, a disable or a newly enabled MFA that landed
  // meanwhile still wins. The re-read and the new session are ONE transaction: another process (the break-glass
  // command) can write between two statements, so "no await in between" is not enough.
  const session = user && valid
    ? transaction(db, () => {
        const fresh = findUserById(db, user.id);
        if (!fresh || fresh.password_hash !== user.password_hash || fresh.disabled_at !== null) return null;
        resetFailures(db, acctKey);
        for (const k of keys.slice(1)) releaseFailure(db, k);
        if (rehash) db.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?").run(rehash, user.id, user.password_hash);
        purgeExpired(db, now);
        audit(db, { action: "login.success", actor: user.id, target: user.id, ip: ctx.ip }, now);
        // With MFA the session starts pending: it proves the password only and grants nothing until the code is entered.
        return createSession(db, user.id, { ...ctx, mfaPending: fresh.mfa_enabled_at !== null }, now);
      })
    : null;

  if (!session) {
    // Only real accounts are audited: the log is append-only, so unknown emails must not be able to grow it.
    if (user) audit(db, { action: "login.failed", target: user.id, ip: ctx.ip, detail: { disabled: findUserById(db, user.id)?.disabled_at != null && valid } }, now);
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }
  return { ok: true, ...session };
}

export function logout(db: DatabaseSync, token: string, ctx: Ctx): void {
  const now = ctx.now ?? Date.now();
  const session = validateSession(db, token, now);
  deleteSession(db, token);
  if (session) audit(db, { action: "logout", actor: session.userId, target: session.userId, ip: ctx.ip }, now);
}

export async function changePassword(
  db: DatabaseSync,
  token: string,
  input: { current: string; next: string },
  ctx: Ctx,
): Promise<{ ok: true } | Failure> {
  const now = ctx.now ?? Date.now();
  const session = validateSession(db, token, now);
  // A session that has only passed the password grants nothing, or the second factor would protect nothing.
  if (!session || session.mfaPending) return { ok: false, error: "Your session has ended. Log in again." };
  const user = findUserById(db, session.userId)!;

  const key = `login:chpw:${user.id}`;
  const blocked = retryAfter(db, key, now);
  if (blocked > 0) return { ok: false, error: wait(blocked) };
  recordFailure(db, key, now); // counted before the slow check, like login; cleared on success
  if (!(await verifyPassword(input.current, user.password_hash))) {
    audit(db, { action: "password.change_failed", actor: user.id, target: user.id, ip: ctx.ip }, now);
    return { ok: false, error: "The current password is wrong." };
  }
  resetFailures(db, key);

  const policy = checkPassword(input.next, user.email);
  if (policy) return { ok: false, error: policy };
  // Hashing normalises (NFKC), so compare the same way or look-alike passwords slip through.
  if (input.next.normalize("NFKC") === input.current.normalize("NFKC")) return { ok: false, error: "Choose a password different from the current one." };

  const newHash = await hashPassword(input.next);
  const done = transaction(db, () => {
    // The hash above is slow: an admin's or the break-glass command's reset can land meanwhile. If the password is
    // no longer the one that was verified, or this session was ended, the change is refused instead of undoing it.
    const current = findUserById(db, user.id);
    const alive = db.prepare("SELECT 1 AS ok FROM sessions WHERE id_hash = ?").get(session.tokenHash);
    if (!current || !alive || current.password_hash !== user.password_hash) return false;
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(newHash, user.id);
    revokeSessions(db, user.id, session.tokenHash);
    audit(db, { action: "password.changed", actor: user.id, target: user.id, ip: ctx.ip }, now);
    return true;
  });
  return done ? { ok: true } : { ok: false, error: "Your session has ended. Log in again." };
}

export type SeedResult = "seeded" | "no-config" | "admin-exists" | "email-taken";

/**
 * Creates the first admin from ADMIN_EMAIL/ADMIN_PASSWORD, only when no admin exists. It never touches an
 * existing account. Remove ADMIN_PASSWORD from .env after the first start: while no admin exists (for example
 * after the only one was deleted) the variable would create one again.
 */
export async function seedAdmin(db: DatabaseSync, admin: { email: string; password: string } | null, now = Date.now()): Promise<SeedResult> {
  if (!admin) return "no-config";
  if (countAdmins(db) > 0) return "admin-exists";
  if (findUserByEmail(db, admin.email)) return "email-taken";
  const problem = checkPassword(admin.password, admin.email);
  if (problem) throw new Error(`ADMIN_PASSWORD rejected: ${problem}`);

  const passwordHash = await hashPassword(admin.password);
  // One transaction: a crash between the user and the role would leave an account that blocks reseeding.
  return transaction(db, (): SeedResult => {
    if (countAdmins(db) > 0) return "admin-exists";
    if (findUserByEmail(db, admin.email)) return "email-taken";
    const id = createUser(db, { email: admin.email, passwordHash, mustChangePassword: true, verified: true }, now);
    grantRole(db, id, "admin", null, now);
    audit(db, { action: "admin.seeded", target: id }, now);
    return "seeded";
  });
}
