# gmod-addon-webhook

Small Node.js service that listens for GitHub `push` webhooks from one or
more **private** repos and `git pull`s the matching Garry's Mod addon
directory on the server. Built for Node 26, meant to run as a container
that Portainer builds from this repo.

```
me/addon1  --push-->  webhook  -->  git pull in /gmod/garrysmod/addons/addon1
me/addon2  --push-->  webhook  -->  git pull in /gmod/garrysmod/addons/addon2
```

## How it works

- `POST /webhook` receives GitHub's payload, verifies the `X-Hub-Signature-256`
  HMAC, matches `repository.full_name` against `config/addons.json`, and (on
  a push to the configured branch) runs `git fetch` + `git reset --hard` in
  that addon's directory.
- If the addon's directory has no `.git` yet, it clones it first (using the
  `url` field) — so adding a brand-new addon is just: add an entry to the
  config, push, done.
- Each repo has its own lock so a burst of pushes doesn't run concurrent git
  commands; pushes that arrive mid-update are coalesced into one re-run.
- `GET /healthz` for container health checks.
- `POST /reload-config` (with `X-Reload-Token` header) reloads
  `config/addons.json` without restarting the container.

## 1. Configure your addons

Copy `config/addons.example.json` to `config/addons.json` and edit it:

```json
{
  "addons": [
    {
      "repo": "me/addon1",
      "url": "git@github.com:me/addon1.git",
      "path": "/gmod/garrysmod/addons/addon1",
      "branch": "main"
    }
  ]
}
```

| field     | required | description |
|-----------|----------|-------------|
| `repo`    | yes | GitHub `owner/name`, must match `repository.full_name` in the payload |
| `path`    | yes | Absolute path inside the container where the addon lives |
| `url`     | only for auto-clone | SSH or HTTPS clone URL, used the first time (empty dir) |
| `branch`  | no  | Defaults to `main` |
| `secret`  | no  | Per-repo webhook secret override (else falls back to `WEBHOOK_SECRET`) |
| `command` | no  | Optional shell command run after a successful pull (e.g. a reload hook) |

`config/addons.json` is gitignored/dockerignored on purpose — mount it in as
a volume or bind-mount rather than baking it into the image, so you can add
addons without rebuilding.

## 2. Private repo access (SSH deploy keys)

Since the repos are private, the container needs credentials to pull.
Recommended approach — one **read-only deploy key per addon repo**:

1. `ssh-keygen -t ed25519 -f deploy_addon1 -N ""`
2. Add `deploy_addon1.pub` as a **read-only Deploy Key** on that addon's
   GitHub repo (Settings → Deploy keys).
3. Mount the private key into the container (e.g. `/run/secrets/deploy_key`)
   as a read-only Portainer/Docker secret or bind mount.
4. Set `GIT_SSH_COMMAND` env var:
   ```
   GIT_SSH_COMMAND=ssh -i /run/secrets/deploy_key -o StrictHostKeyChecking=accept-new
   ```

If all your addon repos belong to the same account and one key can read all
of them, you only need a single deploy key / one `GIT_SSH_COMMAND`. If they
need different keys per repo, use an SSH config file mounted in and matching
`Host` aliases in each addon's `url` instead (ask if you want that variant
written out).

## 3. Environment variables

Copy `.env.example` to `.env` (or set these in Portainer's stack env):

```
PORT=9000
WEBHOOK_SECRET=<shared secret, or set per-addon "secret">
CONFIG_PATH=/app/config/addons.json
RELOAD_TOKEN=<random string, for POST /reload-config>
GIT_SSH_COMMAND=ssh -i /run/secrets/deploy_key -o StrictHostKeyChecking=accept-new
```

## 4a. Deploying on Unraid (script repo → GHCR → Unraid template)

Unraid's Docker manager pulls pre-built images, it doesn't build from a git
repo directly. So the flow is: this repo builds itself into a private image
on every push, and the Unraid template just tracks that image.

1. **Enable the build workflow** — `.github/workflows/build-and-push.yml` is
   already in this repo. On every push to `main` it builds the `Dockerfile`
   here and pushes to `ghcr.io/<you>/gmod-addon-webhook:latest` (private by
   default, same visibility as the repo). No setup needed beyond pushing —
   it uses the repo's built-in `GITHUB_TOKEN`.
2. **Let Unraid pull a private GHCR image** — on the Unraid host:
   ```bash
   docker login ghcr.io -u YOUR_GH_USERNAME -p YOUR_GITHUB_PAT
   ```
   The PAT needs the `read:packages` scope. (Unraid keeps this credential
   for subsequent pulls/updates via the Docker tab.)
3. **Install the template** — `unraid-template.xml` in this repo is a ready
   Community-Applications-style template. Either:
   - Docker tab → Add Container → toggle "Template" and paste the raw URL
     to `unraid-template.xml` from your repo (works even for a private repo
     if you paste the raw file contents instead), or
   - copy it to `/boot/config/plugins/dockerMan/templates-user/` on the
     Unraid box and it'll show up under "My Templates".
   Edit `YOUR_GH_USERNAME` in the `Repository`/`Icon`/`Support` fields first.
4. **Fill in the template's paths** (all editable in the Unraid UI after
   adding the container):
   - `Addons Config` → a `config/addons.json` you've created under
     `/mnt/user/appdata/gmod-addon-webhook/`
   - `Deploy Key` → the SSH private key file for pulling the addon repos
   - `GMod Addons Directory` → wherever your actual GMod server's `addons/`
     folder lives, mounted in so the paths inside `addons.json` resolve
   - `Webhook Secret` → same value you'll set on each addon repo's webhook
5. **Updating the script itself**: push to this repo → Action rebuilds the
   image → on Unraid, Docker tab shows an "update ready" icon on the
   container (or use the Unraid *Auto Update Applications* plugin / *Watchtower*
   if you want it to redeploy the script itself automatically). This is
   separate from, and unrelated to, the addon-pull webhook logic below —
   the webhook only ever touches the *addon* directories, never the script
   container itself.

## 4b. Docker / Portainer (alternative to Unraid)

- This repo has a `Dockerfile` (Node 26 alpine + git + openssh-client)
  that Portainer can build directly by pointing a Stack/Container at this
  private repo.
- You need to mount/bind:
  - your GMod `addons/` tree (or each addon's parent dir) into the
    container at the paths used in `addons.json`
  - `config/addons.json` (so you can edit it without rebuilding)
  - the deploy key(s) for git auth
- Example `docker-compose.yml` for Portainer:

```yaml
services:
  addon-webhook:
    build: .
    restart: unless-stopped
    ports:
      - "9000:9000"
    environment:
      - PORT=9000
      - WEBHOOK_SECRET=${WEBHOOK_SECRET}
      - RELOAD_TOKEN=${RELOAD_TOKEN}
      - GIT_SSH_COMMAND=ssh -i /run/secrets/deploy_key -o StrictHostKeyChecking=accept-new
    volumes:
      - ./config/addons.json:/app/config/addons.json:ro
      - /path/on/host/garrysmod/addons:/gmod/garrysmod/addons
      - /path/on/host/deploy_key:/run/secrets/deploy_key:ro
```

## 5. GitHub webhook setup (per addon repo)

On each addon repo: **Settings → Webhooks → Add webhook**

- Payload URL: `https://your-server:9000/webhook`
- Content type: `application/json`
- Secret: same value as `WEBHOOK_SECRET` (or the addon's `secret` override)
- Events: just the **push** event
- SSL: enabled if you're on https (strongly recommended — put this behind
  a reverse proxy with TLS, e.g. Caddy/nginx/Traefik, rather than exposing
  it directly)

GitHub will send a `ping` event immediately on save — the server replies
`200 pong` to that so you can confirm connectivity before doing a real push.

## 6. Testing locally

```bash
npm install
CONFIG_PATH=./config/addons.json WEBHOOK_SECRET=testsecret node server.js
```

```bash
BODY='{"ref":"refs/heads/main","repository":{"full_name":"me/addon1"}}'
SIG=$(node -e "const c=require('crypto');process.stdout.write('sha256='+c.createHmac('sha256','testsecret').update(process.argv[1]).digest('hex'))" "$BODY")
curl -X POST http://localhost:9000/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: $SIG" \
  --data-raw "$BODY"
```

## Notes / things to double check for your setup

- The addon directories need to be writable by whatever user the container
  runs as (Alpine `node` image runs as root by default unless you add a
  `USER` — GMod addon dirs are often owned by a specific `gmod` uid on the
  host, so you may need to align permissions or add `USER` + `chown`).
- `git clean -fd` runs after every pull to remove files deleted upstream —
  remove that line if you don't want deletions enforced.
- Nothing here restarts the actual Garry's Mod server process; addon file
  changes are picked up per Garry's Mod's normal behavior (map
  change/restart for most Lua addons). If you want an automatic RCON
  restart or map change after an update, that's what the per-addon
  `command` field is for.
