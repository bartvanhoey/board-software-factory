// No "server-only" or next/* imports: the break-glass CLI runs this outside Next, inside the web container.
//
// Access to the server is the authorisation here: whoever can run the command can use it, so there is no login
// and no actor. What it leaves behind is an audit entry per change (no actor, `via: "cli"`, the reason, the operator
// name the person gave and the container it ran in). The operator name is a label, not proof: nothing inside the
// container can tell who sits at the Docker host. For that, the host's own `docker events` or auditd show the exec.
import type { DatabaseSync } from "node:sqlite";
import { generateTemporaryPassword } from "./admin";
import { audit } from "./audit";
import { transaction } from "./db";
import { clearMfa } from "./mfa";
import { hashPassword } from "./password";
import { acctThrottleKey } from "./service";
import { revokeSessions } from "./sessions";
import { resetFailures } from "./throttle";
import { findUserByEmail, normalizeEmail, type UserRow } from "./users";

export type Outcome<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export const REASON_MAX = 200;
export const OPERATOR_MAX = 64;

/**
 * One line, trimmed, at most `max` characters, some real letter or digit in it, and no control, line-separator or
 * invisible formatting characters (bidi overrides, zero-width): it ends up in the audit log, and it must not be able
 * to disguise itself there. Null when it does not qualify.
 */
function cleanLine(raw: string, max: number): string | null {
  const text = raw.trim();
  if (text.length < 1 || text.length > max) return null;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) return null;
  return /[\p{L}\p{N}]/u.test(text) ? text : null;
}

/** Why this is being done, at most REASON_MAX characters (see cleanLine). Null when it does not qualify. */
export function cleanReason(raw: string): string | null {
  return cleanLine(raw, REASON_MAX);
}

/** Who says they are doing it, at most OPERATOR_MAX characters (see cleanLine). Self-declared, so a label only. */
export function cleanOperator(raw: string): string | null {
  return cleanLine(raw, OPERATOR_MAX);
}

export interface Who {
  /** The operator's own name for themselves. Left out of the audit entry when not given. */
  operator?: string;
  /** Where it ran (the container's hostname), to match the entry against the Docker host's own logs. */
  container?: string;
}

/** The audit detail: how, why, and who and where when known. */
function detailOf(reason: string, operator: string | undefined, container: string | undefined): Record<string, string> {
  return { via: "cli", reason, ...(operator ? { operator } : {}), ...(container ? { container } : {}) };
}

function find(db: DatabaseSync, rawEmail: string): { ok: true; user: UserRow } | { ok: false; error: string } {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, error: "That is not a valid email address." };
  const user = findUserByEmail(db, email);
  return user ? { ok: true, user } : { ok: false, error: `No account with the email ${email}.` };
}

const NEEDS_REASON = `A reason is required (1 to ${REASON_MAX} characters, one line).`;
const BAD_OPERATOR = `--operator (or the OPERATOR variable) must be one line of 1 to ${OPERATOR_MAX} characters, without control or invisible characters.`;

export interface ResetMfaResult {
  email: string;
  /** False when the account had no MFA at all: nothing was touched (not even its sessions) and nothing was audited. */
  changed: boolean;
  disabled: boolean;
  /** MFA is required for this account (an admin, or the flag is on), so they must set it up again at next login. */
  mustSetUpAgain: boolean;
}

/**
 * Removes a user's MFA (secret, pending setup, recovery codes, attempt counter) and ends all their sessions.
 * Works on administrators, which is the one thing the web app refuses to do.
 */
export function resetMfaByCli(db: DatabaseSync, input: { email: string; reason: string } & Who, now = Date.now()): Outcome<ResetMfaResult> {
  const reason = cleanReason(input.reason);
  if (!reason) return { ok: false, error: NEEDS_REASON };
  const operator = input.operator === undefined ? undefined : cleanOperator(input.operator);
  if (operator === null) return { ok: false, error: BAD_OPERATOR };
  const found = find(db, input.email);
  if (!found.ok) return found;

  return transaction(db, (): Outcome<ResetMfaResult> => {
    const user = findUserByEmail(db, found.user.email)!; // re-read inside the lock
    const base = { email: user.email, disabled: user.disabled_at !== null, mustSetUpAgain: user.mfa_required === 1 };
    // Any trace counts, not only a finished enrolment: a half-finished one (a pending secret on a stolen session)
    // is exactly what an operator mid-incident wants gone, together with the sessions.
    const hasTrace =
      user.mfa_enabled_at !== null ||
      user.mfa_secret_enc !== null ||
      db.prepare("SELECT 1 AS x FROM mfa_setup WHERE user_id = ?").get(user.id) !== undefined ||
      db.prepare("SELECT 1 AS x FROM recovery_codes WHERE user_id = ?").get(user.id) !== undefined;
    if (!hasTrace) return { ok: true, changed: false, ...base };
    clearMfa(db, user.id);
    revokeSessions(db, user.id);
    audit(db, { action: "mfa.reset_by_cli", target: user.id, detail: detailOf(reason, operator, input.container) }, now);
    return { ok: true, changed: true, ...base };
  });
}

export interface ResetPasswordResult {
  email: string;
  /** Shown once to whoever ran the command. Never stored, logged or audited. */
  temporaryPassword: string;
  disabled: boolean;
  /** The account has MFA, so the first login also asks for a code. */
  hasMfa: boolean;
}

/**
 * Sets a temporary password that must be changed at next login, ends all sessions and clears the login throttle.
 * Does not touch MFA: a lost password alone must not remove a second factor (use reset-mfa for that).
 */
export async function resetPasswordByCli(db: DatabaseSync, input: { email: string; reason: string } & Who, now = Date.now()): Promise<Outcome<ResetPasswordResult>> {
  const reason = cleanReason(input.reason);
  if (!reason) return { ok: false, error: NEEDS_REASON };
  const operator = input.operator === undefined ? undefined : cleanOperator(input.operator);
  if (operator === null) return { ok: false, error: BAD_OPERATOR };
  const found = find(db, input.email);
  if (!found.ok) return found;

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword); // slow, so before the write lock

  return transaction(db, (): Outcome<ResetPasswordResult> => {
    const user = findUserByEmail(db, found.user.email)!;
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(passwordHash, user.id);
    revokeSessions(db, user.id);
    // Otherwise earlier failed attempts could still be delaying the very login the temporary password is for.
    resetFailures(db, acctThrottleKey(user.email));
    resetFailures(db, `login:chpw:${user.id}`);
    audit(db, { action: "password.reset_by_cli", target: user.id, detail: detailOf(reason, operator, input.container) }, now);
    return { ok: true, email: user.email, temporaryPassword, disabled: user.disabled_at !== null, hasMfa: user.mfa_enabled_at !== null };
  });
}
