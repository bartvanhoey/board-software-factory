## What's new

08 Nov 2026

### Improvements
- When you recover an account from the server (a lost password or authenticator), you can now say who you are with `--operator`, and the audit log records that name together with the container it ran in. The name is a label you give yourself, not proof. The setup guide explains how to find out who really ran the command from the Docker host's own records.
- If you leave the first administrator's password in the setup file after the first start, the board now reminds you at every start to remove it.
