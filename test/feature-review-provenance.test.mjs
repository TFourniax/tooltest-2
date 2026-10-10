import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildFeatureRecallChallenge, buildDueFeatureReviews, scoreStoredFeatureReview } from '../src/feature-review.mjs';

function fixture(technology = 'Pytest') {
  const entry = {
    featureKey: '46d5d12c676db41f16079725', fingerprint: '5d9397f8123a20d194645a07',
    task: 'Implement independent loyalty-points calculation', exposures: 1, checks: 0,
    confidence: 0, needsRefresh: true,
    // A persisted legacy summary is input data, not authority to make runtime claims.
    lastDrift: { level: 'material', score: 5, summary: `new external boundary ${technology}`,
      added: { story: [`reference:${technology}`], technologies: [technology] }, removed: {} },
    surfaces: { technologies: [technology], routes: [], tables: [] },
    story: [{ type: 'file', label: 'src/loyalty.py', role: 'core' },
      { type: 'technology', label: technology, role: 'reference', epistemic_status: 'INFERRED' },
      { type: 'file', label: 'tests/test_loyalty.py', role: 'test' }]
  };
  return { features: { [entry.featureKey]: entry }, proof: { id: 'untouched-proof' }, debt: { points: 0 } };
}
const currentEntry = state => Object.values(state.features)[0];

for (const tech of ['Pytest', 'Redis', 'React', 'Stripe']) {
  test(`a newly recorded ${tech} reference does not establish a new external boundary`, () => {
    const state = fixture(tech), entry = currentEntry(state);
    const c = buildFeatureRecallChallenge(state, entry);
    assert.match(c.question, /technology reference.*newly recorded.*model/i);
    assert.doesNotMatch(c.question, /external boundary|added to/i);
    assert.doesNotMatch(c.explanation, /new external boundary/i);
    assert.match(c.explanation, /does not establish/i);
    assert.equal(c.options[c.answer], tech);
    assert.equal(c.kind, 'drift-recall');
  });
}

test('regular recall also labels a stored technology as a reference, not architecture', () => {
  const state = fixture(), entry = currentEntry(state);
  entry.needsRefresh = false;
  const c = buildFeatureRecallChallenge(state, entry);
  assert.equal(c.kind, 'technology-recall');
  assert.match(c.question, /technology reference/i);
  assert.doesNotMatch(c.question + c.explanation, /external boundary/);
  assert.equal(c.options[c.answer], 'Pytest');
});

for (const [group, value, description] of [
  ['routes', '/api/orders', 'route reference'],
  ['tables', 'orders', 'data reference'],
  ['story', 'core:src/loyalty.py', 'code or test reference']
]) {
  test(`observed ${group} drift preserves its target and scope instead of asserting deployment`, () => {
    const state = fixture(), entry = currentEntry(state);
    entry.lastDrift = { added: { [group]: [value] }, removed: {} };
    const c = buildFeatureRecallChallenge(state, entry);
    assert.ok(c.question.includes(description));
    assert.match(c.question, /newly recorded.*model/i);
    assert.equal(c.options[c.answer], value.replace(/^core:/, ''));
    assert.match(c.explanation, /does not establish/i);
  });
}

test('reading legacy feature memory changes neither its contents nor Proof/Debt', () => {
  const state = fixture(), before = JSON.stringify(state);
  const c = buildFeatureRecallChallenge(state, currentEntry(state));
  const queue = buildDueFeatureReviews(state, { now: Date.parse('2026-10-10T00:00:00Z') });
  assert.ok(c);
  assert.doesNotMatch(queue[0].reason, /new external boundary|^feature changed:/i);
  assert.match(queue[0].reason, /model/i);
  assert.equal(JSON.stringify(state), before);
});

test('an answer to the old misleading question is rejected without modifying mastery', () => {
  const state = fixture(), entry = currentEntry(state);
  // Reproduce v1 challenge ID exactly: wording was previously absent from its identity.
  const seed = `${entry.featureKey}|${entry.fingerprint}|drift-recall|Pytest`;
  const options = ['Pytest', 'No boundary changed', 'Only formatting changed']
    .map((value, i) => ({ value, score: createHash('sha256').update(`${seed}|${i}|${value}`).digest('hex') }))
    .sort((a, b) => a.score.localeCompare(b.score)).map(x => x.value);
  const legacyId = createHash('sha256').update(`${seed}|${options.join('|')}`).digest('hex').slice(0, 24);
  const old = { featureKey: entry.featureKey, challengeId: legacyId };
  const before = JSON.stringify(state);
  assert.notEqual(buildFeatureRecallChallenge(state, entry).challengeId, legacyId);
  assert.throws(() => scoreStoredFeatureReview(state, old, options.indexOf('Pytest')), /changed; refresh/i);
  assert.equal(JSON.stringify(state), before);
});

test('changing the question content invalidates a displayed challenge even with the same fingerprint', () => {
  const state = fixture(), entry = currentEntry(state);
  const old = buildFeatureRecallChallenge(state, entry);
  entry.task = 'A different task associated with the same files';
  const before = JSON.stringify(state);
  assert.notEqual(buildFeatureRecallChallenge(state, entry).challengeId, old.challengeId);
  assert.throws(() => scoreStoredFeatureReview(state, old, old.answer), /changed; refresh/i);
  assert.equal(JSON.stringify(state), before);
});

test('review still requires an actual response and cannot rewrite stored Proof or Debt', () => {
  const state = fixture(), entry = currentEntry(state);
  const immutable = JSON.stringify({ proof: state.proof, debt: state.debt });
  let c = buildFeatureRecallChallenge(state, entry);
  assert.equal(entry.checks, 0);
  assert.equal(entry.confidence, 0);
  scoreStoredFeatureReview(state, c, (c.answer + 1) % c.options.length);
  assert.equal(entry.checks, 1);
  assert.equal(entry.needsRefresh, true);
  assert.equal(entry.confidence, 0);
  c = buildFeatureRecallChallenge(state, entry);
  scoreStoredFeatureReview(state, c, c.answer);
  assert.equal(entry.checks, 2);
  assert.equal(entry.needsRefresh, false);
  assert.equal(JSON.stringify({ proof: state.proof, debt: state.debt }), immutable);
});
