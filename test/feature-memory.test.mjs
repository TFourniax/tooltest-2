import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cachedFeatureModel,
  compareFeatureSnapshots,
  featureSnapshot,
  previewFeatureDrift,
  rememberFeature,
  scoreFeatureAnswer
} from '../src/feature-memory.mjs';

function setup() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-feature-memory-'));
  fs.mkdirSync(path.join(cwd, 'src', 'api'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'src', 'services'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'api', 'checkout.ts'), `
    import { createCheckout } from '../services/stripe.ts';
    export const route = '/api/checkout';
    export async function checkout(input) { return createCheckout(input); }
  `);
  fs.writeFileSync(path.join(cwd, 'src', 'services', 'stripe.ts'), `
    import Stripe from 'stripe';
    export async function createCheckout(input) { return new Stripe('x').checkout.sessions.create(input); }
  `);
  return cwd;
}

function session(prompt, at, id = 's1') {
  return {
    id,
    prompt,
    lastEventAt: at,
    currentResource: 'src/api/checkout.ts',
    touchedFiles: ['src/api/checkout.ts', 'src/services/stripe.ts'],
    taskSignals: { file: 'src/api/checkout.ts', technologies: ['Stripe'] }
  };
}

test('feature identity survives prompt changes while version fingerprint can change', () => {
  const cwd = setup();
  try {
    const first = cachedFeatureModel(cwd, session('Add Stripe checkout', '2026-08-17T00:00:00Z'));
    const cached = cachedFeatureModel(cwd, session('Add Stripe checkout', '2026-08-17T00:00:00Z'));
    const second = cachedFeatureModel(cwd, session('Improve checkout errors without changing the feature boundary', '2026-08-17T00:01:00Z', 's2'));
    assert.strictEqual(cached, first);
    assert.equal(first.featureKey, second.featureKey);
    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.deepEqual(compareFeatureSnapshots(featureSnapshot(first), featureSnapshot(second)).changed, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('material boundary drift marks feature fluency for refresh and a correct check clears it', () => {
  const cwd = setup();
  try {
    const state = { features: {} };
    const firstSession = session('Add Stripe checkout', '2026-08-17T00:00:00Z');
    const first = cachedFeatureModel(cwd, firstSession);
    rememberFeature(state, firstSession, first);
    scoreFeatureAnswer(state, firstSession, first, true);
    const before = state.features[first.featureKey].confidence;
    assert.ok(before > 0);

    fs.writeFileSync(path.join(cwd, 'src', 'services', 'stripe.ts'), `
      import Stripe from 'stripe';
      import { createClient } from 'redis';
      const cache = createClient();
      export async function createCheckout(input) {
        await cache.set('checkout:last', 'started');
        await db.query('INSERT INTO subscriptions(id) VALUES ($1)', ['sub_1']);
        return new Stripe('x').checkout.sessions.create(input);
      }
    `);
    const changedSession = session('Add Redis coordination and persist subscriptions', '2026-08-17T00:02:00Z', 's2');
    changedSession.taskSignals.technologies = ['Stripe', 'Redis'];
    const changed = cachedFeatureModel(cwd, changedSession);
    assert.equal(changed.featureKey, first.featureKey);

    const preview = previewFeatureDrift(state, changed);
    assert.equal(preview.changed, true);
    assert.equal(preview.level, 'material');
    assert.ok(preview.added.technologies?.includes('Redis'));
    assert.ok(preview.added.tables?.includes('subscriptions'));

    const memory = rememberFeature(state, changedSession, changed);
    assert.equal(memory.needsRefresh, true);
    assert.equal(memory.lastDrift.level, 'material');
    assert.ok(memory.confidence <= 0.65);

    scoreFeatureAnswer(state, changedSession, changed, true);
    assert.equal(state.features[changed.featureKey].needsRefresh, false);
    assert.ok(state.features[changed.featureKey].confidence > memory.confidence || state.features[changed.featureKey].confidence > 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
