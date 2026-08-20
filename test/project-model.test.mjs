import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChangeImpact, buildFeatureReviewQueue, buildProjectTopology } from '../src/project-model.mjs';

function state() {
  return {
    features: {
      checkout: {
        featureKey: 'checkout', task: 'Stripe checkout', confidence: 0.82, exposures: 3,
        story: [
          { type:'file', label:'src/api/checkout.ts', role:'api' },
          { type:'file', label:'src/services/billing.ts', role:'service' },
          { type:'file', label:'src/db/subscriptions.ts', role:'data' }
        ],
        surfaces: { routes:['/api/checkout'], tables:['subscriptions'], technologies:['Stripe'] }
      },
      invoices: {
        featureKey: 'invoices', task: 'Invoice generation', confidence: 0.35, exposures: 2,
        story: [
          { type:'file', label:'src/api/invoices.ts', role:'api' },
          { type:'file', label:'src/services/billing.ts', role:'service' }
        ],
        surfaces: { routes:['/api/invoices'], tables:[], technologies:['Stripe'] }
      },
      admin: {
        featureKey: 'admin', task: 'Admin auth', confidence: 0.7, exposures: 2, needsRefresh:true,
        lastDrift: { level:'material', summary:'new external boundary Redis' },
        story: [
          { type:'file', label:'src/auth/session.ts', role:'service' },
          { type:'file', label:'src/api/admin.ts', role:'api' }
        ],
        surfaces: { routes:['/api/admin'], tables:[], technologies:['OAuth'] }
      }
    }
  };
}

test('change impact finds other learned features sharing a touched central file', () => {
  const memory = state();
  const impact = buildChangeImpact(memory, {
    currentResource: 'src/services/billing.ts',
    touchedFiles: ['src/api/checkout.ts', 'src/services/billing.ts']
  }, { featureKey:'checkout' });
  assert.equal(impact.blastRadius, 1);
  assert.equal(impact.otherFeatures[0].featureKey, 'invoices');
  assert.deepEqual(impact.otherFeatures[0].sharedFiles, [{ file:'src/services/billing.ts', role:'service' }]);
  assert.match(impact.summary, /1 other learned feature/);
  assert.equal(impact.weak.length, 1);
});

test('change impact uses the bounded current feature graph without claiming modeled dependencies were directly touched', () => {
  const memory = state();
  const impact = buildChangeImpact(memory, {
    currentResource: 'src/api/checkout.ts',
    touchedFiles: ['src/api/checkout.ts']
  }, {
    featureKey:'checkout',
    story: [
      { type:'file', label:'src/api/checkout.ts', role:'api' },
      { type:'file', label:'src/services/billing.ts', role:'service' }
    ]
  });
  assert.equal(impact.blastRadius, 1);
  assert.equal(impact.otherFeatures[0].featureKey, 'invoices');
  assert.deepEqual(impact.touchedFiles, ['src/api/checkout.ts']);
  assert.deepEqual(impact.modeledFiles, ['src/services/billing.ts']);
  assert.ok(impact.relevantFiles.includes('src/services/billing.ts'));
});

test('project topology exposes shared files and boundaries instead of pretending to know runtime calls', () => {
  const topology = buildProjectTopology(state());
  const billing = topology.hotspots.find((item) => item.file === 'src/services/billing.ts');
  assert.ok(billing);
  assert.equal(billing.featureCount, 2);
  const stripe = topology.sharedBoundaries.find((item) => item.type === 'external' && item.value === 'Stripe');
  assert.ok(stripe);
  assert.equal(stripe.featureCount, 2);
});

test('feature review queue puts drift and weak feature fluency ahead of routine recall', () => {
  const queue = buildFeatureReviewQueue(state());
  assert.equal(queue[0].featureKey, 'admin');
  assert.equal(queue[0].needsRefresh, true);
  assert.ok(queue.findIndex((item) => item.featureKey === 'invoices') < queue.findIndex((item) => item.featureKey === 'checkout'));
  assert.match(queue[0].reason, /feature changed/i);
});
