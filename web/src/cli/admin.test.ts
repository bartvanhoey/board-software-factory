import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../auth/db";
import { hashParams } from "../auth/password";
import { login, register } from "../auth/service";
import { createUser, grantRole } from "../auth/users";
import { EXIT, run, type RunOptions } from "./admin";

const prod = { ...hashParams };
beforeAll(() => Object.assign(hashParams, { N: 2 ** 10, r: 8, p: 1 }));
afterAll(() => Object.assign(hashParams, prod));

let dir: string;
let dbPath: string;
let env: Record<string, string | undefined>;

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

/** Runs the CLI as an ordinary user (not root) and returns what it printed. */
async function cli(...argv: string[]) {
  return cliWith({}, ...argv);
}

async function cliWith(opts: RunOptions, ...argv: string[]) {
  const o = io();
  const code = await run(argv, env, o.io, { uid: 1000, ...opts });
  return { code, out: o.out.join("\n"), err: o.err.join("\n") };
}

const REASON = ["--reason", "lost phone, ticket 42"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "breakglass-"));
  dbPath = join(dir, "auth.db");
  env = { AUTH_DB_PATH: dbPath, MFA_ENCRYPTION_KEY: Buffer.from(randomBytes(32)).toString("base64") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("usage", () => {
  it("prints help on stdout and exits 0", async () => {
    const r = await cli("--help");
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("reset-mfa");
    expect(r.out).toContain("reset-password");
    expect(r.err).toBe("");
  });

  it.each([
    [[], "Missing command"],
    [["reset-everything", "--email", "a@example.com", ...REASON], 'Unknown command "reset-everything"'],
    [["reset-mfa", ...REASON], "--email is required"],
    [["reset-mfa", "--email", "a@example.com"], "--reason is required"],
    [["reset-mfa", "--email", "a@example.com", "--reason", "   "], "--reason is required"],
    [["reset-mfa", "--email", "a@example.com", "--reason"], "--reason needs a value"],
    [["reset-mfa", "--email", "--reason", "x"], "--email needs a value"],
    [["reset-mfa", "--email", "a@example.com", "--email", "b@example.com", ...REASON], "--email given twice"],
    [["reset-mfa", "--email", "a@example.com", "--force", ...REASON], 'Unknown option "--force"'],
  ])("%j is a usage error (exit 64) that says why and shows the usage", async (argv, message) => {
    const r = await cli(...argv);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain(message);
    expect(r.err).toContain("Usage:");
    expect(r.out).toBe("");
  });

  it("treats --help as help only when it comes first: later it is an unknown option (64), or just text in a value", async () => {
    expect((await cli("reset-mfa", "--help")).code).toBe(EXIT.usage);
    openDb(dbPath).close();
    // "-h" and "--help" as the value of --reason are a reason, not a request for help that a script would read as success
    for (const reason of ["-h", "--help"]) {
      const r = await cli("reset-mfa", "--email", "nobody@example.com", "--reason", reason);
      expect(r.code).toBe(EXIT.refused);
      expect(r.err).toContain("No account with the email");
    }
  });

  it("accepts a reason that starts with dashes, in either form", async () => {
    openDb(dbPath).close();
    for (const argv of [["--reason", "--- ticket 42"], ["--reason=--- ticket 42"], ["--reason=--x"]]) {
      const r = await cli("reset-mfa", "--email", "nobody@example.com", ...argv);
      expect(r.code).toBe(EXIT.refused); // parsed, then the account does not exist
      expect(r.err).toContain("No account with the email");
    }
  });

  it("accepts --option=value as well as --option value", async () => {
    openDb(dbPath).close();
    const r = await cli("reset-mfa", "--email=nobody@example.com", "--reason=x");
    expect(r.code).toBe(EXIT.refused); // parsed fine, the account just does not exist
    expect(r.err).toContain("No account with the email nobody@example.com");
  });
});

describe("environment", () => {
  it("exits 69 and creates nothing when there is no database, so a mistyped path cannot make an empty one", async () => {
    const r = await cli("reset-mfa", "--email", "a@example.com", ...REASON);
    expect(r.code).toBe(EXIT.unavailable);
    expect(r.err).toContain("There is no database at");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("needs only AUTH_DB_PATH: no encryption key, and an unrelated broken setting does not block a recovery", async () => {
    const db = openDb(dbPath);
    createUser(db, { email: "plain@example.com", passwordHash: "x" });
    db.close();
    env = { AUTH_DB_PATH: dbPath, EMAIL_VERIFICATION: "banana", SMTP_PORT: "nope", ADMIN_PASSWORD: "x" };
    const r = await cli("reset-mfa", "--email", "plain@example.com", ...REASON);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("has no MFA set up");
  });

  it("refuses an existing but empty file, and leaves it empty (it would otherwise become a brand-new database)", async () => {
    writeFileSync(dbPath, "");
    const r = await cli("reset-mfa", "--email", "a@example.com", ...REASON);
    expect(r.code).toBe(EXIT.unavailable);
    expect(r.err).toContain("is empty");
    expect(statSync(dbPath).size).toBe(0);
  });

  it("refuses a file that is not a database, and a database without the auth schema, and changes neither", async () => {
    writeFileSync(dbPath, "this is just some text, not a database\n".repeat(200));
    const before = readFileSync(dbPath);
    expect((await cli("reset-mfa", "--email", "a@example.com", ...REASON)).code).toBe(EXIT.unavailable);
    expect(readFileSync(dbPath).equals(before)).toBe(true);

    rmSync(dbPath);
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const foreign = new DatabaseSync(dbPath);
    foreign.exec("CREATE TABLE other (x INTEGER)");
    foreign.close();
    const r = await cli("reset-mfa", "--email", "a@example.com", ...REASON);
    expect(r.code).toBe(EXIT.unavailable);
    expect(r.err).toContain("is not the auth database");
    const check = new DatabaseSync(dbPath, { readOnly: true });
    expect((check.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]).map((t) => t.name)).toEqual(["other"]);
    check.close();
  });

  it("refuses a directory", async () => {
    mkdirSync(dbPath);
    const r = await cli("reset-mfa", "--email", "a@example.com", ...REASON);
    expect(r.code).toBe(EXIT.unavailable);
    expect(r.err).toContain("There is no database at");
  });

  it("refuses to run as root, and changes nothing", async () => {
    const db = openDb(dbPath);
    createUser(db, { email: "person@example.com", passwordHash: "x" });
    db.prepare("UPDATE users SET mfa_enabled_at = 1, mfa_secret_enc = 'v1.x.y.z'").run();
    db.close();
    const r = await cliWith({ uid: 0 }, "reset-mfa", "--email", "person@example.com", ...REASON);
    expect(r.code).toBe(EXIT.unavailable);
    expect(r.err).toContain("Do not run this as root");
    const after = openDb(dbPath);
    expect((after.prepare("SELECT mfa_enabled_at FROM users").get() as { mfa_enabled_at: number | null }).mfa_enabled_at).toBe(1);
    after.close();
  });
});

describe("reset-mfa", () => {
  async function adminWithMfa(email = "admin@example.com"): Promise<void> {
    const db = openDb(dbPath);
    const id = createUser(db, { email, passwordHash: "x" });
    grantRole(db, id, "admin", null);
    db.prepare("UPDATE users SET mfa_required = 1, mfa_enabled_at = 1, mfa_secret_enc = 'v1.x.y.z' WHERE id = ?").run(id);
    db.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, 'h')").run(id);
    db.close();
  }

  it("removes an admin's MFA, tells the operator what happens next and audits it", async () => {
    await adminWithMfa();
    const r = await cliWith({ host: "c0ffee" }, "reset-mfa", "--email", "Admin@Example.com", ...REASON);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("MFA removed for admin@example.com");
    expect(r.out).toContain("must set MFA up again");
    expect(r.err).toBe("");

    const db = openDb(dbPath);
    expect(db.prepare("SELECT mfa_enabled_at, mfa_secret_enc FROM users").get()).toEqual({ mfa_enabled_at: null, mfa_secret_enc: null });
    expect(db.prepare("SELECT action, actor_user_id, detail FROM audit_log").all()).toEqual([
      {
        action: "mfa.reset_by_cli",
        actor_user_id: null,
        detail: JSON.stringify({ via: "cli", reason: "lost phone, ticket 42", operator: "not given", container: "c0ffee" }),
      },
    ]);
    db.close();
  });

  describe("who ran it", () => {
    const detailOfLastEntry = (): Record<string, string> => {
      const db = openDb(dbPath);
      const row = db.prepare("SELECT detail FROM audit_log ORDER BY id DESC LIMIT 1").get() as { detail: string };
      db.close();
      return JSON.parse(row.detail) as Record<string, string>;
    };

    it("records --operator and the container id, in either form of the flag", async () => {
      await adminWithMfa();
      expect((await cliWith({ host: "c0ffee" }, "reset-mfa", "--email", "admin@example.com", ...REASON, "--operator", "Bart V")).code).toBe(EXIT.ok);
      expect(detailOfLastEntry()).toEqual({ via: "cli", reason: "lost phone, ticket 42", operator: "Bart V", container: "c0ffee" });

      await adminWithMfa("second@example.com");
      expect((await cliWith({ host: "c0ffee" }, "reset-mfa", "--email", "second@example.com", ...REASON, "--operator=Dana")).code).toBe(EXIT.ok);
      expect(detailOfLastEntry()).toMatchObject({ operator: "Dana" });
    });

    it("falls back to the OPERATOR variable, lets the flag win, and says 'not given' otherwise", async () => {
      await adminWithMfa();
      env.OPERATOR = "from-env";
      expect((await cliWith({ host: "h" }, "reset-mfa", "--email", "admin@example.com", ...REASON)).code).toBe(EXIT.ok);
      expect(detailOfLastEntry()).toMatchObject({ operator: "from-env" });

      await adminWithMfa("second@example.com");
      expect((await cliWith({ host: "h" }, "reset-mfa", "--email", "second@example.com", ...REASON, "--operator", "from-flag")).code).toBe(EXIT.ok);
      expect(detailOfLastEntry()).toMatchObject({ operator: "from-flag" });

      await adminWithMfa("third@example.com");
      env.OPERATOR = "  ";
      expect((await cliWith({ host: "h" }, "reset-mfa", "--email", "third@example.com", ...REASON)).code).toBe(EXIT.ok);
      expect(detailOfLastEntry()).toMatchObject({ operator: "not given" });
    });

    it("records it for reset-password too", async () => {
      await adminWithMfa();
      const r = await cliWith({ host: "c0ffee" }, "reset-password", "--email", "admin@example.com", ...REASON, "--operator", "Bart V");
      expect(r.code).toBe(EXIT.ok);
      expect(detailOfLastEntry()).toEqual({ via: "cli", reason: "lost phone, ticket 42", operator: "Bart V", container: "c0ffee" });
      expect(r.out).not.toContain("Bart V"); // an audit label, not output
    });

    it("refuses an operator name that could disguise an audit entry, from the flag or the variable, and changes nothing", async () => {
      await adminWithMfa();
      for (const bad of ["two\nlines", "x".repeat(65), "evil‮name", "zero​width", "!!!", ""]) {
        const r = await cliWith({}, "reset-mfa", "--email", "admin@example.com", ...REASON, `--operator=${bad}`);
        expect(r.code, JSON.stringify(bad)).toBe(EXIT.refused);
        expect(r.err).toContain("--operator");
      }
      env.OPERATOR = "two\nlines";
      expect((await cli("reset-mfa", "--email", "admin@example.com", ...REASON)).code).toBe(EXIT.refused);

      const db = openDb(dbPath);
      expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT mfa_enabled_at FROM users WHERE email = 'admin@example.com'").get()).toEqual({ mfa_enabled_at: 1 });
      db.close();
    });

    it("needs a value after --operator", async () => {
      const r = await cli("reset-mfa", "--email", "a@example.com", ...REASON, "--operator");
      expect(r.code).toBe(EXIT.usage);
      expect(r.err).toContain("--operator needs a value");
    });

    it("documents the flag in the usage text", async () => {
      expect((await cli("--help")).out).toContain("--operator <name>");
    });
  });

  it("says so, with exit 0, when there is nothing to reset", async () => {
    const db = openDb(dbPath);
    createUser(db, { email: "plain@example.com", passwordHash: "x" });
    db.close();
    const r = await cli("reset-mfa", "--email", "plain@example.com", ...REASON);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("has no MFA set up; nothing was changed");
    expect(r.out).toContain("sessions were not touched");
  });

  it("exits 1 for an account that does not exist", async () => {
    openDb(dbPath).close();
    const r = await cli("reset-mfa", "--email", "nobody@example.com", ...REASON);
    expect(r.code).toBe(EXIT.refused);
    expect(r.err).toBe("No account with the email nobody@example.com.");
  });

  it("exits 1 for a reason that is too long or has a line break", async () => {
    await adminWithMfa();
    for (const reason of ["x".repeat(201), "line one\nline two"]) {
      const r = await cli("reset-mfa", "--email", "admin@example.com", "--reason", reason);
      expect(r.code).toBe(EXIT.refused);
      expect(r.err).toContain("reason is required");
    }
  });
});

describe("reset-password", () => {
  it("prints a temporary password once, on stdout only, that really logs in and must be changed", async () => {
    const db = openDb(dbPath);
    const reg = await register(db, { email: "person@example.com", password: "a long test passphrase 7" }, { ip: null, userAgent: null });
    expect(reg.ok).toBe(true);
    db.close();

    const r = await cli("reset-password", "--email", "person@example.com", ...REASON);
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe("");
    const password = /^Temporary password: (\S{16})$/m.exec(r.out)?.[1];
    expect(password).toBeTruthy();

    const after = openDb(dbPath);
    const l = await login(after, { email: "person@example.com", password: password! }, { ip: null, userAgent: null });
    expect(l.ok).toBe(true);
    // the plaintext is nowhere in the database
    expect(JSON.stringify(after.prepare("SELECT * FROM users").all()) + JSON.stringify(after.prepare("SELECT * FROM audit_log").all())).not.toContain(password!);
    expect(after.prepare("SELECT action FROM audit_log WHERE action LIKE '%_by_cli'").all()).toEqual([{ action: "password.reset_by_cli" }]);
    after.close();
  });

  it("prints the temporary password as the very last line, after every explanation", async () => {
    const db = openDb(dbPath);
    createUser(db, { email: "person@example.com", passwordHash: "x" });
    db.prepare("UPDATE users SET mfa_enabled_at = 1, mfa_secret_enc = 'v1.x.y.z', disabled_at = 1").run();
    db.close();
    const lines = (await cli("reset-password", "--email", "person@example.com", ...REASON)).out.split("\n");
    expect(lines.at(-1)).toMatch(/^Temporary password: \S{16}$/);
    expect(lines.slice(0, -1).some((l) => l.includes("Temporary password"))).toBe(false);
  });

  it("mentions MFA when the account still has it, and the disabled state", async () => {
    const db = openDb(dbPath);
    createUser(db, { email: "person@example.com", passwordHash: "x" });
    db.prepare("UPDATE users SET mfa_enabled_at = 1, mfa_secret_enc = 'v1.x.y.z', disabled_at = 1").run();
    db.close();
    const r = await cli("reset-password", "--email", "person@example.com", ...REASON);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("still has MFA");
    expect(r.out).toContain("the account is disabled");
  });

  it("exits 1 for an unknown account and prints no password", async () => {
    openDb(dbPath).close();
    const r = await cli("reset-password", "--email", "nobody@example.com", ...REASON);
    expect(r.code).toBe(EXIT.refused);
    expect(r.out).toBe("");
    expect(r.err).not.toContain("Temporary password");
  });
});

describe("output that breaks after the change was made", () => {
  it("says the change happened but was not shown, with exit 69, instead of claiming the command failed", async () => {
    const db = openDb(dbPath);
    createUser(db, { email: "person@example.com", passwordHash: "old-hash" });
    db.close();
    const err: string[] = [];
    const code = await run(
      ["reset-password", "--email", "person@example.com", ...REASON],
      env,
      { out: () => { throw new Error("EPIPE"); }, err: (l) => err.push(l) },
      { uid: 1000 },
    );
    expect(code).toBe(EXIT.unavailable);
    expect(err.join("\n")).toContain("was changed, but its output could not be written");
    expect(err.join("\n")).not.toContain("Could not complete");
    const after = openDb(dbPath);
    expect((after.prepare("SELECT password_hash FROM users").get() as { password_hash: string }).password_hash).not.toBe("old-hash");
    after.close();
  });
});

describe("the database is left usable", () => {
  it("closes it, so the file is not locked after a run (the web app keeps running alongside)", async () => {
    const db = openDb(dbPath);
    createUser(db, { email: "plain@example.com", passwordHash: "x" });
    db.close();
    await cli("reset-mfa", "--email", "plain@example.com", ...REASON);
    const again = openDb(dbPath);
    again.exec("BEGIN IMMEDIATE");
    again.exec("ROLLBACK");
    again.close();
  });
});
