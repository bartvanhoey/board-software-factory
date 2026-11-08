// No "server-only" or next/* imports: the testable core of email verification and password reset by email.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "./audit";
import { transaction } from "./db";
import { consumeToken, discardToken, issueToken, peekToken, voidOtherTokens, voidTokens } from "./email-tokens";
import type { Mail, Mailer } from "./mail";
import { hashPassword } from "./password";
import { checkPassword } from "./policy";
import { ipKey } from "./request";
import { acctThrottleKey } from "./service";
import { revokeSessions } from "./sessions";
import { consume, resetFailures } from "./throttle";
import { findUserByEmail, findUserById, normalizeEmail } from "./users";

export interface MailEnv {
  mailer: Mailer;
  /** The site's own public address (config). Links are built from this and never from a request. */
  appUrl: string;
}

export interface MailCtx {
  /** Null unless TRUST_PROXY is on. */
  ip: string | null;
  now?: number;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const MINUTE = 60_000;
const HOUR = 3_600_000;
export const PER_ADDRESS_PER_HOUR = 5;
export const PER_IP_PER_HOUR = 10;
/**
 * How many mails an hour each kind may send in total. Two budgets, so a stranger using up the one for "forgot password"
 * cannot stop new registrations and resends, and the other way round. They protect the relay's quota and strangers'
 * inboxes; they are also a lever for denial of service, which the README says.
 */
export const BUDGET_PER_HOUR = 40;

export const INVALID_LINK = "This link is invalid or has expired. Ask for a new one.";
const RESET_BUDGET = "mail:budget:reset";
const VERIFY_BUDGET = "mail:budget:verify";

export function verificationMail(appUrl: string, to: string, token: string): Mail {
  return {
    to,
    subject: "Confirm your email address",
    text: [
      "Someone, hopefully you, used this address for the Software Factory dashboard.",
      "",
      "To confirm it, log in to that account and then open this link:",
      `${appUrl}/verify?token=${token}`,
      "",
      "The link works once and expires in 24 hours.",
      "If you did NOT create an account, do not log in and do not open the link: ignore this message. Nothing happens unless the link is opened by someone who is logged in to the account.",
    ].join("\n"),
  };
}

export function resetMail(appUrl: string, to: string, token: string): Mail {
  return {
    to,
    subject: "Reset your password",
    text: [
      "A password reset was requested for your Software Factory dashboard account.",
      "",
      "Choose a new password by opening this link:",
      `${appUrl}/reset-password?token=${token}`,
      "",
      "The link works once and expires in 1 hour. If you did not ask for this, ignore this message: your password stays as it is.",
    ].join("\n"),
  };
}

type Allowed = "ok" | "slow" | "busy";

/**
 * Per-IP (when known) and per-address limits first, the shared budget LAST: a request that is refused for being too
 * frequent must not use up the budget everyone else shares.
 */
function allow(db: DatabaseSync, ctx: MailCtx, addressKey: string, budgetKey: string, now: number): Allowed {
  if (ctx.ip && !consume(db, `mail:ip:${ipKey(ctx.ip)}`, PER_IP_PER_HOUR, HOUR, now)) return "slow";
  if (!consume(db, `${addressKey}:min`, 1, MINUTE, now)) return "slow";
  if (!consume(db, `${addressKey}:hour`, PER_ADDRESS_PER_HOUR, HOUR, now)) return "slow";
  return consume(db, budgetKey, BUDGET_PER_HOUR, HOUR, now) ? "ok" : "busy";
}

/** What a relay says often includes the address ("550 <person@example.com> ..."): never let that reach a log. */
const redact = (text: string): string => text.replace(/[^\s<>"',;()]+@[^\s<>"',;()]+/g, "<address>");

function logFailure(db: DatabaseSync, kind: "verify" | "reset", userId: string, err: unknown, now: number): void {
  // The error's code and message only (a refused connection has an empty message, so the code says why), with any
  // address blanked out. Never the link or anything else about the mail.
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";
  const text = err instanceof Error ? [code, err.message].filter(Boolean).join(" ") || err.name : "unknown error";
  console.error(`[mail] ${kind} email failed: ${redact(text)}`);
  try {
    audit(db, { action: "email.send_failed", target: userId, detail: { kind } }, now);
  } catch {
    /* the database may be closing; the log line above is enough */
  }
}

/**
 * Sends (or re-sends) the link that confirms a user's address. Awaits the send, so the person who asked is told if it
 * failed; that is fine here, they are logged in and the address is their own. An older link keeps working until the
 * new one has really been sent, and nothing is recorded as "sent" before it was.
 */
export async function sendVerification(db: DatabaseSync, env: MailEnv, userId: string, ctx: MailCtx): Promise<Result> {
  const now = ctx.now ?? Date.now();
  const user = findUserById(db, userId);
  if (!user || user.disabled_at !== null) return { ok: false, error: "This account cannot be confirmed." };
  if (user.email_verified_at !== null) return { ok: false, error: "This address is already confirmed." };
  const allowed = allow(db, ctx, `mail:verify:${userId}`, VERIFY_BUDGET, now);
  if (allowed === "slow") return { ok: false, error: "Please wait a while before asking for another email." };
  if (allowed === "busy") return { ok: false, error: "Email is very busy right now. Try again in a little while." };

  const token = issueToken(db, userId, "verify", now, true);
  try {
    await env.mailer.send(verificationMail(env.appUrl, user.email, token));
  } catch (err) {
    discardToken(db, token, "verify");
    logFailure(db, "verify", userId, err, now);
    return { ok: false, error: "We could not send the email. Try again in a little while, or ask an administrator." };
  }
  voidOtherTokens(db, userId, "verify", token);
  audit(db, { action: "email.verification_sent", actor: userId, target: userId, ip: ctx.ip }, now);
  return { ok: true };
}

/**
 * Uses the verification link up and marks the address confirmed, but only for a user who is logged in as that account.
 * Otherwise someone could register an address that is not theirs with a password they know, and the real owner opening
 * the link in their inbox would confirm the squatter's account for them. Needing both the inbox and the password
 * closes that: the owner cannot log in to the squatted account, so the link does nothing for them (they use
 * "forgot password", which replaces the password). It does not log anyone in.
 */
export function confirmEmail(db: DatabaseSync, token: string, sessionUserId: string, ctx: MailCtx): Result {
  const now = ctx.now ?? Date.now();
  return transaction(db, (): Result => {
    const peeked = peekToken(db, token, "verify", now);
    if (!peeked || peeked.userId !== sessionUserId) return { ok: false, error: INVALID_LINK }; // checked first: a wrong login must not burn the link
    const hit = consumeToken(db, token, "verify", now);
    if (!hit) return { ok: false, error: INVALID_LINK };
    db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL").run(now, hit.userId);
    audit(db, { action: "email.verified", actor: hit.userId, target: hit.userId, ip: ctx.ip }, now);
    return { ok: true };
  });
}

function processResetRequest(db: DatabaseSync, env: MailEnv, rawEmail: string, ctx: MailCtx): void {
  const now = ctx.now ?? Date.now();
  const email = normalizeEmail(rawEmail);
  if (!email) return;
  // An unknown or disabled address costs nothing beyond this lookup: no limit rows and no budget are used for it, so
  // strangers' input cannot grow the throttle table or spend the shared budget. The caller sees no difference.
  const user = findUserByEmail(db, email);
  if (!user || user.disabled_at !== null) return;
  if (allow(db, ctx, `mail:reset:${acctThrottleKey(email)}`, RESET_BUDGET, now) !== "ok") return;

  const token = issueToken(db, user.id, "reset", now);
  audit(db, { action: "password.reset_requested", target: user.id, ip: ctx.ip }, now);
  void env.mailer.send(resetMail(env.appUrl, user.email, token)).catch((err: unknown) => logFailure(db, "reset", user.id, err, now));
}

/**
 * "Forgot password". Says nothing about the outcome, on purpose: whether the address has an account, whether a mail was
 * sent and whether a limit was hit all look the same to the caller, who shows one fixed message. Everything that depends
 * on the account is done AFTER this returns, so the response time does not show whether the account exists (the
 * difference is a few milliseconds of local work; this is not a hard guarantee against many careful measurements).
 * Only real accounts are audited.
 */
export function requestPasswordReset(db: DatabaseSync, env: MailEnv, rawEmail: string, ctx: MailCtx): void {
  setImmediate(() => {
    try {
      processResetRequest(db, env, rawEmail, ctx);
    } catch (err) {
      console.error(`[mail] reset request failed: ${redact(err instanceof Error ? err.message : "unknown error")}`);
    }
  });
}

/**
 * Sets a new password from a reset link. The password is checked BEFORE the link is spent, so a weak one does not
 * burn it. The reset ends all the user's sessions and does not touch their MFA: the next login still asks for a code.
 * Reaching this link also proves the inbox, so the address counts as confirmed.
 */
export async function resetPasswordWithToken(db: DatabaseSync, token: string, newPassword: string, ctx: MailCtx): Promise<Result> {
  const now = ctx.now ?? Date.now();
  const peeked = peekToken(db, token, "reset", now);
  const user = peeked ? findUserById(db, peeked.userId) : undefined;
  if (!peeked || !user || user.disabled_at !== null) return { ok: false, error: INVALID_LINK };

  const weak = checkPassword(newPassword, user.email);
  if (weak) return { ok: false, error: weak };

  const passwordHash = await hashPassword(newPassword);
  return transaction(db, (): Result => {
    const hit = consumeToken(db, token, "reset", now);
    const current = hit ? findUserById(db, hit.userId) : undefined;
    if (!hit || !current || current.disabled_at !== null) return { ok: false, error: INVALID_LINK };

    // (A database trigger also ends every other unused reset link whenever a password changes, by any route.)
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").run(passwordHash, now, current.id);
    revokeSessions(db, current.id);
    // Failed attempts must not keep delaying the first login with the new password.
    resetFailures(db, acctThrottleKey(current.email));
    resetFailures(db, `login:chpw:${current.id}`);
    voidTokens(db, current.id, "reset");
    voidTokens(db, current.id, "verify");
    audit(db, { action: "password.reset_by_email", actor: current.id, target: current.id, ip: ctx.ip }, now);
    return { ok: true };
  });
}
