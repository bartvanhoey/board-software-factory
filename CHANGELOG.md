# Changelog

## Unreleased — 2026-11-04 (since v1.2.0)

### 🔒 Security
- `0218449` fix: bound the scrypt queue so a login flood cannot grow it without limit
- `f22af03` fix: deny git diff/log --output, --ext-diff and --textconv for the agents
- `7cb3679` fix: pin the runner's git calls against repo-planted hooks and fsmonitor
- `68a16b0` fix: give the runner an explicit environment and make childEnv an allowlist

### 🐛 Bug fixes
- `e39491c` fix: close the issue when a human merges its issue-<n> PR
- `f623103` fix: push the latest tag to Docker Hub on release

### 📝 Documentation
- `5b4105e` docs: replace the stale placeholder comment in docker/entrypoint.sh

---
7 commits (7 pull requests) · 26 files changed · 01 Nov – 04 Nov 2026

## v1.0.0 — 2026-11-01

### ✨ Features
- `59045ed` feat: publish the image to Docker Hub on version tags (amd64 + arm64, `docker-compose.release.yml`)
- `7c9424c` feat: accept a pasted GitHub address when adding a project
- `d840c63` feat: simplify adding a project to a repository, a name and a branch
- `0424e0f` feat: make the web application mobile friendly
- `eeeb627` feat: tint each board card with its project's color
- `111a835` feat: let an admin archive and restore a project in /admin/projects
- `5978958` feat: show a Go to the board button after an admin turns their own MFA off
- `22d9df3` feat: stop requiring MFA removes a non-admin's authenticator; admins turn their own off with a code
- `f28a0df` feat: let an admin require or stop requiring MFA on their own row
- `9a7ee5f` feat: make MFA optional for administrators by default
- `eb97413` feat: manage projects in the web app and fetch them from the runner
- `b2a0882` feat: add a scheduler that runs the lanes automatically for every enabled project
- `a80d6aa` feat: add email verification and password reset by email to web
- `dffc878` feat: add a break-glass command to reset a user's MFA or password
- `6db7016` feat: add TOTP multi-factor authentication to web
- `fd48984` feat: implement theme toggle and update dark mode handling
- `c3dac02` feat: add role management, admin user screen and audit log screen to web
- `e0b4c8e` feat: add login, registration, sessions and security headers to web
- `56c7d17` feat: add auth.db, migrations and startup config validation to web
- `ec581c9` feat: let qa and review see what earlier rounds asked for
- `1385842` feat: rework a card that qa or review sent back
- `0784da8` feat: commit the builder's changes when it forgets to
- `2bf6dde` feat: add the review lane, and open the PR only after an approval
- `9449844` feat: add the qa lane to the runner
- `e4267f7` feat: add runner workspace with the build lane and label setup
- `564515f` feat: add read-only web dashboard and run it in Docker
- `2fcc901` feat: add hardened Docker sandbox for the runner
- `e756bbb` feat: add shared zod schemas and project registry

### ⚠️ Breaking
- `d708cab` breaking: rename ISSUE_GITHUB_TOKEN to CREATE_ISSUE_GITHUB_TOKEN

### 🐛 Bug fixes
- `97ff92f` fix: link the issue form's error banner to its fields (WCAG 3.3.1)
- `b22f2ec` fix: resolve WCAG 2.2 AA accessibility failures found in the audit
- `b5ace0f` fix: match the AuthCard height offset to the TopBar so the card is centered
- `1b165d4` fix: keep the theme and account buttons on screen on narrow phones
- `0c8de43` fix: import projects switched off and start the runner only once web is healthy
- `7960544` fix: only lift a non-admin's MFA when the requirement actually changes; re-check disableOwnMfa under the lock
- `a20f78e` fix: keep an old GH_TOKEN working and name the right variable in the gh login error
- `f399ada` fix: smoke test expects the dashboard to redirect to /login
- `b1d518f` fix: skip cards the review lane already approved
- `cd16c7b` fix: let the theme script run under the nonce CSP
- `cb5ea01` fix: use the project's default branch in the qa prompt
- `f751b98` fix: keep the NuGet cache on a volume, not in the RAM-backed HOME

### 🎨 UI / Style
- `5875d5d` style: redesign the web app on a shared design system
- `028386d` style: make the top bar links and menu items at least 40px tall on touch screens
- `6ecfbc4` style: make the project form and checkboxes easier to use on a phone
- `553273c` style: center auth forms horizontally and vertically in AuthCard
- `79ec142` style: mute the dark mode tint of the board cards

### ♻️ Refactoring
- `bf6892d` refactor: name the GitHub tokens by what they are for
- `a3ffaec` revert: drop the GH_TOKEN fallback in docker-compose.yml, it is not needed

### 📝 Documentation
- README and docs: Getting Started, scheduler settings, MFA, login, Docker, CI badge, Issue Board GIF, WCAG audit report archived (`501538a`, `36b7f59`, `65517f5`, `fa521bd`, `adfbfe5`, `eacab4f`, `5d4db9b` and others)

### 🔧 Maintenance / CI / Tests
- `e703535` ci: build and test on every push and pull request
- `2a9b174`, `52018d3` test: check who may use lookupBranchAction
- `8d59b29` feat: add recovery-codes-mfa.png to .gitignore
- `1108367` chore: add BlazorEmployeeManagement solution and .gitignore
- `d312854` remove unused images, favicon, components and scripts

### 📦 Other
- `d017de4` Initial commit

---
134 commits · 207 files changed · 2026-10-23 – 2026-11-01
