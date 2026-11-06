# Install from Docker Hub

No source code or build needed: you only need [Docker](https://docs.docker.com/get-docker/) and two files.

1. Make a folder and download `docker-compose.release.yml` and `.env.example` into it:

   ```bash
   mkdir software-factory && cd software-factory
   curl -fsSLO https://raw.githubusercontent.com/bartvanhoey/software-factory-board/main/docker-compose.release.yml
   curl -fsSLO https://raw.githubusercontent.com/bartvanhoey/software-factory-board/main/.env.example
   ```

2. Copy `.env.example` to `.env` in the same folder and fill in the variables, as described in step 2 of [Build from source](../README.md#build-from-source). Optionally add `FACTORY_VERSION=1.0.0` to pin a version (default: `latest`).

3. Start it:

   ```bash
   docker compose -f docker-compose.release.yml up -d
   ```

   Run every later `docker compose` command with the same `-f docker-compose.release.yml`, from this same folder.

4. Open <http://localhost:2999> and continue with steps 4 and 5 of [Build from source](../README.md#build-from-source). Add your repositories on the **Projects** screen.

## Publishing a release (maintainers)

Set up the repository once (Settings on GitHub):

1. **Environment.** Create an environment named `release` (Settings → Environments). Under *Deployment branches and tags*
   choose *Selected branches and tags* and add the **tag** pattern `v*.*.*`, so only a run for a version tag can use it.
   Optionally add a required reviewer, so each publish waits for approval.
2. **Secrets.** Add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub access token with Read & Write) as secrets of
   that environment, not of the repository. A repository secret can be read by a workflow on any branch, so if the same
   names still exist under *Settings → Secrets and variables → Actions → Repository secrets*, delete them.
3. **Tag ruleset.** Create a tag ruleset (Settings → Rules) for `v*` that blocks deleting, updating and force-moving
   tags, so a published version always points at the commit it was built from. To remove a wrong tag, disable the
   ruleset for that moment.

Then push a version tag. The [Release workflow](../.github/workflows/release.yml) first runs the CI checks on the tagged commit and stops if they fail; otherwise it builds the image for `linux/amd64` and `linux/arm64` and pushes it as `<username>/software-factory-board:1.2.3`, `:1.2` and `:latest`.

```bash
git tag v1.0.0 && git push origin v1.0.0
```

The image name in `docker-compose.release.yml` must match your Docker Hub username.
