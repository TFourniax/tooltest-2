import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = process.cwd();

function exec(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 60000,
    env: { ...process.env, ...(options.env || {}) },
    shell: Boolean(options.shell)
  });
}

function npm(args, options = {}) {
  return exec('npm', args, { ...options, shell: process.platform === 'win32' });
}

function git(cwd, ...args) {
  return exec('git', args, { cwd });
}

function idleproof(bin, cwd, args, { input = null, expect = 0, timeout = 10000 } = {}) {
  const proc = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    input,
    encoding:'utf8',
    timeout,
    env:process.env,
    windowsHide:true
  });
  if (proc.error) throw proc.error;
  assert.equal(proc.status, expect, `idleproof ${args.join(' ')} exited ${proc.status}\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`);
  return proc;
}

function hook(bin, cwd, event) {
  return idleproof(bin, cwd, ['hook'], { input:`${JSON.stringify({ cwd, ...event })}\n` });
}

function serverInfo(project) {
  return JSON.parse(fs.readFileSync(path.join(project, '.idleproof', 'server.json'), 'utf8'));
}

async function api(base, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-human-smoke-'));
let tarball = null;
let project = null;
let bin = null;
let serverPid = null;
try {
  const packed = JSON.parse(npm(['pack', '--json'], { cwd:ROOT }));
  assert.ok(Array.isArray(packed) && packed[0]?.filename, 'npm pack did not produce the release artifact');
  tarball = path.resolve(ROOT, packed[0].filename);

  const consumer = path.join(temp, 'consumer');
  fs.mkdirSync(consumer, { recursive:true });
  npm(['init', '-y'], { cwd:consumer });
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd:consumer, timeout:60000 });
  bin = path.join(consumer, 'node_modules', 'idleproof', 'bin', 'idleproof.mjs');
  assert.ok(fs.existsSync(bin), 'installed package has no CLI');

  project = path.join(temp, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive:true });
  git(project, 'init', '-q');
  git(project, 'config', 'user.email', 'human-smoke@idleproof.local');
  git(project, 'config', 'user.name', 'IdleProof Human Smoke');
  fs.writeFileSync(path.join(project, 'src', 'stripe.ts'), `
    import Stripe from 'stripe';
    export const route = '/api/webhooks/stripe';
    export async function handleStripeWebhook(payload) { return payload; }
  `);
  git(project, 'add', '.');
  git(project, 'commit', '-qm', 'baseline');

  const on = idleproof(bin, project, ['on', '--agent', 'claude', '--no-open'], { timeout:15000 });
  assert.match(on.stdout, /IdleProof Local cockpit:/i);
  assert.match(on.stdout, /Terminal is free/i);
  let info = serverInfo(project);
  serverPid = info.pid;
  assert.ok(Number.isInteger(info.port) && info.port > 0);
  let base = `http://127.0.0.1:${info.port}`;
  let health = await api(base, '/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body?.ok, true);
  assert.equal(health.body?.instanceId, info.instanceId);

  const sessionId = 'human-stripe-session';
  hook(bin, project, {
    session_id:sessionId,
    hook_event_name:'UserPromptSubmit',
    prompt:'Make handleStripeWebhook idempotent and verify the Stripe webhook signature'
  });
  hook(bin, project, {
    session_id:sessionId,
    hook_event_name:'PreToolUse',
    tool_name:'Edit',
    tool_input:{ file_path:path.join(project, 'src', 'stripe.ts') }
  });
  fs.writeFileSync(path.join(project, 'src', 'stripe.ts'), `
    import Stripe from 'stripe';
    export const route = '/api/webhooks/stripe';
    const processed = new Set();
    export async function handleStripeWebhook(payload, signature) {
      const event = Stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET);
      if (processed.has(event.id)) return { duplicate:true };
      processed.add(event.id);
      return { accepted:true };
    }
  `);
  const delivered = hook(bin, project, {
    session_id:sessionId,
    hook_event_name:'PostToolUse',
    tool_name:'Edit',
    tool_input:{ file_path:path.join(project, 'src', 'stripe.ts') }
  });
  assert.ok(delivered.stdout.trim(), 'installed Claude hook emitted no Explain-first message after a meaningful edit');
  const hookEnvelope = JSON.parse(delivered.stdout.trim());
  const visibleMessage = String(hookEnvelope.systemMessage || '');
  assert.match(visibleMessage, /IdleProof · what this means in your project/i);
  assert.match(visibleMessage, /src\/stripe\.ts/i);
  assert.match(visibleMessage, /handleStripeWebhook|webhooks\/stripe|Stripe/i);
  assert.match(visibleMessage, /Why it matters:/i);
  assert.match(visibleMessage, /Understanding checks are optional/i);
  assert.doesNotMatch(visibleMessage, /undefined|\[object Object\]/i);

  const duplicate = hook(bin, project, {
    session_id:sessionId,
    hook_event_name:'PostToolUse',
    tool_name:'Edit',
    tool_input:{ file_path:path.join(project, 'src', 'stripe.ts') }
  });
  assert.equal(duplicate.stdout.trim(), '', 'installed hook repeated the same explanation without a meaningful context change');

  let current = await api(base, '/api/state');
  assert.equal(current.response.status, 200);
  assert.equal(current.body?.session?.status, 'active');
  assert.match(String(current.body?.learning?.task || ''), /handleStripeWebhook/i);
  assert.equal(current.body?.session?.taskSignals?.route, '/api/webhooks/stripe');
  assert.ok((current.body?.session?.taskSignals?.technologies || []).includes('Stripe'));
  assert.ok(current.body?.card, `live task produced no learning card: ${JSON.stringify(current.body?.learning)}`);
  assert.equal(current.body.card.presentation?.explainFirst, true);
  assert.equal(current.body.card.presentation?.checkOptional, true);
  assert.equal(current.body.card.explanation?.schema, 'idleproof.explanation.v1');
  assert.ok((current.body.card.explanation?.certainty?.limitations || []).length >= 1, 'live explanation hides its certainty boundary');
  const lesson = String(current.body.card.lesson || '');
  assert.ok(lesson.length >= 100, `Explain-first lesson is too thin: ${lesson}`);
  assert.match(lesson, /src\/stripe\.ts|handleStripeWebhook|webhooks\/stripe|Stripe/i);
  const question = String(current.body.card.question || '');
  assert.ok(
    /stripe|webhooks\/stripe|handleStripeWebhook/i.test(question),
    `live question is not grounded in the observed task: ${question}`
  );
  assert.ok(question.length <= 240, 'live question is too long for the wait-window experience');

  const conceptId = current.body.card.id;
  const beforeDebt = current.body.metrics?.debt;
  const snooze = await api(base, '/api/snooze', {
    method:'POST',
    headers:{ origin:base, 'sec-fetch-site':'same-origin' },
    body:{ conceptId, minutes:10 }
  });
  assert.equal(snooze.response.status, 200, JSON.stringify(snooze.body));
  assert.equal(snooze.body?.ok, true);
  assert.ok(snooze.body?.snoozedUntil);
  current = await api(base, '/api/state');
  assert.ok(current.body?.ledger?.[conceptId]?.snoozedUntil, 'snoozed concept did not persist');
  assert.equal(current.body?.metrics?.debt, beforeDebt, 'snooze unexpectedly changed Knowledge Debt as if it were an answer');

  const hostile = await api(base, '/api/preferences', {
    method:'POST',
    headers:{ origin:'https://attacker.example', 'sec-fetch-site':'cross-site' },
    body:{ level:'beginner' }
  });
  assert.equal(hostile.response.status, 403, 'installed cockpit accepted a cross-site state-changing request');

  const handoffHook = hook(bin, project, { session_id:sessionId, hook_event_name:'Stop' });
  const handoffEnvelope = JSON.parse(handoffHook.stdout.trim());
  assert.match(String(handoffEnvelope.systemMessage || ''), /task handoff/i);
  assert.match(String(handoffEnvelope.systemMessage || ''), /does not claim the code is correct/i);
  assert.match(String(handoffEnvelope.systemMessage || ''), /DiffWitness/i);

  const handoff = await api(base, '/api/state');
  assert.equal(handoff.body?.session?.status, 'complete');
  assert.match(String(handoff.body?.session?.proof?.diffSha256 || ''), /^[a-f0-9]{64}$/);
  assert.ok(handoff.body?.featureModel, 'completed task has no feature model for handoff');
  assert.ok((handoff.body?.featureModel?.surfaces?.routes || []).includes('/api/webhooks/stripe'));
  const persistentDebt = handoff.body?.metrics?.debt;

  const status = idleproof(bin, project, ['status']);
  assert.match(status.stdout, /Knowledge debt/i);
  assert.match(status.stdout, /understanding/i);
  const doctor = idleproof(bin, project, ['doctor']);
  assert.match(doctor.stdout, /Node >= 20/);
  assert.match(doctor.stdout, /Git repository/);
  assert.match(doctor.stdout, /Claude adapter/);
  assert.match(doctor.stdout, /Provenance chain/);

  const stop = idleproof(bin, project, ['stop']);
  assert.match(stop.stdout, /Stopped IdleProof/);
  serverPid = null;
  assert.equal(fs.existsSync(path.join(project, '.idleproof', 'server.json')), false);

  const restart = idleproof(bin, project, ['start', '--no-open'], { timeout:15000 });
  assert.match(restart.stdout, /IdleProof Local cockpit:/i);
  info = serverInfo(project);
  serverPid = info.pid;
  base = `http://127.0.0.1:${info.port}`;
  health = await api(base, '/api/health');
  assert.equal(health.body?.ok, true);
  const restored = await api(base, '/api/state');
  assert.equal(restored.body?.session?.status, 'complete');
  assert.equal(restored.body?.metrics?.debt, persistentDebt);
  assert.ok((restored.body?.featureMemory || []).length >= 1, 'second session lost feature memory');
  idleproof(bin, project, ['stop']);
  serverPid = null;

  console.log(`IdleProof HUMAN SMOKE PASS · exact npm artifact · Explain-first delivery · deduplicated hooks · ${process.platform}/${process.version}`);
} finally {
  if (serverPid) {
    try { process.kill(serverPid, 'SIGTERM'); } catch {}
  }
  if (tarball) {
    try { fs.rmSync(tarball, { force:true }); } catch {}
  }
  fs.rmSync(temp, { recursive:true, force:true });
}
