# Docker sandbox

Hardened container for the factory runner and dashboard. The entrypoint prints the toolchain
versions and then runs the given command.

## Use

```
cp .env.example .env        # fill in RUNNER_GITHUB_TOKEN and ANTHROPIC_API_KEY
docker compose build
docker compose run --rm --no-deps runner true   # prints toolchain versions
bash docker/smoke.sh                            # verifies the hardening
docker compose up -d                            # starts the runner (idle unless SCHEDULER_ENABLED=true) and the dashboard
docker compose down
```

## Services

Both run the same image.

| Service | Command | Notes |
| --- | --- | --- |
| `runner` | `runner schedule` (idle unless `SCHEDULER_ENABLED=true`) | gets only the variables it needs from `.env` (`RUNNER_GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, `RUNNER_API_TOKEN`, `SCHEDULER_*`) and fetches the projects from `web`; run lanes with `docker compose exec runner npm run runner -- ...`, see `runner/README.md` |
| `web` | `next start` on port 2999 | dashboard at http://localhost:2999, bound to `127.0.0.1` only |

The dashboard has a login, but it is served over plain http, so the port is published on localhost only. To expose it
beyond localhost, put a TLS proxy in front first (then set `COOKIE_SECURE=true`), and only then change the port mapping.

`web` never receives the runner's `RUNNER_GITHUB_TOKEN` (which can write branches and pull requests) or
`ANTHROPIC_API_KEY`. It reads `BOARD_GITHUB_TOKEN` from `.env`, which must be read-only, and the optional,
separate `CREATE_ISSUE_GITHUB_TOKEN` with Issues: read/write access for creating issues. Leave the board token empty to see demo data.
The reverse holds too: `runner` receives only the variables listed under its `environment:` in compose, not the whole `.env`, and
the processes it starts (the agent, git, `gh`, your project's build and test commands) get a smaller allowlist of those
(`childEnv` in `runner/src/process.ts`). A variable the runner needs that is not on either list (for example a proxy setting)
has to be added to both.
Its code is baked into the image, so rebuild after changes: `docker compose up -d --build`.

## Dashboard login settings

`web` keeps users, sessions and the audit log in SQLite (`auth.db`) on the `auth` named volume, mounted at
`/auth` in `web` only. The runner never sees it. Use a named volume, not a bind mount: SQLite locking on a
Windows folder is unreliable. Back up the volume, and keep `MFA_ENCRYPTION_KEY` safe separately.

`web` validates these at startup and exits with code 1, naming each bad variable (never its value), so
`docker compose logs web` shows the reason. Compose passes them to `web` one by one, never via `env_file`.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `MFA_ENCRYPTION_KEY` | yes | | 32 random bytes, base64. Encrypts MFA secrets at rest. Lose it and every user must re-enroll MFA. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | no | | First admin, created on first start only when no admin exists. Set both or neither; password 12-128 characters. Remove `ADMIN_PASSWORD` from `.env` afterwards. |
| `EMAIL_VERIFICATION` | no | `false` | `true` turns on email verification and "forgot password" by email (see "Email verification" below) and makes `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` and `APP_URL` required. |
| `APP_URL` | with verification | | The public address of the site, an origin with no path (`https://board.example.com`), used for every link in an email. `https` is required except for `localhost`. It is never taken from the request, which a visitor controls. |
| `COOKIE_SECURE` | no | on in production | Set `false` for plain http on localhost. Exposing the dashboard beyond localhost needs a TLS proxy. |
| `TRUST_PROXY` | no | `false` | `true` when a reverse proxy you control sets `X-Forwarded-For`; enables per-IP login and registration limits. Leave `false` otherwise: the header is spoofable, and logins are then throttled per account only. Only use `true` when the proxy is the sole way in; if port 2999 is also reachable directly, clients can forge the header and dodge the per-IP limits. |
| `AUTH_DB_PATH` | no | `/auth/auth.db` | Set by compose. |

Roles and administration: `admin` includes `issue-admin` and `viewer`, and `issue-admin` includes `viewer`. Admins use
`/admin/users` to give accounts roles (a new account sees only the waiting page until then), disable or enable
accounts, and reset passwords. A reset shows a temporary password once, forces a change at next login and ends that
user's sessions. Admins cannot remove their own admin role, disable themselves or reset their own password, and at
least one active admin must always remain. `/admin/audit` is a read-only, filterable log of who did what. Users are
disabled, never deleted. Role changes take effect on the next request; they do not end sessions.

Multi-factor authentication (TOTP, any authenticator app): it is off by default, admins included. An admin can require it for any
user, other admins and themselves too, and users can turn it on for themselves. Turning it on shows a QR code and ten one-time recovery codes (shown once). After the password, a user with MFA
has five minutes to enter a code; until then the session grants nothing. A code can be used only once, and wrong
guesses are delayed like password guesses. Users can get new recovery codes or replace their authenticator at
`/account/mfa` (both need a current code). Only an admin can turn MFA off for a non-admin ("Stop requiring MFA" or Reset MFA on the users
screen). An admin turns their own off at `/account/mfa` with a current code, once MFA is no longer required for them;
another admin's MFA can only be reset from the server (see "Break-glass recovery" below).
An admin who has MFA cannot be demoted from the app (that would make their MFA resettable by a stolen admin session):
disable the account instead, or reset their MFA from the server first. MFA secrets and recovery-code hashes are derived from `MFA_ENCRYPTION_KEY`: lose that key,
or change it, and every user must set MFA up again (there is no key rotation yet). The key must be random bytes.
Admin actions that weaken another account (reset password, reset MFA, require/stop requiring MFA) do not ask for a fresh
code yet, so a stolen, still-valid admin session can use them; admin sessions are short (1 h idle) for that reason.

## Email verification and password reset

Off by default: nothing is sent, and passwords are reset by an admin or the break-glass command. With
`EMAIL_VERIFICATION=true`:

- **Registration** sends a link; until it is confirmed the account is held on a "check your email" page, ahead of MFA
  setup. Links work once and expire after 24 hours; a new link replaces the old one (an earlier link keeps working if
  the new one could not be sent). The first admin counts as confirmed.
- **Confirming needs the inbox and the account's own login.** Opening the link while logged out says to log in first,
  then open it again. Otherwise someone could register an address that is not theirs, with a password they know, and
  the real owner opening the link in their own inbox would confirm the squatter's account. The owner cannot log in to
  that account, so the link does nothing for them; they use "Forgot your password?", which replaces the password, ends
  the squatter's sessions and confirms the address. Unconfirmed accounts are never removed automatically; an admin can
  disable them.
- **Existing users when you switch it on** are held the same way on their next click, sessions included, and no mail
  has been sent to them yet: their page says so and offers to send one. An admin can press "Mark email confirmed" on the
  users screen for an address that cannot receive mail (a typo, say).
- **Forgot password** is on the login page. It always answers "if that address has an account, we sent a link", whether
  or not there is an account, and the work that depends on the account happens after the answer, so the response time
  does not show it (the difference is milliseconds of local work; that is not a hard guarantee). It does not hide which
  addresses exist from someone who tries to register them, which says "already exists". The link works once for an
  hour, ends all the user's sessions, and does not skip MFA: the next login still asks for a code. Using it also
  confirms the address. Any password change (the user's, an admin's, the break-glass command's, another reset) or
  disabling the account ends the unused reset links, so changing a password to evict an intruder also kills any link
  they can see in the inbox.
- Opening a link only shows a button or a form: confirming and resetting are POSTs, because mail scanners open links
  before people do. If your mail provider rewrites links for click tracking, turn that off: the token would pass through it.
- **Limits:** one email a minute and five an hour per address, ten an hour per IP (only with `TRUST_PROXY`), and two
  separate budgets of 40 an hour in total (one for "forgot password" mail, one for registration and resend), so the
  relay and strangers' inboxes cannot be used as a mail cannon and using up one budget does not stop the other. Requests
  for unknown addresses use none of this. Known trade-offs of having no login on "forgot password": a stranger can use
  up a budget for an hour, and someone who knows an address can use up its five mails an hour so its owner gets none
  (and is told nothing). An admin resetting the password is the fallback.
- **SMTP:** port 465 uses TLS from the first byte; any other port must offer STARTTLS or nothing is sent. The certificate
  is always verified (to use a private CA, point `NODE_EXTRA_CA_CERTS` at it). Messages are plain text, and one send is
  given up on after 30 seconds. SMTP is not checked at startup, and logins never need it: if the relay is down only
  registration, resend and reset are affected, and a failed send is logged (error code only, addresses blanked) and
  audited (`email.send_failed`) but not retried. The audit log records `email.verification_sent` (only once actually
  sent), `email.verified`, `password.reset_requested`, `password.reset_by_email` and `email.verified_by_admin`, only for
  real accounts; as it can never be pruned, the budgets also bound how fast it can grow from this.

## Break-glass recovery

When the web app cannot help (an admin lost their authenticator and recovery codes, or the only admin forgot their
password), run the recovery command inside the `web` container. Access to the server is the authorisation, so there is
no login:

```
docker compose exec web npm run admin -- reset-mfa      --email <email> --reason "<why>"
docker compose exec web npm run admin -- reset-password --email <email> --reason "<why>"
```

- `reset-mfa` removes the user's authenticator, any half-finished setup and recovery codes, and ends all their
  sessions. It works on admins. Anyone MFA is required for (admins included, when an admin turned that on) sets MFA up
  again at their next login, after the password. For an account with no MFA at all it changes nothing, not even the sessions (`reset-password` ends those).
- `reset-password` sets a temporary password, printed once on your terminal, that must be changed at next login, and
  ends all their sessions. It does not touch MFA, so a lost password alone never removes a second factor.
- Lost both? Run both, hand the temporary password over privately, and they log in, change it and, if MFA is required for them, set it up again.
- **If an admin's password may be compromised, run `reset-password` first, or both.** After `reset-mfa` alone an admin can
  log in with just the old password until MFA is set up again, and whoever logs in first sets up their own authenticator.
- `--reason` is required: one line, up to 200 characters, with some real text in it and no control or invisible
  characters. Every change is recorded in the audit log as `mfa.reset_by_cli` or `password.reset_by_cli`, with no
  actor, `via: "cli"` and your reason. Runs that change nothing, or are refused (unknown account, unusable reason), are
  not recorded.
- It only runs against an existing, non-empty auth database, so a mistyped `AUTH_DB_PATH` cannot create an empty one,
  and it needs no other setting (a broken SMTP value, say, does not block a recovery). It refuses to run as root, which
  could leave database files the web app cannot write: use `docker compose exec` without `-u root`. Exit codes: 0 done
  or nothing to do, 1 unknown account or unusable reason, 64 usage, 69 database or environment. If the output breaks
  after the change (a closed terminal), it says so with 69; for `reset-password` just run it again for a new password.
- Whoever can run `docker exec` (the `docker` group on Linux, Docker Desktop users on Windows) can use it on any
  account, including admins. They could already read the database and the `.env` secrets, but the audit log now shows
  it was done. The temporary password stays in your terminal scrollback, so do not run it where output is logged.
- If there is no admin at all, `ADMIN_EMAIL` and `ADMIN_PASSWORD` create one again at the next start.

Login, registration, the waiting page (for accounts without a role) and password change are live. The first admin
comes from `ADMIN_EMAIL` and `ADMIN_PASSWORD` and must change its password at first login. Public routes are
`/login`, `/register` and `/api/health` (the container healthcheck, which answers only `ok` or an error); everything
else needs a session. Behind a TLS proxy, set `serverActions.allowedOrigins` in `web/next.config.ts` to the public
host, because Next rejects actions whose `Origin` differs from `Host`.

On Windows Git Bash, prefix with `MSYS_NO_PATHCONV=1` if paths get mangled.

## Toolchain (all pinned)

| Tool | Version | Pinned by |
| --- | --- | --- |
| Node base image | 22 (bookworm-slim) | image digest |
| .NET SDK | 8.0.x | image digest of `dotnet/sdk:8.0-bookworm-slim` |
| npm | 12.2.1 | npm version (install scripts blocked unless allowlisted) |
| GitHub CLI | 2.87.3 | version + sha256 per arch |
| Claude Code | 2.1.308 | npm version |

To bump a base image: `docker pull <tag>`, `docker inspect --format '{{index .RepoDigests 0}}' <tag>`, update the digest in `Dockerfile`.

## Hardening

| Setting | Effect |
| --- | --- |
| non-root user `factory` (uid 10001) | no root, no sudo, no login shell |
| `read_only: true` | root filesystem is immutable |
| `tmpfs` on `/tmp` (noexec) and `/home/factory` | scratch space only, wiped on restart |
| named volumes `workspace`, `data`, `cache`, `auth` | the only persistent writable paths (`cache` holds the NuGet packages, `NUGET_PACKAGES=/cache/nuget`; `auth` is mounted in `web` only) |
| `cap_drop: [ALL]` | empty capability set |
| `no-new-privileges` | setuid binaries cannot escalate |
| `pids_limit`, `mem_limit`, `cpus` | fork-bomb and runaway guards |
| secrets via `.env` only | none in the image or its env |

## Not covered yet

- Network egress is unrestricted. The agent runs untrusted code, so an allowlist
  (GitHub, Anthropic, NuGet/npm registries) is the next hardening step.
- One shared image for all stacks. Per-stack images come later.
- `HOME` is wiped on restart: the runner must authenticate from env vars each start.
