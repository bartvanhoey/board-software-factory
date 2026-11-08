// The break-glass command: recovery from the server when the web app cannot help (an admin who lost their
// authenticator, or the only admin who forgot their password). Run inside the web container:
//   docker compose exec web npm run admin -- reset-mfa --email <email> --reason "<why>"
// Access to the server is the authorisation; every change is audited with the reason, the operator name the person
// gave (--operator, or the OPERATOR variable) and the container it ran in, but no actor: the name is a label, not proof.
import { statSync } from "node:fs";
import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { resetMfaByCli, resetPasswordByCli } from "../auth/breakglass";
import { authDbPath } from "../auth/config";
import { openDb } from "../auth/db";

export const EXIT = { ok: 0, refused: 1, usage: 64, unavailable: 69 } as const;

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const USAGE = `Usage: npm run admin -- <command> --email <email> --reason "<why>" [--operator <name>]

Commands:
  reset-mfa        Remove the user's MFA (authenticator and recovery codes) and end their sessions.
                   Works on administrators. They set MFA up again at next login if it is required.
  reset-password   Set a temporary password (shown once) that must be changed at next login, and end
                   their sessions. Does not touch MFA: run reset-mfa as well if both are lost.

Options:
  --email <email>  The account (must exist).
  --reason <text>  Why, one line, up to 200 characters. Recorded in the audit log.
  --operator <name>
                   Who you are, one line, up to 64 characters. Recorded in the audit log together with the
                   container id. Defaults to the OPERATOR variable, else "not given". A label, not proof.
  --help          Show this text (as the first argument).

Exit codes: 0 done (or nothing to do), 1 refused (unknown account, unusable reason), 64 usage, 69 database or environment.`;

const COMMANDS = ["reset-mfa", "reset-password"] as const;
const FLAGS = ["--email", "--reason", "--operator"] as const;
const isFlag = (s: string): boolean => (FLAGS as readonly string[]).includes(s);

type Parsed = { ok: true; command: (typeof COMMANDS)[number]; email: string; reason: string; operator: string | undefined } | { ok: false; error: string } | { ok: "help" };

function parse(argv: string[]): Parsed {
  // Only the first argument asks for help: "--reason -h" is a reason, and a script must not read it as success.
  if (argv[0] === "--help" || argv[0] === "-h") return { ok: "help" };
  const [command, ...rest] = argv;
  if (!command) return { ok: false, error: "Missing command." };
  if (!(COMMANDS as readonly string[]).includes(command)) return { ok: false, error: `Unknown command "${command}".` };

  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (!isFlag(name)) return { ok: false, error: `Unknown option "${arg}".` };
    if (values.has(name)) return { ok: false, error: `${name} given twice.` };
    // "--flag=value" takes anything after the "="; "--flag value" only refuses a value that is itself one of our flags,
    // so a reason such as "--- ticket 42" is fine.
    const value = eq > 0 ? arg.slice(eq + 1) : rest[i + 1];
    if (value === undefined || (eq <= 0 && isFlag(value))) return { ok: false, error: `${name} needs a value.` };
    if (eq <= 0) i++;
    values.set(name, value);
  }
  const email = values.get("--email");
  const reason = values.get("--reason");
  if (!email) return { ok: false, error: "--email is required." };
  if (!reason || !reason.trim()) return { ok: false, error: "--reason is required: say why, it goes in the audit log." };
  return { ok: true, command: command as (typeof COMMANDS)[number], email, reason, operator: values.get("--operator") };
}

const { DatabaseSync: Sqlite } = process.getBuiltinModule("node:sqlite");

/**
 * Only an existing, non-empty file that already holds the auth schema is accepted. openDb would happily turn an empty
 * file (a stray `touch`, a mis-mounted volume) into a brand-new database, so this checks first, read-only.
 */
function requireAuthDatabase(path: string): void {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch {
    throw new Error(`There is no database at ${path}. Run this inside the web container, where AUTH_DB_PATH points at it.`);
  }
  if (size === 0) throw new Error(`${path} is empty, so it is not the auth database. Nothing was changed.`);

  let probe: DatabaseSync | undefined;
  try {
    probe = new Sqlite(path, { readOnly: true });
    if (probe.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'schema_migrations'").get() === undefined) throw new Error("no schema_migrations table");
  } catch {
    throw new Error(`${path} is not the auth database. Nothing was changed.`);
  } finally {
    try {
      probe?.close();
    } catch {
      /* nothing useful to do */
    }
  }
}

export interface RunOptions {
  now?: number;
  /** The user id the process runs as. Defaults to the real one; injectable for tests. */
  uid?: number | undefined;
  /** The container's hostname, recorded in the audit entry. Defaults to the real one; injectable for tests. */
  host?: string;
}

export async function run(argv: string[], env: Record<string, string | undefined>, io: Io, opts: RunOptions = {}): Promise<number> {
  const args = parse(argv);
  if (args.ok === "help") {
    io.out(USAGE);
    return EXIT.ok;
  }
  if (!args.ok) {
    io.err(`${args.error}\n\n${USAGE}`);
    return EXIT.usage;
  }

  // As root the command could leave root-owned -wal/-shm files that the web app (user factory) then cannot write.
  const uid = "uid" in opts ? opts.uid : process.getuid?.();
  if (uid === 0) {
    io.err("Do not run this as root: it could leave database files the web app cannot write. Use the container's own user (docker compose exec without -u root).");
    return EXIT.unavailable;
  }

  const now = opts.now ?? Date.now();
  let db: DatabaseSync | undefined;
  try {
    // Only the database path matters here, so an unrelated broken setting (SMTP, say) cannot block a recovery.
    const dbPath = authDbPath(env);
    requireAuthDatabase(dbPath);
    db = openDb(dbPath);
    // --operator wins, then the OPERATOR variable (an empty one counts as unset), else it says it was not given.
    const operator = args.operator ?? (env.OPERATOR?.trim() ? env.OPERATOR : "not given");
    const input = { email: args.email, reason: args.reason, operator, container: opts.host ?? hostname() };

    let lines: string[];
    let failed: string;
    if (args.command === "reset-mfa") {
      const r = resetMfaByCli(db, input, now);
      if (!r.ok) return refuse(io, r.error);
      failed = "The change was made, but its output could not be written.";
      lines = !r.changed
        ? [`${r.email} has no MFA set up; nothing was changed. Their sessions were not touched: use reset-password to end them.`]
        : [
            `MFA removed for ${r.email}. Their sessions were ended, and their old authenticator and recovery codes no longer work.`,
            r.mustSetUpAgain ? "They must set MFA up again at their next login (after their password)." : "MFA is optional for this account; they can turn it on again at /account/mfa.",
            ...(r.disabled ? ["Note: the account is disabled."] : []),
          ];
    } else {
      const r = await resetPasswordByCli(db, input, now);
      if (!r.ok) return refuse(io, r.error);
      failed = "The password was changed, but its output could not be written, so the temporary password was never shown. Run the command again to get a new one.";
      lines = [
        `Password reset for ${r.email}. Their sessions were ended and they must change the password at their next login.`,
        ...(r.hasMfa ? ["The account still has MFA, so the first login also asks for a code. Run reset-mfa as well if that is lost too."] : []),
        ...(r.disabled ? ["Note: the account is disabled."] : []),
        "The temporary password is shown only now and is not stored anywhere in readable form. Hand it over privately.",
        `Temporary password: ${r.temporaryPassword}`, // last: if the output breaks, the secret is the thing that was not shown
      ];
    }
    return emit(io, lines, failed);
  } catch (err) {
    io.err(`Could not complete: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.unavailable;
  } finally {
    try {
      db?.close();
    } catch {
      /* the work is committed; a failing close must not turn success into failure */
    }
  }
}

/** Prints after the change is committed. A broken pipe here must not be reported as the change having failed. */
function emit(io: Io, lines: string[], failed: string): number {
  try {
    for (const line of lines) io.out(line);
    return EXIT.ok;
  } catch {
    try {
      io.err(failed);
    } catch {
      /* nowhere left to say it */
    }
    return EXIT.unavailable;
  }
}

function refuse(io: Io, error: string): number {
  io.err(error);
  return EXIT.refused;
}
