import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nextFeatureRecallChallenge } from '../src/feature-review.mjs';
import { loadState, mutateState } from '../src/state.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/idleproof.mjs');

function seed(cwd) {
  mutateState(cwd, (state) => {
    state.features.checkout = {
      featureKey:'checkout', fingerprint:'v2', task:'Stripe checkout', exposures:3, checks:2, correct:2, wrong:0,
      confidence:0.62, needsRefresh:true, lastSeenAt:'2026-08-16T20:00:00.000Z',
      lastDrift:{ level:'material', summary:'new external boundary Redis', added:{ technologies:['Redis'] }, removed:{} },
      surfaces:{ technologies:['Stripe','Redis'], routes:['/api/checkout'], tables:['subscriptions'] },
      story:[{ type:'file', label:'src/api/checkout.ts', role:'api' }, { type:'file', label:'src/services/billing.ts', role:'service' }]
    };
    state.features.invoices = {
      featureKey:'invoices', fingerprint:'i1', task:'Invoices', exposures:2, checks:1, correct:1, wrong:0,
      confidence:0.55, lastSeenAt:'2026-08-16T19:00:00.000Z',
      surfaces:{ technologies:['Stripe'], routes:['/api/invoices'], tables:[] },
      story:[{ type:'file', label:'src/api/invoices.ts', role:'api' }, { type:'file', label:'src/services/billing.ts', role:'service' }]
    };
    return state;
  });
}

test('CLI exposes mental-model status and completes a due feature review without opening the cockpit', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-learning-cli-'));
  try {
    seed(cwd);
    const mental = execFileSync(process.execPath, [BIN, 'mental-model'], { cwd, encoding:'utf8', timeout:5000 });
    assert.match(mental, /Feature fluency/);
    assert.match(mental, /Shared hotspots/);
    assert.match(mental, /src\/services\/billing\.ts/);
    assert.match(mental, /Reviews due/);

    const before = loadState(cwd);
    const challenge = nextFeatureRecallChallenge(before);
    assert.ok(challenge);
    assert.equal(challenge.kind, 'drift-recall');
    const review = execFileSync(process.execPath, [BIN, 'review'], { cwd, encoding:'utf8', timeout:5000 });
    assert.match(review, /Feature review/);
    assert.match(review, /Redis/);
    assert.match(review, /idleproof review --answer/);

    const answer = execFileSync(process.execPath, [BIN, 'review', '--answer', String(challenge.answer + 1)], { cwd, encoding:'utf8', timeout:5000 });
    assert.match(answer, /Correct/);
    assert.match(answer, /Feature fluency/);
    const after = loadState(cwd);
    assert.equal(after.features.checkout.needsRefresh, false);
    assert.ok(after.features.checkout.confidence > before.features.checkout.confidence);

    const help = execFileSync(process.execPath, [BIN, '--help'], { cwd, encoding:'utf8', timeout:5000 });
    assert.match(help, /idleproof mental-model/);
    assert.match(help, /idleproof review --answer N/);
  } finally {
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});
