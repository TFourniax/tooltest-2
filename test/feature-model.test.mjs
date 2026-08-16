import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFeatureModel } from '../src/feature-model.mjs';

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-feature-model-'));
  fs.mkdirSync(path.join(cwd, 'src', 'api'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'src', 'services'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'src', 'data'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'test'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'api', 'checkout.ts'), `
    import { createCheckout } from '../services/stripe.js';
    export async function checkout(req) { return createCheckout(req.body); }
    export const route = '/api/checkout';
  `);
  fs.writeFileSync(path.join(cwd, 'src', 'services', 'stripe.js'), `
    import { saveSubscription } from '../data/subscriptions.js';
    import Stripe from 'stripe';
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    export async function createCheckout(input) {
      const session = await stripe.checkout.sessions.create(input);
      await saveSubscription(session.id);
      return session;
    }
  `);
  fs.writeFileSync(path.join(cwd, 'src', 'data', 'subscriptions.js'), `
    export async function saveSubscription(id) {
      return db.query('INSERT INTO subscriptions(id) VALUES ($1)', [id]);
    }
  `);
  fs.writeFileSync(path.join(cwd, 'test', 'checkout.test.ts'), `
    import { checkout } from '../src/api/checkout.ts';
    test('checkout', async () => checkout({ body: {} }));
  `);
  return cwd;
}

test('feature model follows bounded local imports and surfaces feature responsibilities', () => {
  const cwd = fixture();
  try {
    const model = buildFeatureModel(cwd, {
      prompt: 'Add Stripe checkout and persist subscriptions',
      touchedFiles: ['src/api/checkout.ts', 'test/checkout.test.ts'],
      currentResource: 'src/api/checkout.ts',
      taskSignals: { file: 'src/api/checkout.ts', technologies: ['Stripe'] }
    });

    assert.equal(model.schema, 'idleproof.feature-model.v1');
    assert.equal(model.confidence, 'bounded-static');
    assert.ok(model.generatedFrom.filesInspected >= 4);
    assert.ok(model.nodes.some((node) => node.label === 'src/api/checkout.ts' && node.role === 'api'));
    assert.ok(model.nodes.some((node) => node.label === 'src/services/stripe.js' && node.role === 'service'));
    assert.ok(model.nodes.some((node) => node.label === 'subscriptions' && node.type === 'table'));
    assert.ok(model.surfaces.technologies.includes('Stripe'));
    assert.ok(model.tests.includes('test/checkout.test.ts'));
    assert.ok(model.story.some((step) => step.role === 'service'));
    assert.ok(model.story.some((step) => step.label === 'Stripe'));
    assert.match(model.explainBack, /→/);
    assert.equal(model.challenge.answer, 0);
    assert.match(model.disclaimer, /not a proven runtime call graph/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('feature model refuses traversal outside the project and remains bounded', () => {
  const cwd = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-feature-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.js'), 'export const secret = true;');
    fs.writeFileSync(path.join(cwd, 'src', 'api', 'escape.ts'), `import '${path.join(outside, 'secret.js').replaceAll('\\', '/')}';`);
    const model = buildFeatureModel(cwd, {
      prompt: 'Inspect checkout',
      touchedFiles: ['../../etc/passwd', 'src/api/escape.ts'],
      currentResource: '../../etc/passwd'
    });
    assert.ok(model.generatedFrom.filesInspected <= 24);
    assert.ok(model.generatedFrom.bytesInspected <= 640 * 1024);
    assert.ok(model.nodes.every((node) => !String(node.label).includes('passwd')));
    assert.ok(model.nodes.every((node) => !String(node.label).includes('secret.js')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
