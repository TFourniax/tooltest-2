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

test('glance mode is concise and naturalizes symbol-grounded wording', () => {
  const result = presentLearningCard(card, { status: 'active', estimatedWindow: 8 });
  assert.equal(result.presentation.depth, 'glance');
  assert.ok(result.seconds <= 8);
  assert.equal(result.lesson, 'Authentication proves identity.');
  assert.match(result.question, /changes authorizeAdmin in src\/auth\/session\.ts/);
  assert.doesNotMatch(result.question, /changes the code in authorizeAdmin/);
  assert.ok(result.why.length <= 145);
});

test('deep mode uses a long wait to add a concrete review move', () => {
  const result = presentLearningCard(card, { status: 'active', estimatedWindow: 50 });
  assert.equal(result.presentation.depth, 'deep');
  assert.ok(result.seconds >= 30);
  assert.match(result.lesson, /authenticated-but-unauthorized users are rejected/i);
});
