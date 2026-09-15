import express from 'express';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

try {
  process.loadEnvFile();
} catch (err) {
  if (err.code !== 'ENOENT') throw err; // ignore "no .env file", surface anything else
}

const PORT = 9000;
const CONFIG_PATH = path.resolve('./config/config.json');
const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.addons)) {
    throw new Error('config.addons must be an array');
  }
  for (const a of parsed.addons) {
    console.log(a.repo);
    if (!a.repo || !a.path || !a.pat || !a.secret) {
      throw new Error(
        `addon entry missing one of "repo", "path", "pat", "secret": ${JSON.stringify({ repo: a.repo, path: a.path })}`
      );
    }
    a.branch = a.branch || 'main';
  }
  return parsed.addons;
}

let addons = loadConfig();
console.log(`Loaded ${addons.length} addon(s) from ${CONFIG_PATH}`);
addons.forEach(a => console.log(`  - ${a.repo} -> ${a.path} (${a.branch})`));

// Trust every addon's mounted directory for git, in one shot at startup.
// Host-mounted volumes are usually owned by a different UID than the
// container's git process, which trips git's "dubious ownership" check
// (CVE-2022-24765). This container only ever touches these specific
// addon paths, so trusting them globally is safe for this use case.
try {
  await execFileAsync('git', ['config', '--global', '--add', 'safe.directory', '*']);
} catch (err) {
  console.error('failed to set safe.directory:', err.message);
}

// Per-repo lock so overlapping webhooks (or a webhook landing mid-poll)
// don't run concurrent git commands. If a run is already in progress when
// another trigger comes in, we mark it "pending" and re-run once the
// current one finishes (coalescing bursts).
const state = new Map(); // repo -> { busy: bool, pending: bool }

function getState(repo) {
  if (!state.has(repo)) state.set(repo, { busy: false, pending: false });
  return state.get(repo);
}

function verifySignature(secret, payloadBuffer, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payloadBuffer).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const givenBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

async function runUpdate(addon) {
  const s = getState(addon.repo);
  if (s.busy) {
    s.pending = true;
    console.log(`[${addon.repo}] update already running, queued`);
    return;
  }
  s.busy = true;
  try {
    const gitDir = path.join(addon.path, '.git');
    const url = `https://github.com/${addon.repo}.git`
    const authed = `https://${addon.pat}@github.com/${addon.repo}.git`

    if (!fs.existsSync(gitDir)) {
      fs.mkdirSync(addon.path, { recursive: true });
      console.log(`[${addon.repo}] no existing checkout, cloning into ${addon.path}`);
      await execFileAsync('git', ['init'], { cwd: addon.path });
      // Remote stays the clean, tokenless URL — the PAT is only ever
      // supplied explicitly per-fetch, never stored in this repo's config.
      await execFileAsync('git', ['remote', 'add', 'origin', url], { cwd: addon.path });
      await execFileAsync('git', ['fetch', '--depth', '1', authed, addon.branch], { cwd: addon.path });
      await execFileAsync('git', ['checkout', '-B', addon.branch, 'FETCH_HEAD'], { cwd: addon.path });
    } else {
      console.log(`[${addon.repo}] fetching ${addon.branch} in ${addon.path}`);
      await execFileAsync('git', ['fetch', authed, addon.branch], { cwd: addon.path });
      await execFileAsync('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: addon.path });
      await execFileAsync('git', ['clean', '-fd'], { cwd: addon.path });
    }
    console.log(`[${addon.repo}] update complete`);
  } catch (err) {
    // Strip the token out of any error text before logging, in case git
    // ever echoes the URL back (e.g. in a "repository not found" error).
    const msg = addon.pat ? err.message.split(addon.pat).join('***') : err.message;
    console.error(`[${addon.repo}] update failed:`, msg);
  } finally {
    s.busy = false;
    if (s.pending) {
      s.pending = false;
      runUpdate(addon);
    }
  }
}

// Checks every configured addon. Used on startup and on the recurring
// timer below — a safety net that catches any push whose webhook never
// arrived (delivery failure, downtime, addon added but no webhook set up
// yet, etc). Reloads config.json first so newly added/removed addons are
// picked up without a restart.
async function checkAllAddons() {
  try {
    addons = loadConfig();
  } catch (err) {
    console.error('failed to reload config.json for scheduled check:', err.message);
    return;
  }
  console.log(`Running scheduled check for ${addons.length} addon(s)...`);
  for (const addon of addons) {
    runUpdate(addon); // fire-and-forget; per-repo lock keeps this safe alongside webhooks
  }
}

const app = express();

// Raw body is required so we can verify the HMAC signature against the
// exact bytes GitHub sent, before any JSON parsing/re-serialization.
app.use('/webhook', express.raw({ type: 'application/json', limit: '5mb' }));

app.post('/webhook', (req, res) => {
  const event = req.header('X-GitHub-Event');
  const signature = req.header('X-Hub-Signature-256');
  const delivery = req.header('X-GitHub-Delivery');

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf-8'));
  } catch {
    return res.status(400).send('invalid json');
  }

  const repoFullName = payload.repository && payload.repository.full_name;
  if (!repoFullName) return res.status(400).send('no repository in payload');

  const addon = addons.find(a => a.repo.toLowerCase() === repoFullName.toLowerCase());
  if (!addon) {
    console.warn(`[${repoFullName}] no matching addon config, ignoring (delivery ${delivery})`);
    return res.status(404).send('unknown repo');
  }

  if (!verifySignature(addon.secret, req.body, signature)) {
    console.warn(`[${repoFullName}] signature verification failed (delivery ${delivery})`);
    return res.status(401).send('invalid signature');
  }

  if (event === 'ping') {
    return res.status(200).send('pong');
  }
  if (event !== 'push') {
    return res.status(200).send(`ignored event: ${event}`);
  }

  const expectedRef = `refs/heads/${addon.branch}`;
  if (payload.ref !== expectedRef) {
    console.log(`[${repoFullName}] push to ${payload.ref}, ignoring (watching ${expectedRef})`);
    return res.status(200).send('ignored ref');
  }

  res.status(202).send('accepted');
  runUpdate(addon);
});

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Optional: let you add/remove addons without restarting the container.
app.post('/reload-config', (req, res) => {
  const token = req.header('X-Reload-Token');
  if (!process.env.RELOAD_TOKEN || token !== process.env.RELOAD_TOKEN) {
    return res.status(401).send('unauthorized');
  }
  try {
    addons = loadConfig();
    res.status(200).send(`reloaded ${addons.length} addon(s)`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});

// Check everything once at boot, then on a fixed 30-minute cadence.
checkAllAddons();
setInterval(checkAllAddons, POLL_INTERVAL_MS);