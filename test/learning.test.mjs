import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLearningExperience,
  detectLearningPhase,
  isReviewDue,
  nextReviewMinutes,
  selectLearningCard,
  summarizeTask
} from '../src/learning.mjs';

function stateFor(id, confidence = 0.2, extra = {}) {
  return { ledger: { [id]: { confidence, exposures: 1, ...extra } } };
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
  assert.equal(experience.selectedConceptId, 'auth');
  assert.equal(experience.card.kind, 'applied');
  assert.match(experience.card.question, /src\/auth\/session\.ts/);
  assert.match(experience.card.question, /permission check/i);
  assert.match(experience.card.why, /Google OAuth/);
  assert.match(experience.card.lesson, /Apply it here:/);
  assert.equal(experience.card.context.source, 'claude');
  assert.equal(experience.recap.review, 1);
  assert.equal(experience.recap.weakest, 'Authentication & sessions');
});

test('handoff changes the challenge from implementation teaching to acceptance review', () => {
  const state = stateFor('migration', 0.4);
  const session = {
    id: 'session-2', status: 'complete', prompt: 'Add a nullable organization_id then backfill existing rows.',
    currentTool: null, touchedFiles: ['db/migrations/042_org.sql'], concepts: { migration: { events: 4 } }, events: []
  };
  const experience = buildLearningExperience(state, session, 'migration');
  assert.equal(experience.phase, 'handoff');
  assert.equal(experience.card.kind, 'applied');
  assert.match(experience.card.question, /Before you accept the finished change/);
  assert.match(experience.card.options[0], /roll back|corrupting/i);
  assert.match(experience.card.review, /042_org\.sql/);
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

test('review cadence expands as demonstrated confidence grows', () => {
  assert.equal(nextReviewMinutes(0.1), 5);
  assert.equal(nextReviewMinutes(0.5), 30);
  assert.equal(nextReviewMinutes(0.7), 360);
  assert.equal(nextReviewMinutes(0.9), 1440);
  assert.equal(isReviewDue({ confidence: 0.9, lastAnsweredAt: new Date().toISOString() }), false);
  assert.equal(isReviewDue({ confidence: 0.2, lastAnsweredAt: '2000-01-01T00:00:00.000Z' }), true);
});

test('card selection prioritizes task-relevant weak concepts and avoids an immediate repeat', () => {
  const now = new Date().toISOString();
  const state = {
    ledger: {
      auth: { confidence: 0.75, exposures: 4, lastAnsweredAt: null },
      testing: { confidence: 0.1, exposures: 2, lastAnsweredAt: now },
      http: { confidence: 0.2, exposures: 3, lastAnsweredAt: null }
    }
  };
  const session = {
    status: 'active', currentTool: 'Write', touchedFiles: ['src/api/admin.ts'], events: [],
    concepts: { auth: { events: 2 }, testing: { events: 1 }, http: { events: 2 } }
  };
  assert.equal(selectLearningCard(state, session, 'testing'), 'http');
});
