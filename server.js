import express from 'express';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 9000;
const GLOBAL_SECRET = process.env.WEBHOOK_SECRET || '';
const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve('./config/addons.json');
const GIT_SSH_COMMAND = process.env.GIT_SSH_COMMAND; // e.g. "ssh -i /run/secrets/deploy_key -o StrictHostKeyChecking=accept-new"

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.addons)) {
    throw new Error('config.addons must be an array');
  }
  for (const a of parsed.addons) {
    if (!a.repo || !a.path) {
      throw new Error(`addon entry missing "repo" or "path": ${JSON.stringify(a)}`);
    }
    a.branch = a.branch || 'main';
  }
  return parsed.addons;
}

let addons = loadConfig();
console.log(`Loaded ${addons.length} addon(s) from ${CONFIG_PATH}`);
addons.forEach(a => console.log(`  - ${a.repo} -> ${a.path} (${a.branch})`));

// Per-repo lock so overlapping webhooks don't run concurrent git commands.
// If a run is already in progress when a new push arrives, we mark it
// "pending" and re-run once the current one finishes (coalescing bursts).
const state = new Map(); // repo -> { busy: bool, pending: bool }

function getState(repo) {
  if (!state.has(repo)) state.set(repo, { busy: false, pending: false });
  return state.get(repo);
}

function verifySignature(secret, payloadBuffer, signatureHeader) {
  if (!secret) return true; // no secret configured -> skip verification (not recommended)
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payloadBuffer).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const givenBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

function execOpts(cwd) {
  const env = { ...process.env };
  if (GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = GIT_SSH_COMMAND;
  return { cwd, env };
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
    if (!fs.existsSync(gitDir)) {
      if (!addon.url) {
        throw new Error(`${addon.path} is not a git repo and no "url" set to clone from`);
      }
      fs.mkdirSync(addon.path, { recursive: true });
      console.log(`[${addon.repo}] no existing checkout, cloning ${addon.url} into ${addon.path}`);
      await execFileAsync(
        'git',
        ['clone', '--branch', addon.branch, '--single-branch', addon.url, '.'],
        execOpts(addon.path)
      );
    } else {
      console.log(`[${addon.repo}] fetching ${addon.branch} in ${addon.path}`);
      await execFileAsync('git', ['fetch', 'origin', addon.branch], execOpts(addon.path));
      await execFileAsync('git', ['reset', '--hard', `origin/${addon.branch}`], execOpts(addon.path));
      await execFileAsync('git', ['clean', '-fd'], execOpts(addon.path));
    }
    console.log(`[${addon.repo}] update complete`);

    if (addon.command) {
      console.log(`[${addon.repo}] running post-update command: ${addon.command}`);
      const [cmd, ...args] = addon.command.split(' ');
      await execFileAsync(cmd, args, execOpts(addon.path));
    }
  } catch (err) {
    console.error(`[${addon.repo}] update failed:`, err.message);
  } finally {
    s.busy = false;
    if (s.pending) {
      s.pending = false;
      runUpdate(addon);
    }
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

  const secret = addon.secret || GLOBAL_SECRET;
  if (!verifySignature(secret, req.body, signature)) {
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
