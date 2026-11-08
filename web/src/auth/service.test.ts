import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db";
import { MAX_CONCURRENT, MAX_WAITING, hashParams, hashPassword } from "./password";
import { changePassword, leftoverAdminPasswordNotice, login, logout, register, seedAdmin, type Ctx } from "./service";
import { validateSession } from "./sessions";
import { countPending, createUser, findUserByEmail, rolesOf } from "./users";

const prod = { ...hashParams };
beforeAll(() => Object.assign(hashParams, { N: 2 ** 10, r: 8, p: 1 }));
afterAll(() => Object.assign(hashParams, prod));

let db: ReturnType<typeof openDb>;
const T0 = 1_000_000_000_000;
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ ip: null, userAgent: "test", now: T0, ...over });
const PW = "a good long password";

const actions = () => (db.prepare("SELECT action FROM audit_log ORDER BY id").all() as { action: string }[]).map((r) => r.action);

beforeEach(() => {
  db = openDb(":memory:");
});

describe("register", () => {
  it("creates a role-less account, logs it in and audits it", async () => {
    const r = await register(db, { email: "  New@Example.com ", password: PW }, ctx());
    expect(r.ok).toBe(true);
    const user = findUserByEmail(db, "new@example.com")!;
    expect(rolesOf(db, user.id)).toEqual([]);
    expect(user.password_hash.startsWith("scrypt$")).toBe(true);
    if (r.ok) expect(validateSession(db, r.token, T0)?.roles).toEqual([]);
    expect(actions()).toEqual(["user.registered"]);
  });

  it("refuses an address that could never receive mail (commas, brackets, quotes), because it would be a dead account", async () => {
    for (const email of ["a,b@example.com", "a;b@example.com", "<a>@example.com", '"a"@example.com', "a(b)@example.com"]) {
      expect(await register(db, { email, password: PW }, ctx())).toEqual({ ok: false, error: "Enter a valid email address." });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("rejects a bad email, a weak password and a duplicate", async () => {
    expect(await register(db, { email: "nope", password: PW }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("valid email") });
    expect(await register(db, { email: "a@example.com", password: "short" }, ctx())).toMatchObject({ ok: false });
    await register(db, { email: "a@example.com", password: PW }, ctx());
    expect(await register(db, { email: "A@example.com", password: PW }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("already exists") });
  });

  it("limits registrations per IP, or globally when the IP is unknown", async () => {
    for (let i = 0; i < 5; i++) expect((await register(db, { email: `u${i}@example.com`, password: PW }, ctx({ ip: "1.1.1.1" }))).ok).toBe(true);
    expect(await register(db, { email: "u9@example.com", password: PW }, ctx({ ip: "1.1.1.1" }))).toMatchObject({ ok: false, error: expect.stringContaining("Too many") });
    expect((await register(db, { email: "other@example.com", password: PW }, ctx({ ip: "2.2.2.2" }))).ok).toBe(true);
  });

  it("does not use up the registration quota on invalid input", async () => {
    for (let i = 0; i < 30; i++) await register(db, { email: "nope", password: "x" }, ctx());
    expect((await register(db, { email: "real@example.com", password: PW }, ctx())).ok).toBe(true);
  });

  it("answers 'already exists' for simultaneous registrations of one email, never an error", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => register(db, { email: "race@example.com", password: PW }, ctx())));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(r).toMatchObject({ error: expect.stringContaining("already exists") });
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  it("closes registration at 100 pending accounts", async () => {
    for (let i = 0; i < 100; i++) createUser(db, { email: `p${i}@example.com`, passwordHash: "x" });
    expect(countPending(db)).toBe(100);
    expect(await register(db, { email: "late@example.com", password: PW }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("temporarily closed") });
  });
});

describe("login", () => {
  beforeEach(async () => {
    await register(db, { email: "user@example.com", password: PW }, ctx());
  });

  it("logs in with the right password", async () => {
    const r = await login(db, { email: "USER@example.com", password: PW }, ctx());
    expect(r.ok).toBe(true);
    expect(actions()).toContain("login.success");
  });

  it("starts a pending session when the user has MFA, and a normal one when they do not", async () => {
    const plain = await login(db, { email: "user@example.com", password: PW }, ctx());
    if (!plain.ok) throw new Error("setup");
    expect(validateSession(db, plain.token, T0)!.mfaPending).toBe(false);
    db.prepare("UPDATE users SET mfa_enabled_at = ? WHERE email = 'user@example.com'").run(T0);
    const withMfa = await login(db, { email: "user@example.com", password: PW }, ctx({ now: T0 + 1 }));
    if (!withMfa.ok) throw new Error("setup");
    expect(validateSession(db, withMfa.token, T0 + 1)!.mfaPending).toBe(true);
  });

  it("answers busy when the hash queue is full, without counting the attempt against the account", async () => {
    // Fill the queue: running plus waiting hashes, all started before any can finish.
    const fill = Array.from({ length: MAX_CONCURRENT + MAX_WAITING }, () => hashPassword("filler password 1"));
    const busy = [];
    for (let i = 0; i < 10; i++) busy.push(login(db, { email: "user@example.com", password: "wrong password " + i }, ctx()));
    const results = await Promise.all(busy);
    for (const r of results) expect(r).toEqual({ ok: false, error: "The server is busy. Try again in a moment." });
    await Promise.all(fill);

    // Ten counted failures would now be blocking this account; refused attempts are not counted.
    const r = await login(db, { email: "user@example.com", password: PW }, ctx());
    expect(r.ok).toBe(true);
  });

  it("does not hand out a full session when MFA was switched on while the password was being checked", async () => {
    const inFlight = login(db, { email: "user@example.com", password: PW }, ctx()); // read the row (no MFA), now waiting on scrypt
    db.prepare("UPDATE users SET mfa_enabled_at = ?, mfa_secret_enc = 'v1.x.y.z' WHERE email = 'user@example.com'").run(T0);
    const r = await inFlight;
    if (!r.ok) throw new Error("login should still succeed");
    expect(validateSession(db, r.token, T0)!.mfaPending).toBe(true);
  });

  it("gives the same error for a wrong password, an unknown email and a malformed email", async () => {
    const errors = await Promise.all(
      [
        { email: "user@example.com", password: "wrong password 12" },
        { email: "ghost@example.com", password: PW },
        { email: "not an email", password: PW },
      ].map(async (i) => (await login(db, i, ctx())) as { ok: false; error: string }),
    );
    expect(new Set(errors.map((e) => e.error))).toEqual(new Set(["Wrong email or password."]));
  });

  it("delays after five failures without checking the password, and recovers", async () => {
    for (let i = 0; i < 5; i++) await login(db, { email: "user@example.com", password: "wrong password 12" }, ctx());
    const blocked = await login(db, { email: "user@example.com", password: PW }, ctx());
    expect(blocked).toMatchObject({ ok: false, error: expect.stringContaining("Too many attempts") });
    expect((await login(db, { email: "user@example.com", password: PW }, ctx({ now: T0 + 31_000 }))).ok).toBe(true);
  });

  it("throttles unknown emails the same way, so existence is not revealed", async () => {
    for (let i = 0; i < 5; i++) await login(db, { email: "ghost@example.com", password: PW }, ctx());
    expect(await login(db, { email: "ghost@example.com", password: PW }, ctx())).toMatchObject({ error: expect.stringContaining("Too many attempts") });
  });

  it("also throttles per IP when the IP is known", async () => {
    for (let i = 0; i < 5; i++) await login(db, { email: `x${i}@example.com`, password: PW }, ctx({ ip: "3.3.3.3" }));
    expect(await login(db, { email: "user@example.com", password: PW }, ctx({ ip: "3.3.3.3" }))).toMatchObject({ error: expect.stringContaining("Too many attempts") });
    expect((await login(db, { email: "user@example.com", password: PW }, ctx({ ip: "4.4.4.4" }))).ok).toBe(true);
  });

  it("counts an IPv6 client per /64, so rotating addresses inside it does not dodge the IP limit", async () => {
    for (let i = 0; i < 5; i++) await login(db, { email: `x${i}@example.com`, password: PW }, ctx({ ip: `2001:db8:1:2::${i + 1}` }));
    expect(await login(db, { email: "user@example.com", password: PW }, ctx({ ip: "2001:db8:1:2:aaaa:bbbb:cccc:dddd" }))).toMatchObject({
      error: expect.stringContaining("Too many attempts"),
    });
    // another /64 is another client
    expect((await login(db, { email: "user@example.com", password: PW }, ctx({ ip: "2001:db8:1:3::1" }))).ok).toBe(true);
  });

  it("limits registrations per /64 for IPv6, and records the full address in the audit log", async () => {
    for (let i = 0; i < 5; i++) expect((await register(db, { email: `v${i}@example.com`, password: PW }, ctx({ ip: `2001:db8:9:9::${i + 1}` }))).ok).toBe(true);
    expect(await register(db, { email: "v9@example.com", password: PW }, ctx({ ip: "2001:db8:9:9:1:2:3:4" }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("Too many"),
    });
    const ips = (db.prepare("SELECT ip FROM audit_log WHERE action = 'user.registered' AND ip IS NOT NULL ORDER BY id").all() as { ip: string }[]).map((r) => r.ip);
    expect(ips).toEqual(["2001:db8:9:9::1", "2001:db8:9:9::2", "2001:db8:9:9::3", "2001:db8:9:9::4", "2001:db8:9:9::5"]);
  });

  it("does not let a login that was hashing survive a password reset that landed meanwhile", async () => {
    const inFlight = login(db, { email: "user@example.com", password: PW }, ctx()); // reads the row, then waits on scrypt
    db.prepare("UPDATE users SET password_hash = 'scrypt$1024$8$1$aa$bb' WHERE email = 'user@example.com'").run();
    expect(await inFlight).toEqual({ ok: false, error: "Wrong email or password." });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 }); // only the registration session
  });

  it("refuses a disabled account with the generic error", async () => {
    db.prepare("UPDATE users SET disabled_at = ? WHERE email = 'user@example.com'").run(T0);
    expect(await login(db, { email: "user@example.com", password: PW }, ctx())).toEqual({ ok: false, error: "Wrong email or password." });
  });

  it("audits failures for real accounts without the password", async () => {
    await login(db, { email: "user@example.com", password: "wrong password 12" }, ctx());
    const row = db.prepare("SELECT detail FROM audit_log WHERE action = 'login.failed'").get() as { detail: string };
    expect(row.detail).not.toContain("wrong password");
  });

  it("does not audit unknown emails: the log is append-only, so strangers must not be able to grow it", async () => {
    for (let i = 0; i < 3; i++) await login(db, { email: `ghost${i}@example.com`, password: PW }, ctx());
    expect(actions().filter((a) => a === "login.failed")).toEqual([]);
  });

  it("never stores what was typed in the email box as a throttle key", async () => {
    await login(db, { email: "my secret passphrase 123", password: PW }, ctx());
    const keys = (db.prepare("SELECT key FROM throttle").all() as { key: string }[]).map((r) => r.key).join();
    expect(keys).not.toContain("passphrase");
    expect(keys).toMatch(/^login:acct:[0-9a-f]{32}/);
  });

  it("holds a burst of simultaneous guesses to the free attempts instead of letting them all through", async () => {
    const burst = await Promise.all(Array.from({ length: 12 }, () => login(db, { email: "user@example.com", password: "wrong password 12" }, ctx())));
    const evaluated = burst.filter((r) => !r.ok && r.error === "Wrong email or password.").length;
    expect(evaluated).toBe(5);
    expect(burst.filter((r) => !r.ok && r.error.includes("Too many attempts"))).toHaveLength(7);
  });

  it("takes the reserved attempt back after a successful login, so normal use never builds up a delay", async () => {
    for (let i = 0; i < 8; i++) expect((await login(db, { email: "user@example.com", password: PW }, ctx({ ip: "5.5.5.5" }))).ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM throttle WHERE key LIKE 'login:%'").get()).toEqual({ n: 0 });
  });
});

describe("logout", () => {
  it("ends the session and audits it", async () => {
    const r = await register(db, { email: "user@example.com", password: PW }, ctx());
    if (!r.ok) throw new Error("setup");
    logout(db, r.token, ctx());
    expect(validateSession(db, r.token, T0)).toBeNull();
    expect(actions()).toContain("logout");
  });
});

describe("changePassword", () => {
  it("changes the password, clears the forced flag and ends the other sessions", async () => {
    const a = await register(db, { email: "user@example.com", password: PW }, ctx());
    const b = await login(db, { email: "user@example.com", password: PW }, ctx());
    if (!a.ok || !b.ok) throw new Error("setup");
    db.prepare("UPDATE users SET must_change_password = 1").run();

    expect(await changePassword(db, a.token, { current: PW, next: "another good password" }, ctx())).toEqual({ ok: true });
    expect(validateSession(db, a.token, T0)?.mustChangePassword).toBe(false);
    expect(validateSession(db, b.token, T0)).toBeNull();
    expect((await login(db, { email: "user@example.com", password: "another good password" }, ctx())).ok).toBe(true);
    expect(actions()).toContain("password.changed");
  });

  it("needs the right current password, a valid new one, and a different one", async () => {
    const a = await register(db, { email: "user@example.com", password: PW }, ctx());
    if (!a.ok) throw new Error("setup");
    expect(await changePassword(db, a.token, { current: "wrong password 12", next: "another good password" }, ctx())).toMatchObject({ ok: false });
    expect(await changePassword(db, a.token, { current: PW, next: "short" }, ctx())).toMatchObject({ ok: false });
    expect(await changePassword(db, a.token, { current: PW, next: PW }, ctx())).toMatchObject({ ok: false });
    expect(await changePassword(db, "dead-token", { current: PW, next: "another good password" }, ctx())).toMatchObject({ ok: false });
  });

  it("treats a look-alike (NFKC-equal) new password as the same password", async () => {
    const a = await register(db, { email: "user@example.com", password: "caf\u00e9 au lait 123" }, ctx());
    if (!a.ok) throw new Error("setup");
    const r = await changePassword(db, a.token, { current: "caf\u00e9 au lait 123", next: "cafe\u0301 au lait 123" }, ctx());
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("different") });
  });

  it("refuses a session that has only passed the password (MFA pending): it must not change the password", async () => {
    await register(db, { email: "mfa@example.com", password: PW }, ctx());
    db.prepare("UPDATE users SET mfa_enabled_at = ? WHERE email = 'mfa@example.com'").run(T0);
    const pending = await login(db, { email: "mfa@example.com", password: PW }, ctx({ now: T0 + 1 }));
    if (!pending.ok) throw new Error("setup");
    expect(validateSession(db, pending.token, T0 + 1)!.mfaPending).toBe(true);
    const r = await changePassword(db, pending.token, { current: PW, next: "an attacker chosen passphrase" }, ctx({ now: T0 + 1 }));
    expect(r).toEqual({ ok: false, error: "Your session has ended. Log in again." });
    // the password is unchanged, and no guesses were spent on the password-change throttle
    expect((await login(db, { email: "mfa@example.com", password: PW }, ctx({ now: T0 + 2 }))).ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM throttle WHERE key LIKE 'login:chpw:%'").get()).toEqual({ n: 0 });
  });

  it("does not undo a password reset that landed while the new password was being hashed", async () => {
    const a = await register(db, { email: "user@example.com", password: PW }, ctx());
    if (!a.ok) throw new Error("setup");
    const inFlight = changePassword(db, a.token, { current: PW, next: "an attacker chosen passphrase" }, ctx());
    // the break-glass command (or an admin) resets the password and ends the sessions in the meantime
    db.prepare("UPDATE users SET password_hash = 'scrypt$1024$8$1$aa$bb', must_change_password = 1 WHERE email = 'user@example.com'").run();
    db.prepare("DELETE FROM sessions").run();
    expect(await inFlight).toEqual({ ok: false, error: "Your session has ended. Log in again." });
    expect((db.prepare("SELECT password_hash AS h FROM users WHERE email = 'user@example.com'").get() as { h: string }).h).toBe("scrypt$1024$8$1$aa$bb");
    expect(actions()).not.toContain("password.changed");
  });

  it("refuses a password change from a session that was ended meanwhile, even when the password is unchanged", async () => {
    const a = await register(db, { email: "user@example.com", password: PW }, ctx());
    if (!a.ok) throw new Error("setup");
    const inFlight = changePassword(db, a.token, { current: PW, next: "another good password" }, ctx());
    db.prepare("DELETE FROM sessions").run();
    expect(await inFlight).toMatchObject({ ok: false });
    expect((await login(db, { email: "user@example.com", password: PW }, ctx({ now: T0 + 1 }))).ok).toBe(true); // the old password still works
  });

  it("slows down repeated wrong current passwords", async () => {
    const a = await register(db, { email: "user@example.com", password: PW }, ctx());
    if (!a.ok) throw new Error("setup");
    for (let i = 0; i < 5; i++) await changePassword(db, a.token, { current: "wrong password 12", next: "another good password" }, ctx());
    expect(await changePassword(db, a.token, { current: PW, next: "another good password" }, ctx())).toMatchObject({ error: expect.stringContaining("Too many attempts") });
  });
});

describe("seedAdmin", () => {
  const admin = { email: "admin@example.com", password: "initial admin password" };

  it("creates a verified admin that must change its password, and audits it", async () => {
    expect(await seedAdmin(db, admin, T0)).toBe("seeded");
    const u = findUserByEmail(db, admin.email)!;
    expect(rolesOf(db, u.id)).toEqual(["admin"]);
    expect(u.must_change_password).toBe(1);
    expect(u.email_verified_at).toBe(T0);
    expect(actions()).toEqual(["admin.seeded"]);
    expect((await login(db, admin, ctx())).ok).toBe(true);
  });

  it("does nothing without config, or once an admin exists (even with other variables)", async () => {
    expect(await seedAdmin(db, null)).toBe("no-config");
    await seedAdmin(db, admin);
    expect(await seedAdmin(db, { email: "second@example.com", password: "another admin password" })).toBe("admin-exists");
    expect(findUserByEmail(db, "second@example.com")).toBeUndefined();
  });

  it("never promotes or changes an account that already registered with that email", async () => {
    await register(db, { email: admin.email, password: PW }, ctx());
    expect(await seedAdmin(db, admin)).toBe("email-taken");
    expect(rolesOf(db, findUserByEmail(db, admin.email)!.id)).toEqual([]);
  });

  it("leaves no half-created admin behind when seeding fails midway", async () => {
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON user_roles BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await expect(seedAdmin(db, admin)).rejects.toThrow(/boom/);
    expect(findUserByEmail(db, admin.email)).toBeUndefined();
    expect(actions()).toEqual([]);
  });

  it("rejects a common admin password", async () => {
    await expect(seedAdmin(db, { email: admin.email, password: "passwordpassword" })).rejects.toThrow(/too common/);
  });

  it("warns to remove ADMIN_PASSWORD once an admin exists, and only then", async () => {
    // first start: the password was used, nothing to warn about yet
    expect(leftoverAdminPasswordNotice(await seedAdmin(db, admin))).toBeNull();
    // every later start with the variable still set
    const notice = leftoverAdminPasswordNotice(await seedAdmin(db, admin));
    expect(notice).toContain("ADMIN_PASSWORD is still set");
    expect(notice).toContain("Remove ADMIN_PASSWORD from .env");
    expect(notice).not.toContain(admin.password);
    expect(notice).not.toContain(admin.email);
  });

  it("does not warn when there is no ADMIN_PASSWORD, or the email belongs to a normal account", async () => {
    expect(leftoverAdminPasswordNotice(await seedAdmin(db, null))).toBeNull();
    await register(db, { email: admin.email, password: PW }, ctx());
    expect(await seedAdmin(db, admin)).toBe("email-taken");
    expect(leftoverAdminPasswordNotice("email-taken")).toBeNull();
    expect(leftoverAdminPasswordNotice("seeded")).toBeNull();
  });
});
