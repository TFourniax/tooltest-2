import test from 'node:test';
import assert from 'node:assert/strict';
import { learningDepth, presentLearningCard } from '../src/presentation.mjs';

const card = {
  id: 'auth',
  seconds: 30,
  question: 'While the agent changes the code in authorizeAdmin in src/auth/session.ts: where must the permission check happen?',
  why: 'This is tied to the active authorization task. The user should understand the server boundary before accepting it.',
  lesson: 'Authentication proves identity. Authorization decides whether that identity may perform this action. Apply it here: inspect the server-side guard.',
  review: 'Verify that authenticated-but-unauthorized users are rejected.',
  context: { target: 'authorizeAdmin in src/auth/session.ts' }
};

test('lesson depth follows the real wait window and handoff boundary', () => {
  assert.equal(learningDepth({ status: 'active', estimatedWindow: 8 }), 'glance');
  assert.equal(learningDepth({ status: 'active', estimatedWindow: 24 }), 'quick');
  assert.equal(learningDepth({ status: 'active', estimatedWindow: 50 }), 'deep');
  assert.equal(learningDepth({ status: 'complete', estimatedWindow: 0 }), 'handoff');
});

test('glance mode stays concise while preserving the Explain-first certainty boundary', () => {
  const result = presentLearningCard(card, { status: 'active', estimatedWindow: 8 });
  assert.equal(result.presentation.depth, 'glance');
  assert.equal(result.presentation.explainFirst, true);
  assert.equal(result.presentation.checkOptional, true);
  assert.ok(result.seconds <= 8);
  assert.equal(result.explanation?.schema, 'idleproof.explanation.v1');
  assert.equal(result.explanation?.certainty?.level, 'bounded-inference');
  assert.ok((result.explanation?.certainty?.limitations || []).length >= 3);
  assert.match(result.lesson, /allowed|permission|access/i);
  assert.doesNotMatch(result.lesson, /^Authentication proves identity\.$/);
  assert.match(result.question, /changes authorizeAdmin in src\/auth\/session\.ts/);
  assert.doesNotMatch(result.question, /changes the code in authorizeAdmin/);
  assert.ok(result.why.length <= 220);
});

test('deep mode adds meaningful explanation instead of reverting to a canned review sentence', () => {
  const glance = presentLearningCard(card, { status: 'active', estimatedWindow: 8 });
  const result = presentLearningCard(card, { status: 'active', estimatedWindow: 50 });
  assert.equal(result.presentation.depth, 'deep');
  assert.equal(result.presentation.explainFirst, true);
  assert.equal(result.presentation.checkOptional, true);
  assert.ok(result.seconds >= 30);
  assert.ok(result.lesson.length > glance.lesson.length, 'deep mode should add useful context beyond glance mode');
  assert.match(result.lesson, /What to keep in mind:/i);
  assert.match(result.lesson, /logged in.*allowed/i);
  assert.match(result.lesson, /requested outcome/i);
});

test('Stripe webhook signals specialize the question without an LLM call', () => {
  const stripe = {
    id: 'http',
    seconds: 25,
    question: 'While the agent changes handleStripeWebhook in src/stripe.ts: what property matters if this write request can be retried?',
    why: 'HTTP requests can be retried.',
    lesson: 'Retries make idempotency important.',
    review: 'Check duplicate delivery behavior.',
    options: ['Idempotency', 'Font weight', 'Source-map size'],
    answer: 0,
    context: {
      phase: 'implement',
      target: 'handleStripeWebhook in src/stripe.ts',
      signals: {
        symbol: 'handleStripeWebhook',
        route: '/api/webhooks/stripe',
        technologies: ['Stripe']
      }
    }
  };

  const result = presentLearningCard(stripe, { status: 'active', estimatedWindow: 24 });
  assert.equal(result.presentation.specialized, true);
  assert.equal(result.presentation.explainFirst, true);
  assert.match(result.question, /Stripe retries \/api\/webhooks\/stripe/);
  assert.match(result.question, /handleStripeWebhook/);
  assert.equal(result.options[0], 'Idempotency');
  assert.equal(result.answer, 0);
});
