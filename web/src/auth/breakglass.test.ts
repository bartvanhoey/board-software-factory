import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanOperator, cleanReason, OPERATOR_MAX, REASON_MAX, resetMfaByCli, resetPasswordByCli } from "./breakglass";
import { openDb } from "./db";
import { confirmSetup, pendingSetup, proveFactor } from "./mfa";
import { decryptSecret } from "./mfa-crypto";
import { hashParams } from "./password";
import { login } from "./service";
import { createSession, validateSession } from "./sessions";
import { recordFailure } from "./throttle";
import { totp } from "./totp";
import { acctThrottleKey } from "./service";
import { createUser, grantRole, hasRole, rolesOf, type Role } from "./users";

const prod = { ...hashParams };
beforeAll(() => Object.assign(hashParams, { N: 2 ** 10, r: 8, p: 1 }));
afterAll(() => Object.assign(hashParams, prod));

const KEY = randomBytes(32);
const T0 = 1_700_000_010_000;
const STEP = 30_000;
const REASON = "lost phone, ticket 42";

let db: ReturnType<typeof openDb>;

const actions = () => (db.prepare("SELECT action FROM audit_log ORDER BY id").all() as { action: string }[]).map((r) => r.action);

function user(email: string, roles: Role[] = [], password = "a long test passphrase 7"): string {
  const id = createUser(db, { email, passwordHash: "x" }, T0);
  for (const r of roles) grantRole(db, id, r, null, T0);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(`scrypt$1024$8$1$${Buffer.from(password).toString("base64url")}$bad`, id);
  return id;
}

/** A user with a working password and real MFA, set up through the same code the app uses. */
async function realUser(email: string, roles: Role[] = []): Promise<{ id: string; secret: Buffer; codes: string[]; token: string }> {
  const { register } = await import("./service");
  const r = await register(db, { email, password: "a long test passphrase 7" }, { ip: null, userAgent: null, now: T0 });
  if (!r.ok) throw new Error(r.error);
  const id = (db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
  for (const role of roles) grantRole(db, id, role, null, T0);
  const session = { tokenHash: validateSession(db, r.token, T0)!.tokenHash, userId: id };
  pendingSetup(db, KEY, id, session.tokenHash, T0);
  const secret = decryptSecret(KEY, (db.prepare("SELECT secret_enc AS s FROM mfa_setup WHERE user_id = ?").get(id) as { s: string }).s, id);
  const done = confirmSetup(db, KEY, session, totp(secret, T0), { ip: null, now: T0 });
  if (!done.ok) throw new Error(done.error);
  return { id, secret, codes: done.recoveryCodes, token: r.token };
}

beforeEach(() => {
  db = openDb(":memory:");
});

describe("cleanReason", () => {
  it("accepts one line of up to 200 characters, trimmed", () => {
    expect(cleanReason("  lost phone  ")).toBe("lost phone");
    expect(cleanReason("x".repeat(REASON_MAX))).toHaveLength(REASON_MAX);
  });

  it("rejects empty, too long and multi-line reasons", () => {
    for (const bad of ["", "   ", "x".repeat(REASON_MAX + 1), "two\nlines", "tab\there", "nul\u0000"]) expect(cleanReason(bad)).toBeNull();
  });

  it("rejects characters that could disguise an entry in the audit log: C1 controls, line separators, bidi overrides, zero-width", () => {
    for (const bad of ["lost\u009b2Jphone", "a\u2028b", "a\u2029b", "evil\u202Egnp.exe", "wrap\u2066x\u2069", "ze\u200Bro", "ze\u200Dro", "mid\ufeffdle"]) {
      expect(cleanReason(bad)).toBeNull();
    }
  });

  it("needs something readable in it: only punctuation or only invisible characters is not a reason", () => {
    for (const bad of ["!!!", "---", "...", "\u200B"]) expect(cleanReason(bad)).toBeNull();
  });

  it("accepts ordinary text in any language, with punctuation", () => {
    for (const ok of ["lost phone, ticket #42", "päivä 42 — puhelin hukattu", "紛失した電話", "--- ticket 42"]) expect(cleanReason(ok)).toBe(ok);
  });
});

describe("cleanOperator", () => {
  it("accepts a short name, trimmed, in any language", () => {
    expect(cleanOperator("  bart  ")).toBe("bart");
    expect(cleanOperator("x".repeat(OPERATOR_MAX))).toHaveLength(OPERATOR_MAX);
    for (const ok of ["Bart V.", "päivi", "紛失", "ops-team/oncall"]) expect(cleanOperator(ok)).toBe(ok);
  });

  it("rejects empty, too long, multi-line, invisible or unreadable names: it ends up in the audit log", () => {
    for (const bad of ["", "   ", "x".repeat(OPERATOR_MAX + 1), "two\nlines", "tab\there", "nul\u0000", "evil‮name", "zero​width", "line sep", "!!!"])
      expect(cleanOperator(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("who is recorded in the audit entry", () => {
  const detail = (action: string) => JSON.parse((db.prepare("SELECT detail FROM audit_log WHERE action = ?").get(action) as { detail: string }).detail);

  it("adds the operator and the container to a reset-mfa entry, and cleans the operator", async () => {
    await realUser("person@example.com");
    resetMfaByCli(db, { email: "person@example.com", reason: REASON, operator: "  Bart V  ", container: "c0ffee" }, T0 + STEP);
    expect(detail("mfa.reset_by_cli")).toEqual({ via: "cli", reason: REASON, operator: "Bart V", container: "c0ffee" });
  });

  it("adds them to a reset-password entry too", async () => {
    await realUser("person@example.com");
    const r = await resetPasswordByCli(db, { email: "person@example.com", reason: REASON, operator: "Dana", container: "abc123" }, T0 + STEP);
    expect(r.ok).toBe(true);
    expect(detail("password.reset_by_cli")).toEqual({ via: "cli", reason: REASON, operator: "Dana", container: "abc123" });
  });

  it("refuses an unusable operator before touching anything, for both commands", async () => {
    const u = await realUser("person@example.com");
    const sessionsBefore = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(u.id);
    const auditBefore = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get();
    for (const operator of ["two\nlines", "x".repeat(OPERATOR_MAX + 1), "evil‮name", ""]) {
      const a = resetMfaByCli(db, { email: "person@example.com", reason: REASON, operator }, T0 + STEP);
      expect(a, JSON.stringify(operator)).toMatchObject({ ok: false, error: expect.stringContaining("--operator") });
      const b = await resetPasswordByCli(db, { email: "person@example.com", reason: REASON, operator }, T0 + STEP);
      expect(b, JSON.stringify(operator)).toMatchObject({ ok: false, error: expect.stringContaining("--operator") });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual(auditBefore);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(u.id)).toEqual(sessionsBefore);
  });
});

describe("resetMfaByCli", () => {
  it("removes an administrator's MFA, which the web app refuses to do, and ends their sessions", async () => {
    const admin = await realUser("admin@example.com", ["admin"]);
    expect(hasRole(rolesOf(db, admin.id), "admin")).toBe(true);

    const r = resetMfaByCli(db, { email: "admin@example.com", reason: REASON }, T0 + STEP);
    expect(r).toEqual({ ok: true, changed: true, email: "admin@example.com", disabled: false, mustSetUpAgain: false });
    expect(db.prepare("SELECT mfa_enabled_at, mfa_secret_enc, mfa_last_step FROM users WHERE id = ?").get(admin.id)).toEqual({ mfa_enabled_at: null, mfa_secret_enc: null, mfa_last_step: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?").get(admin.id)).toEqual({ n: 0 });
    expect(validateSession(db, admin.token, T0 + STEP)).toBeNull();
  });

  it("makes the old authenticator and the old recovery codes useless", async () => {
    const u = await realUser("person@example.com");
    resetMfaByCli(db, { email: "person@example.com", reason: REASON }, T0 + STEP);
    expect(proveFactor(db, KEY, u.id, totp(u.secret, T0 + 2 * STEP), { ip: null, now: T0 + 2 * STEP }).ok).toBe(false);
    expect(proveFactor(db, KEY, u.id, u.codes[0]!, { ip: null, now: T0 + 2 * STEP }).ok).toBe(false);
  });

  it("clears the MFA attempt counter so the user is not locked out of setting it up again", async () => {
    const u = await realUser("person@example.com");
    for (let i = 0; i < 6; i++) proveFactor(db, KEY, u.id, "000000", { ip: null, now: T0 + STEP });
    expect(db.prepare("SELECT COUNT(*) AS n FROM throttle WHERE key = ?").get(`mfa:${u.id}`)).toEqual({ n: 1 });
    resetMfaByCli(db, { email: "person@example.com", reason: REASON }, T0 + STEP);
    expect(db.prepare("SELECT COUNT(*) AS n FROM throttle WHERE key = ?").get(`mfa:${u.id}`)).toEqual({ n: 0 });
  });

  it("audits with no actor, the target, how it was done and why", async () => {
    const u = await realUser("person@example.com");
    resetMfaByCli(db, { email: "person@example.com", reason: REASON }, T0 + STEP);
    expect(db.prepare("SELECT actor_user_id, target_user_id, detail FROM audit_log WHERE action = 'mfa.reset_by_cli'").get()).toEqual({
      actor_user_id: null,
      target_user_id: u.id,
      detail: JSON.stringify({ via: "cli", reason: REASON }),
    });
  });

  it("says whether the user has to set MFA up again: only when it is required for them", async () => {
    await realUser("plain@example.com");
    expect(resetMfaByCli(db, { email: "plain@example.com", reason: REASON }, T0 + STEP)).toMatchObject({ changed: true, mustSetUpAgain: false });
    await realUser("flagged@example.com");
    db.prepare("UPDATE users SET mfa_required = 1 WHERE email = 'flagged@example.com'").run();
    expect(resetMfaByCli(db, { email: "flagged@example.com", reason: REASON }, T0 + STEP)).toMatchObject({ changed: true, mustSetUpAgain: true });
  });

  it("changes and audits nothing for an account that has no MFA at all, and leaves its sessions alone", () => {
    const id = user("person@example.com");
    const { token } = createSession(db, id, {}, T0);
    expect(resetMfaByCli(db, { email: "person@example.com", reason: REASON })).toMatchObject({ ok: true, changed: false });
    expect(actions()).toEqual([]);
    expect(validateSession(db, token, T0)).not.toBeNull();
  });

  it("still cleans up a half-finished enrolment: a pending secret and the sessions go, and it is audited", () => {
    // e.g. someone mid-enrolment on a stolen session: MFA was never turned on, but there are traces
    const id = user("person@example.com");
    const { token } = createSession(db, id, {}, T0);
    const s = { tokenHash: validateSession(db, token, T0)!.tokenHash };
    pendingSetup(db, KEY, id, s.tokenHash, T0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM mfa_setup").get()).toEqual({ n: 1 });

    expect(resetMfaByCli(db, { email: "person@example.com", reason: REASON }, T0 + STEP)).toMatchObject({ ok: true, changed: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM mfa_setup").get()).toEqual({ n: 0 });
    expect(validateSession(db, token, T0 + STEP)).toBeNull();
    expect(actions()).toEqual(["mfa.reset_by_cli"]);
  });

  it("treats leftover recovery codes or a leftover secret as MFA too", () => {
    const a = user("a@example.com");
    db.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, 'h')").run(a);
    expect(resetMfaByCli(db, { email: "a@example.com", reason: REASON })).toMatchObject({ changed: true });
    const b = user("b@example.com");
    db.prepare("UPDATE users SET mfa_secret_enc = 'v1.x.y.z' WHERE id = ?").run(b);
    expect(resetMfaByCli(db, { email: "b@example.com", reason: REASON })).toMatchObject({ changed: true });
  });

  it("works on a disabled account and says so", async () => {
    await realUser("gone@example.com");
    db.prepare("UPDATE users SET disabled_at = ? WHERE email = 'gone@example.com'").run(T0);
    expect(resetMfaByCli(db, { email: "gone@example.com", reason: REASON }, T0 + STEP)).toMatchObject({ ok: true, changed: true, disabled: true });
  });

  it("finds the account whatever case and spacing the email was typed in", async () => {
    await realUser("person@example.com");
    expect(resetMfaByCli(db, { email: "  Person@Example.COM ", reason: REASON }, T0 + STEP)).toMatchObject({ ok: true, changed: true });
  });

  it("refuses a missing reason, an unknown account and a malformed email, and touches nothing", async () => {
    await realUser("person@example.com");
    expect(resetMfaByCli(db, { email: "person@example.com", reason: "" })).toEqual({ ok: false, error: expect.stringContaining("reason is required") });
    expect(resetMfaByCli(db, { email: "nobody@example.com", reason: REASON })).toEqual({ ok: false, error: "No account with the email nobody@example.com." });
    expect(resetMfaByCli(db, { email: "not an email", reason: REASON })).toEqual({ ok: false, error: "That is not a valid email address." });
    expect((db.prepare("SELECT mfa_enabled_at FROM users WHERE email = 'person@example.com'").get() as { mfa_enabled_at: number | null }).mfa_enabled_at).not.toBeNull();
  });
});

describe("resetPasswordByCli", () => {
  it("sets a temporary password that logs in, forces a change, and replaces the old password", async () => {
    await realUser("person@example.com");
    db.prepare("UPDATE users SET mfa_enabled_at = NULL, mfa_secret_enc = NULL WHERE email = 'person@example.com'").run(); // plain account
    const r = await resetPasswordByCli(db, { email: "person@example.com", reason: REASON }, T0 + STEP);
    if (!r.ok) throw new Error(r.error);
    expect(r.temporaryPassword).toHaveLength(16);

    const ctx = { ip: null, userAgent: null, now: T0 + 2 * STEP };
    expect(await login(db, { email: "person@example.com", password: "a long test passphrase 7" }, ctx)).toMatchObject({ ok: false });
    const again = await login(db, { email: "person@example.com", password: r.temporaryPassword }, { ...ctx, now: T0 + 3 * STEP });
    if (!again.ok) throw new Error("temporary password rejected");
    expect(validateSession(db, again.token, T0 + 3 * STEP)!.mustChangePassword).toBe(true);
  });

  it("works for a sole administrator who lost their password, and ends their sessions", async () => {
    const admin = await realUser("admin@example.com", ["admin"]);
    const r = await resetPasswordByCli(db, { email: "admin@example.com", reason: REASON }, T0 + STEP);
    expect(r).toMatchObject({ ok: true, email: "admin@example.com", disabled: false, hasMfa: true });
    expect(validateSession(db, admin.token, T0 + STEP)).toBeNull();
  });

  it("does not touch MFA: a lost password alone must not remove the second factor", async () => {
    const u = await realUser("person@example.com");
    await resetPasswordByCli(db, { email: "person@example.com", reason: REASON }, T0 + STEP);
    expect((db.prepare("SELECT mfa_enabled_at, mfa_secret_enc FROM users WHERE id = ?").get(u.id) as { mfa_enabled_at: number | null; mfa_secret_enc: string | null }).mfa_enabled_at).not.toBeNull();
    expect(proveFactor(db, KEY, u.id, totp(u.secret, T0 + 2 * STEP), { ip: null, now: T0 + 2 * STEP }).ok).toBe(true);
  });

  it("clears the login throttle so earlier failures cannot delay the first login with the new password", async () => {
    const u = await realUser("person@example.com");
    for (let i = 0; i < 8; i++) recordFailure(db, acctThrottleKey("person@example.com"), T0);
    recordFailure(db, `login:chpw:${u.id}`, T0);
    await resetPasswordByCli(db, { email: "person@example.com", reason: REASON }, T0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM throttle WHERE key LIKE 'login:%'").get()).toEqual({ n: 0 });
  });

  it("audits with no actor, how and why, and keeps the plaintext out of the database and the log", async () => {
    const u = await realUser("person@example.com");
    const r = await resetPasswordByCli(db, { email: "person@example.com", reason: REASON }, T0 + STEP);
    if (!r.ok) throw new Error(r.error);
    expect(db.prepare("SELECT actor_user_id, target_user_id, detail FROM audit_log WHERE action = 'password.reset_by_cli'").get()).toEqual({
      actor_user_id: null,
      target_user_id: u.id,
      detail: JSON.stringify({ via: "cli", reason: REASON }),
    });
    const dump = JSON.stringify(db.prepare("SELECT * FROM audit_log").all()) + JSON.stringify(db.prepare("SELECT * FROM users").all());
    expect(dump).not.toContain(r.temporaryPassword);
  });

  it("gives a different password every time", async () => {
    user("person@example.com");
    const a = await resetPasswordByCli(db, { email: "person@example.com", reason: REASON });
    const b = await resetPasswordByCli(db, { email: "person@example.com", reason: REASON });
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(a.temporaryPassword).not.toBe(b.temporaryPassword);
  });

  it("works on a disabled account and says so", async () => {
    user("gone@example.com");
    db.prepare("UPDATE users SET disabled_at = ? WHERE email = 'gone@example.com'").run(T0);
    expect(await resetPasswordByCli(db, { email: "gone@example.com", reason: REASON })).toMatchObject({ ok: true, disabled: true });
  });

  it("refuses a missing reason, an unknown account and a malformed email without hashing or changing anything", async () => {
    user("person@example.com");
    const before = (db.prepare("SELECT password_hash FROM users WHERE email = 'person@example.com'").get() as { password_hash: string }).password_hash;
    expect(await resetPasswordByCli(db, { email: "person@example.com", reason: "  " })).toEqual({ ok: false, error: expect.stringContaining("reason is required") });
    expect(await resetPasswordByCli(db, { email: "nobody@example.com", reason: REASON })).toEqual({ ok: false, error: "No account with the email nobody@example.com." });
    expect(await resetPasswordByCli(db, { email: "nope", reason: REASON })).toEqual({ ok: false, error: "That is not a valid email address." });
    expect((db.prepare("SELECT password_hash FROM users WHERE email = 'person@example.com'").get() as { password_hash: string }).password_hash).toBe(before);
    expect(actions()).toEqual([]);
  });
});

describe("the recovery path for a locked-out sole admin", () => {
  it("reset-mfa then reset-password lets them log in, change the password and set MFA up again", async () => {
    const admin = await realUser("admin@example.com", ["admin"]);
    db.prepare("UPDATE users SET mfa_required = 1 WHERE id = ?").run(admin.id);
    resetMfaByCli(db, { email: "admin@example.com", reason: REASON }, T0 + STEP);
    const pw = await resetPasswordByCli(db, { email: "admin@example.com", reason: REASON }, T0 + STEP);
    if (!pw.ok) throw new Error(pw.error);

    const now = T0 + 5 * STEP;
    const l = await login(db, { email: "admin@example.com", password: pw.temporaryPassword }, { ip: null, userAgent: null, now });
    if (!l.ok) throw new Error("cannot log in");
    const s = validateSession(db, l.token, now)!;
    // no MFA to pass any more, but the account is gated: password change first, then MFA setup
    expect(s).toMatchObject({ mfaPending: false, mustChangePassword: true, needsMfaSetup: true });

    const session = { tokenHash: s.tokenHash, userId: admin.id };
    const view = pendingSetup(db, KEY, admin.id, session.tokenHash, now)!;
    expect(view.secret).toBeTruthy();
    const secret = decryptSecret(KEY, (db.prepare("SELECT secret_enc AS s FROM mfa_setup WHERE user_id = ?").get(admin.id) as { s: string }).s, admin.id);
    const done = confirmSetup(db, KEY, session, totp(secret, now), { ip: null, now });
    expect(done).toMatchObject({ ok: true });
    expect(actions()).toEqual(expect.arrayContaining(["mfa.reset_by_cli", "password.reset_by_cli", "mfa.enabled"]));
  });
});
