import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { processHookEvent } from '../src/hook.mjs';
import { cachedFeatureModel, scoreFeatureAnswer } from '../src/feature-memory.mjs';
import { nextFeatureRecallChallenge } from '../src/feature-review.mjs';
import { buildProjectModel } from '../src/project-model.mjs';
import { loadState, mutateState } from '../src/state.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runTask(cwd, id, prompt, file) {
  processHookEvent({ cwd, session_id:id, source:'claude', hook_event_name:'UserPromptSubmit', prompt });
  processHookEvent({ cwd, session_id:id, source:'claude', hook_event_name:'PreToolUse', tool_name:'Read', tool_input:{ file_path:path.join(cwd, file) } });
  processHookEvent({ cwd, session_id:id, source:'claude', hook_event_name:'PostToolUse', tool_name:'Read', tool_input:{ file_path:path.join(cwd, file) } });
  processHookEvent({ cwd, session_id:id, source:'claude', hook_event_name:'Stop' });
}

function latestSession(state) {
  return Object.values(state.sessions).sort((a,b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))[0];
}

test('multi-session product journey preserves feature fluency, finds shared hotspots, and targets drift recall', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-product-journey-'));
  try {
    git(cwd, 'init', '-q');
    git(cwd, 'config', 'user.email', 'idleproof@example.test');
    git(cwd, 'config', 'user.name', 'IdleProof Test');
    fs.mkdirSync(path.join(cwd, 'src', 'api'), { recursive:true });
    fs.mkdirSync(path.join(cwd, 'src', 'services'), { recursive:true });

    fs.writeFileSync(path.join(cwd, 'src', 'api', 'checkout.ts'), `
      import { createCheckout } from '../services/billing.ts';
      export const route = '/api/checkout';
      export async function checkout(input) { return createCheckout(input); }
    `);
    fs.writeFileSync(path.join(cwd, 'src', 'api', 'invoices.ts'), `
      import { createInvoice } from '../services/billing.ts';
      export const route = '/api/invoices';
      export async function invoice(input) { return createInvoice(input); }
    `);
    fs.writeFileSync(path.join(cwd, 'src', 'services', 'billing.ts'), `
      import Stripe from 'stripe';
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      export async function createCheckout(input) { return stripe.checkout.sessions.create(input); }
      export async function createInvoice(input) { return stripe.invoices.create(input); }
    `);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'baseline');

    runTask(cwd, 'checkout-1', 'Build Stripe checkout through /api/checkout', 'src/api/checkout.ts');
    let state = loadState(cwd);
    let checkoutSession = state.sessions['checkout-1'];
    const checkoutModel = cachedFeatureModel(cwd, checkoutSession);
    mutateState(cwd, (next) => {
      scoreFeatureAnswer(next, checkoutSession, checkoutModel, true);
      scoreFeatureAnswer(next, checkoutSession, checkoutModel, true);
      scoreFeatureAnswer(next, checkoutSession, checkoutModel, true);
      return next;
    });

    runTask(cwd, 'invoice-1', 'Generate Stripe invoices through /api/invoices', 'src/api/invoices.ts');
    state = loadState(cwd);
    const invoiceSession = state.sessions['invoice-1'];
    const invoiceModel = cachedFeatureModel(cwd, invoiceSession);
    mutateState(cwd, (next) => {
      scoreFeatureAnswer(next, invoiceSession, invoiceModel, true);
      return next;
    });

    state = loadState(cwd);
    assert.equal(Object.values(state.features).filter((entry) => entry.exposures > 0).length, 2);
    const beforeTopology = buildProjectModel(state, invoiceSession, invoiceModel).topology;
    const billingHotspot = beforeTopology.hotspots.find((item) => item.file === 'src/services/billing.ts');
    assert.ok(billingHotspot);
    assert.equal(billingHotspot.featureCount, 2);
    assert.ok(beforeTopology.sharedBoundaries.some((item) => item.type === 'external' && item.value === 'Stripe' && item.featureCount === 2));

    fs.writeFileSync(path.join(cwd, 'src', 'services', 'billing.ts'), `
      import Stripe from 'stripe';
      import { createClient } from 'redis';
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const redis = createClient();
      export async function createCheckout(input) {
        await redis.set('checkout:last', 'started');
        await db.query('INSERT INTO subscriptions(id) VALUES ($1)', ['sub_1']);
        return stripe.checkout.sessions.create(input);
      }
      export async function createInvoice(input) { return stripe.invoices.create(input); }
    `);

    runTask(cwd, 'checkout-2', 'Add Redis coordination and persist checkout subscriptions', 'src/api/checkout.ts');
    state = loadState(cwd);
    checkoutSession = state.sessions['checkout-2'];
    const currentCheckout = Object.values(state.features).find((entry) => entry.surfaces?.routes?.includes('/api/checkout'));
    const rememberedInvoice = Object.values(state.features).find((entry) => entry.surfaces?.routes?.includes('/api/invoices'));
    assert.ok(currentCheckout);
    assert.ok(rememberedInvoice);
    assert.equal(currentCheckout.needsRefresh, true);
    assert.equal(currentCheckout.lastDrift.level, 'material');
    assert.ok(currentCheckout.lastDrift.added.technologies.includes('Redis'));
    assert.ok(currentCheckout.lastDrift.added.tables.includes('subscriptions'));
    assert.ok(currentCheckout.confidence <= 0.65);

    const changedModel = cachedFeatureModel(cwd, checkoutSession);
    const project = buildProjectModel(state, checkoutSession, changedModel);
    assert.ok(project.impact.otherFeatures.some((item) => item.featureKey === rememberedInvoice.featureKey));
    assert.ok(project.impact.otherFeatures.some((item) => item.sharedFiles.some((shared) => shared.file === 'src/services/billing.ts')));
    assert.equal(project.reviewQueue[0].featureKey, currentCheckout.featureKey);

    const recall = nextFeatureRecallChallenge(state);
    assert.ok(recall);
    assert.equal(recall.featureKey, currentCheckout.featureKey);
    assert.equal(recall.kind, 'drift-recall');
    assert.ok(recall.options.includes('Redis'));
    assert.equal(recall.options[recall.answer], 'Redis');
  } finally {
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});
