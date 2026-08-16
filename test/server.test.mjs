import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { processHookEvent } from '../src/hook.mjs';

test('local dashboard serves state and records one-tap proof answers', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-server-'));
  processHookEvent({ cwd, session_id: 'web', hook_event_name: 'UserPromptSubmit', prompt: 'Add authentication tests' });
  const { server, url } = await createServer({ cwd, port: 0 });
  try {
    const health = await fetch(`${url}/api/health`).then((res) => res.json());
    assert.equal(health.ok, true);

    const state = await fetch(`${url}/api/state`).then((res) => res.json());
    assert.equal(state.project, path.basename(cwd));
    assert.ok(state.card.id);

    const answer = await fetch(`${url}/api/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conceptId: state.card.id, choice: 0 })
    }).then((res) => res.json());
    assert.equal(answer.correct, true);
    assert.ok(answer.state.ledger[state.card.id].confidence > 0);

    const beforeSnooze = answer.state.ledger[state.card.id].confidence;
    const snooze = await fetch(`${url}/api/snooze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conceptId: state.card.id, minutes: 10 })
    }).then((res) => res.json());
    assert.equal(snooze.ok, true);
    assert.equal(snooze.state.ledger[state.card.id].confidence, beforeSnooze);
    assert.ok(snooze.snoozedUntil);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('feature mental model is public without its answer and feature check updates separate fluency', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-feature-server-'));
  fs.mkdirSync(path.join(cwd, 'src', 'api'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'src', 'services'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'api', 'checkout.ts'), `
    import { createCheckout } from '../services/stripe.ts';
    export const route = '/api/checkout';
    export async function checkout(input) { return createCheckout(input); }
  `);
  fs.writeFileSync(path.join(cwd, 'src', 'services', 'stripe.ts'), `
    import Stripe from 'stripe';
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    export async function createCheckout(input) { return stripe.checkout.sessions.create(input); }
  `);

  processHookEvent({ cwd, session_id: 'feature-web', hook_event_name: 'UserPromptSubmit', prompt: 'Add Stripe checkout through /api/checkout' });
  processHookEvent({ cwd, session_id: 'feature-web', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src', 'api', 'checkout.ts') } });
  const { server, url } = await createServer({ cwd, port: 0 });
  try {
    const state = await fetch(`${url}/api/state`).then((res) => res.json());
    assert.ok(state.featureModel);
    assert.ok(state.featureModel.story.length >= 2);
    assert.ok(state.featureModel.challenge);
    assert.equal('answer' in state.featureModel.challenge, false);
    assert.equal(state.metrics.featureCoverage, 0);

    const result = await fetch(`${url}/api/feature-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: state.featureModel.fingerprint, choice: 0 })
    }).then((res) => res.json());
    assert.equal(result.correct, true);
    assert.match(result.explanation, /Stripe/i);
    assert.ok(result.state.featureModel.fluency.confidence > 0);
    assert.ok(result.state.metrics.featureCoverage > 0);
    assert.equal(result.state.featureMemory[0].fingerprint, state.featureModel.fingerprint);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
