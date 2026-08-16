import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTaskSignals } from '../src/context.mjs';

test('task signals extract a relevant symbol, route and technology without returning source code', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-context-'));
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'stripe.ts'), `
import Stripe from 'stripe';
export async function handleStripeWebhook(request) {
  return request.url === '/api/webhooks/stripe';
}
export function unrelatedHelper() { return true; }
`);

  const result = extractTaskSignals(cwd, {
    prompt: 'Make handleStripeWebhook idempotent and verify the Stripe webhook signature.',
    touchedFiles: ['src/stripe.ts']
  });

  assert.equal(result.file, 'src/stripe.ts');
  assert.equal(result.symbol, 'handleStripeWebhook');
  assert.equal(result.route, '/api/webhooks/stripe');
  assert.ok(result.technologies.includes('Stripe'));
  assert.equal(Object.hasOwn(result, 'source'), false);
});

test('task signal extraction refuses paths outside the project root', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-context-safe-'));
  const result = extractTaskSignals(cwd, { prompt: 'read secrets', touchedFiles: ['../outside.txt'] });
  assert.equal(result.symbol, null);
  assert.equal(result.file, '../outside.txt');
});
