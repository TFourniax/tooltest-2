import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { processHookEvent } from './hook.mjs';
import { cachedFeatureModel, scoreFeatureAnswer } from './feature-memory.mjs';
import { loadState, mutateState } from './state.mjs';
import { createServer, openBrowser } from './server.mjs';
import { DEFAULT_PORT } from './paths.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding:'utf8', stdio:['ignore','pipe','ignore'] }).trim();
}

function write(cwd, relative, content) {
  const file = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.writeFileSync(file, content);
}

function session(cwd, id, prompt, file, { complete = true } = {}) {
  processHookEvent({ cwd, session_id:id, source:'claude', hook_event_name:'UserPromptSubmit', prompt });
  processHookEvent({ cwd, session_id:id, source:'claude', hook_event_name:'PreToolUse', tool_name:'Read', tool_input:{ file_path:path.join(cwd,file) } });
  processHookEvent({ cwd, session_id:id, source:'claude', hook_event_name:'PostToolUse', tool_name:'Read', tool_input:{ file_path:path.join(cwd,file) } });
  if (complete) processHookEvent({ cwd, session_id:id, source:'claude', hook_event_name:'Stop' });
}

function learnFeature(cwd, sessionId, times = 1) {
  const state = loadState(cwd);
  const current = state.sessions[sessionId];
  if (!current) return;
  const model = cachedFeatureModel(cwd, current);
  mutateState(cwd, (next) => {
    for (let i = 0; i < times; i += 1) scoreFeatureAnswer(next, current, model, true);
    return next;
  });
}

export function createDemoProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-demo-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'demo@idleproof.local');
  git(cwd, 'config', 'user.name', 'IdleProof Demo');

  write(cwd, 'src/api/checkout.ts', `
import { createCheckout } from '../services/billing.ts';
export const route = '/api/checkout';
export async function checkout(input) { return createCheckout(input); }
`);
  write(cwd, 'src/api/invoices.ts', `
import { createInvoice } from '../services/billing.ts';
export const route = '/api/invoices';
export async function invoice(input) { return createInvoice(input); }
`);
  write(cwd, 'src/services/billing.ts', `
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
export async function createCheckout(input) { return stripe.checkout.sessions.create(input); }
export async function createInvoice(input) { return stripe.invoices.create(input); }
`);
  write(cwd, 'test/checkout.test.ts', `
import { checkout } from '../src/api/checkout.ts';
test('checkout returns a Stripe session', async () => checkout({}));
`);
  write(cwd, 'test/invoices.test.ts', `
import { invoice } from '../src/api/invoices.ts';
test('invoice returns a Stripe invoice', async () => invoice({}));
`);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'demo baseline');

  session(cwd, 'demo-checkout-v1', 'Build Stripe checkout through /api/checkout and test it', 'src/api/checkout.ts');
  learnFeature(cwd, 'demo-checkout-v1', 3);
  session(cwd, 'demo-invoices-v1', 'Generate Stripe invoices through /api/invoices', 'src/api/invoices.ts');
  learnFeature(cwd, 'demo-invoices-v1', 1);

  write(cwd, 'src/services/billing.ts', `
import Stripe from 'stripe';
import { createClient } from 'redis';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const redis = createClient();
export async function createCheckout(input) {
  await redis.set('checkout:last', 'started');
  await db.query('INSERT INTO subscriptions(id) VALUES ($1)', ['demo_sub']);
  return stripe.checkout.sessions.create(input);
}
export async function createInvoice(input) { return stripe.invoices.create(input); }
`);

  session(cwd, 'demo-checkout-v2', 'Add Redis coordination and persist checkout subscriptions safely', 'src/api/checkout.ts', { complete:false });
  processHookEvent({ cwd, session_id:'demo-checkout-v2', source:'claude', hook_event_name:'PreToolUse', tool_name:'Bash', tool_input:{ command:'npm test' } });
  return cwd;
}

export function cleanupDemoProject(cwd) {
  if (!cwd || !path.basename(cwd).startsWith('idleproof-demo-')) return false;
  try { fs.rmSync(cwd, { recursive:true, force:true }); return true; } catch { return false; }
}

function option(args, key, fallback) {
  const index = args.indexOf(key);
  return index >= 0 && args[index + 1] != null ? args[index + 1] : fallback;
}

export async function runDemo(args = []) {
  const port = Number(option(args, '--port', DEFAULT_PORT));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port.');
  const demoCwd = createDemoProject();
  let server = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupDemoProject(demoCwd);
  };

  try {
    const started = await createServer({ cwd:demoCwd, port });
    server = started.server;
    server.once('close', cleanup);
    console.log(`✓ IdleProof demo cockpit: ${started.url}`);
    console.log('  Isolated demo: Checkout + Invoices → shared billing.ts → live Redis drift.');
    console.log('  Your current repository is untouched. Press Ctrl+C to close the demo.');
    if (!args.includes('--no-open')) openBrowser(started.url);

    const shutdown = () => {
      if (server?.listening) server.close(() => { cleanup(); process.exit(0); });
      else { cleanup(); process.exit(0); }
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return started;
  } catch (error) {
    if (server?.listening) server.close();
    cleanup();
    throw error;
  }
}
