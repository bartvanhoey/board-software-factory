import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db";
import { gateRedirect } from "./gating";
import { clientIp, ipKey, normalizeIp, sessionCookieName } from "./request";
import { consume, delayFor, recordFailure, releaseFailure, resetFailures, retryAfter } from "./throttle";

let db: ReturnType<typeof openDb>;
const T0 = 1_000_000_000_000;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("delayFor", () => {
  it("is free for four failures, then 30 s doubling up to 15 minutes", () => {
    expect([0, 1, 4].map(delayFor)).toEqual([0, 0, 0]);
    expect([5, 6, 7, 8, 9].map(delayFor)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(delayFor(10)).toBe(15 * 60_000);
    expect(delayFor(500)).toBe(15 * 60_000);
  });
});

describe("login failures", () => {
  it("allows four failures, then blocks without a hard lock", () => {
    for (let i = 0; i < 4; i++) recordFailure(db, "k", T0);
    expect(retryAfter(db, "k", T0)).toBe(0);
    recordFailure(db, "k", T0);
    expect(retryAfter(db, "k", T0)).toBe(30_000);
    expect(retryAfter(db, "k", T0 + 29_000)).toBe(1_000);
    expect(retryAfter(db, "k", T0 + 30_000)).toBe(0);
  });

  it("keeps keys independent and resets on success", () => {
    for (let i = 0; i < 5; i++) recordFailure(db, "a", T0);
    expect(retryAfter(db, "b", T0)).toBe(0);
    resetFailures(db, "a");
    expect(retryAfter(db, "a", T0)).toBe(0);
  });

  it("forgets old failures after a day", () => {
    for (let i = 0; i < 12; i++) recordFailure(db, "k", T0);
    expect(retryAfter(db, "k", T0 + 25 * 3_600_000)).toBe(0);
    recordFailure(db, "k", T0 + 25 * 3_600_000);
    expect(retryAfter(db, "k", T0 + 25 * 3_600_000)).toBe(0);
  });
});

describe("reserving attempts", () => {
  it("releaseFailure takes back one attempt and removes the row at zero", () => {
    recordFailure(db, "k", T0);
    recordFailure(db, "k", T0);
    releaseFailure(db, "k");
    expect(db.prepare("SELECT count FROM throttle WHERE key = 'k'").get()).toEqual({ count: 1 });
    releaseFailure(db, "k");
    expect(db.prepare("SELECT COUNT(*) AS n FROM throttle").get()).toEqual({ n: 0 });
    releaseFailure(db, "missing"); // no row: nothing happens
  });

  it("forgets rows older than a day whenever a new failure is recorded", () => {
    for (let i = 0; i < 50; i++) recordFailure(db, `junk${i}`, T0);
    recordFailure(db, "fresh", T0 + 25 * 3_600_000);
    expect(db.prepare("SELECT key FROM throttle").all()).toEqual([{ key: "fresh" }]);
  });
});

describe("consume (fixed window)", () => {
  it("allows up to the limit, then refuses until the window passes", () => {
    for (let i = 0; i < 3; i++) expect(consume(db, "w", 3, 1000, T0)).toBe(true);
    expect(consume(db, "w", 3, 1000, T0 + 500)).toBe(false);
    expect(consume(db, "w", 3, 1000, T0 + 1000)).toBe(true);
  });
});

describe("gateRedirect", () => {
  it("sends a forced password change first, then role-less users to the waiting page", () => {
    expect(gateRedirect({ mustChangePassword: true, roles: [] })).toBe("/account/password");
    expect(gateRedirect({ mustChangePassword: true, roles: ["admin"] })).toBe("/account/password");
    expect(gateRedirect({ mustChangePassword: false, roles: [] })).toBe("/waiting");
    expect(gateRedirect({ mustChangePassword: false, roles: ["viewer"] })).toBeNull();
  });

  it("puts an unconfirmed address after the password change and before MFA setup", () => {
    const all = { mustChangePassword: true, roles: [] as never[], mfaPending: true, needsEmailVerification: true, needsMfaSetup: true };
    expect(gateRedirect(all)).toBe("/login/mfa");
    expect(gateRedirect({ ...all, mfaPending: false })).toBe("/account/password");
    expect(gateRedirect({ ...all, mfaPending: false, mustChangePassword: false })).toBe("/account/verify");
    expect(gateRedirect({ ...all, mfaPending: false, mustChangePassword: false, needsEmailVerification: false })).toBe("/account/mfa/setup");
    expect(gateRedirect({ mustChangePassword: false, roles: ["viewer"], needsEmailVerification: true })).toBe("/account/verify");
    expect(gateRedirect({ mustChangePassword: false, roles: [], needsEmailVerification: true })).toBe("/account/verify"); // before the waiting page too
  });

  it("puts the second factor first, then the password change, then MFA setup, then the waiting page", () => {
    const all = { mustChangePassword: true, roles: [] as never[], mfaPending: true, needsMfaSetup: true };
    expect(gateRedirect(all)).toBe("/login/mfa");
    expect(gateRedirect({ ...all, mfaPending: false })).toBe("/account/password");
    expect(gateRedirect({ ...all, mfaPending: false, mustChangePassword: false })).toBe("/account/mfa/setup");
    expect(gateRedirect({ ...all, mfaPending: false, mustChangePassword: false, needsMfaSetup: false })).toBe("/waiting");
    expect(gateRedirect({ mustChangePassword: false, roles: ["viewer"], needsMfaSetup: true })).toBe("/account/mfa/setup");
  });
});

describe("request helpers", () => {
  it("only trusts X-Forwarded-For when told to, and takes the last hop", () => {
    const h = (v: string | null) => () => v;
    expect(clientIp(h("1.2.3.4"), false)).toBeNull();
    expect(clientIp(h("9.9.9.9, 1.2.3.4"), true)).toBe("1.2.3.4");
    expect(clientIp(h(null), true)).toBeNull();
    expect(clientIp(h("<script>"), true)).toBeNull();
  });

  it("accepts only real IP addresses from the header", () => {
    const h = (v: string) => () => v;
    for (const junk of ["1.2.3.4.5", "256.1.1.1", "01.2.3.4", ":::", "1:2:3:4:5:6:7:8:9", "fe80::1%eth0", "1.2.3.4:80", "evil.example", "", "1.2.3.4,", "0x7f.1"])
      expect(clientIp(h(junk), true), junk).toBeNull();
    expect(clientIp(h("9.9.9.9, 1.2.3.4 "), true)).toBe("1.2.3.4");
    expect(clientIp(h("1.2.3.4, 2001:db8::1"), true)).toBe("2001:db8::1");
  });

  it("returns one spelling per address", () => {
    const h = (v: string) => () => v;
    expect(clientIp(h("2001:DB8:0:0:0:0:0:1"), true)).toBe("2001:db8::1");
    expect(clientIp(h("2001:db8::0:1"), true)).toBe("2001:db8::1");
    expect(clientIp(h("::ffff:1.2.3.4"), true)).toBe("1.2.3.4");
    expect(clientIp(h("::FFFF:102:304"), true)).toBe("1.2.3.4");
    expect(clientIp(h("::1"), true)).toBe("::1");
    expect(normalizeIp("1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("not an ip")).toBeNull();
  });

  it("keys IPv6 by its /64 and IPv4 by its address", () => {
    expect(ipKey("1.2.3.4")).toBe("1.2.3.4");
    expect(ipKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:DB8:1:2:0:0:0:5")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8:1:3::1")).not.toBe(ipKey("2001:db8:1:2::1"));
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("::ffff:1.2.3.4")).toBe("1.2.3.4"); // a mapped address is an IPv4 client
  });

  it("uses a __Host- cookie only when Secure", () => {
    expect(sessionCookieName(true)).toBe("__Host-session");
    expect(sessionCookieName(false)).toBe("session");
  });
});
