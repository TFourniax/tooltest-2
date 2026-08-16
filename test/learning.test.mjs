import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLearningExperience, detectLearningPhase, summarizeTask } from '../src/learning.mjs';

function stateFor(id, confidence = 0.2) {
  return { ledger: { [id]: { confidence, exposures: 1 } } };
}

test('contextual learning card is grounded in the active task and touched file', () => {
  const state = stateFor('auth', 0.2);
  const session = {
    id: 'session-1',
    source: 'claude',
    status: 'active',
    prompt: 'Add Google OAuth login and protect the admin route with role checks.',
    currentTool: 'Write',
    touchedFiles: ['src/auth/session.ts'],
    concepts: { auth: { events: 3 } },
    events: []
  };

  const experience = buildLearningExperience(state, session, 'auth');
  assert.equal(experience.phase, 'implement');
  assert.match(experience.card.question, /src\/auth\/session\.ts/);
  assert.match(experience.card.why, /Google OAuth/);
  assert.match(experience.card.lesson, /Apply it here:/);
  assert.equal(experience.card.context.source, 'claude');
  assert.equal(experience.recap.review, 1);
  assert.equal(experience.recap.weakest, 'Authentication & sessions');
});

test('learning phase follows the actual agent lifecycle', () => {
  assert.equal(detectLearningPhase({ status: 'active', currentTool: 'Grep', events: [] }), 'inspect');
  assert.equal(detectLearningPhase({ status: 'active', currentTool: 'npm test', events: [] }), 'verify');
  assert.equal(detectLearningPhase({ status: 'active', currentTool: 'Write', events: [] }), 'implement');
  assert.equal(detectLearningPhase({ status: 'active', currentTool: 'Thinking', touchedFiles: ['a.js'], events: [] }), 'reason');
  assert.equal(detectLearningPhase({ status: 'complete', currentTool: null, events: [] }), 'handoff');
  assert.equal(detectLearningPhase({ status: 'active', currentTool: 'Thinking', events: [{ failed: true }] }), 'recover');
});

test('task summaries stay compact enough for wait-window cards', () => {
  const summary = summarizeTask(`  Build   a   feature ${'x'.repeat(300)}  `, 80);
  assert.ok(summary.length <= 80);
  assert.match(summary, /^Build a feature/);
  assert.ok(summary.endsWith('…'));
});
