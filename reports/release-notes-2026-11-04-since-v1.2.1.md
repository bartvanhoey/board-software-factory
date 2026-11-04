# Software Factory: changes since v1.2.1

## What's new

04 Nov 2026

### New features
- None in this period.

### Improvements
- Only a project manager or an administrator can now start factory work on a new issue from the board. Members can still create issues, but the "Start factory work" option is no longer offered to them, and a request that tries to set it is refused. A manager labels a member's issue `ready` when it should be built, so someone you trust reads it first.
- The factory no longer hands its GitHub token to the coding agent or to your project's build and test commands. Only the factory's own pushes and GitHub calls use it.

### Under the hood
- Tests and documentation were extended to cover both changes.

### Good to know
- If members used to start builds by ticking "Start factory work", a project manager or administrator now has to add the `ready` label on GitHub instead.
- If a build or test command of yours relied on the factory's GitHub token being available (for example it calls `gh`, or fetches a private package with it), give that command its own token. Details are in `docker/README.md`.
