import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDueFeatureReviews,
  buildFeatureRecallChallenge,
  featureReviewDue,
  nextFeatureReviewMinutes,
  scoreStoredFeatureReview
} from '../src/feature-review.mjs';

function memory() {
  return {
    features: {
      checkout: {
        featureKey:'checkout', fingerprint:'v2', task:'Stripe checkout', exposures:3, confidence:0.72,
        needsRefresh:true,
        lastDrift:{ summary:'new external boundary Redis', added:{ technologies:['Redis'] }, removed:{} },
        surfaces:{ technologies:['Stripe','Redis'], routes:['/api/checkout'], tables:['subscriptions'] },
        story:[{ type:'file', label:'src/api/checkout.ts', role:'api' }]
      },
      auth: {
        featureKey:'auth', fingerprint:'a1', task:'Admin auth', exposures:2, confidence:0.4,
        lastAnsweredAt:'2026-08-10T00:00:00.000Z',
        surfaces:{ technologies:['OAuth'], routes:['/api/admin'], tables:['sessions'] },
        story:[{ type:'file', label:'src/auth/session.ts', role:'service' }]
      },
      reports: {
        featureKey:'reports', fingerprint:'r1', task:'Reports', exposures:1, confidence:0.9,
        lastAnsweredAt:'2026-08-16T23:00:00.000Z',
        surfaces:{ technologies:[], routes:['/api/reports'], tables:['reports'] },
        story:[{ type:'file', label:'src/api/reports.ts', role:'api' }]
      }
    }
  };
}

test('feature spaced-recall interval grows with fluency and drift is due immediately', () => {
  assert.equal(nextFeatureReviewMinutes(0.2, false), 10);
  assert.equal(nextFeatureReviewMinutes(0.5, false), 1440);
  assert.equal(nextFeatureReviewMinutes(0.7, false), 4320);
  assert.equal(nextFeatureReviewMinutes(0.9, false), 10080);
  assert.equal(nextFeatureReviewMinutes(0.9, true), 0);
  assert.equal(featureReviewDue({ needsRefresh:true, confidence:0.9 }), true);
});

test('drift recall asks about the actual new project boundary with non-trivial project distractors', () => {
  const state = memory();
  const challenge = buildFeatureRecallChallenge(state, state.features.checkout);
  assert.equal(challenge.kind, 'drift-recall');
  assert.match(challenge.question, /new external boundary/i);
  assert.ok(challenge.options.includes('Redis'));
  assert.ok(challenge.options.some((value) => ['OAuth','/api/admin','sessions'].includes(value)));
  assert.equal(challenge.options[challenge.answer], 'Redis');
  assert.equal(challenge.resolvesRefresh, true);
});

test('correct drift recall restores review state and wrong answer does not', () => {
  const state = memory();
  let challenge = buildFeatureRecallChallenge(state, state.features.checkout);
  const wrongChoice = challenge.answer === 0 ? 1 : 0;
  const wrong = scoreStoredFeatureReview(state, challenge, wrongChoice);
  assert.equal(wrong.correct, false);
  assert.equal(state.features.checkout.needsRefresh, true);

  challenge = buildFeatureRecallChallenge(state, state.features.checkout);
  const correct = scoreStoredFeatureReview(state, challenge, challenge.answer);
  assert.equal(correct.correct, true);
  assert.equal(state.features.checkout.needsRefresh, false);
  assert.ok(state.features.checkout.lastAnsweredAt);
});

test('review queue prioritizes due drift and leaves recently fluent features for later', () => {
  const state = memory();
  const now = Date.parse('2026-08-17T00:00:00.000Z');
  const queue = buildDueFeatureReviews(state, { now, limit:10 });
  assert.equal(queue[0].featureKey, 'checkout');
  const reports = queue.find((item) => item.featureKey === 'reports');
  assert.equal(reports.due, false);
  assert.ok(queue.find((item) => item.featureKey === 'auth').due);
});
