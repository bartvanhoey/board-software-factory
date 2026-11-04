# Software Factory: changes since v1.2.0

## What's new

01 Nov – 04 Nov 2026

### New features
- None in this period.

### Improvements
- The factory now closes the GitHub issue when you merge its pull request by hand. Before, the issue could stay open.
- The `latest` image on Docker Hub now moves forward with every release, so `docker compose pull` gets the newest version.
- The factory no longer hands the dashboard's private settings (the two-factor encryption key, email password, admin password and the board's GitHub tokens) to the coding agent or to your project's build and test commands. It gets only what it needs to do its work.
- The coding agent can no longer make the factory run a hook or helper program planted in a repository. Git hooks are now switched off for the factory's own git commands, so a project's own commit hooks (for example pre-commit checks) no longer run on the factory's commits.
- The review and test agents can no longer write files through `git diff --output`, or run helper programs through `--ext-diff` or `--textconv`.
- A flood of login attempts for made-up email addresses can no longer pile up without limit. Past 16 waiting logins the sign-in page says "The server is busy. Try again in a moment." and does not count those attempts against any account.

### Under the hood
- Documentation and a stale code comment were brought up to date.

### Good to know
- If you added your own variable to `.env` for the factory's runner (for example a proxy setting or a variable your project's build reads), it no longer reaches the runner automatically. Add it to the runner's `environment:` list in the compose file, and to the allowlist in `runner/src/process.ts`. Details are in `docker/README.md`.
