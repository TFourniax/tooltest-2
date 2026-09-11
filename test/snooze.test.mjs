import test from 'node:test';
import assert from 'node:assert/strict';
import { isConceptSnoozed, snoozeUntil, taskConceptAvailability } from '../src/snooze.mjs';

test('snoozing a concept is temporary and does not imply mastery', () => {
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  const until = snoozeUntil(10, now);
  const entry = { confidence: 0.2, exposures: 3, snoozedUntil: until };
  assert.equal(isConceptSnoozed(entry, now), true);
  assert.equal(entry.confidence, 0.2);
  assert.equal(isConceptSnoozed(entry, now + 11 * 60_000), false);
});

test('availability skips one snoozed task concept and keeps another relevant concept', () => {
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  const state = {
    ledger: {
      auth: { snoozedUntil: snoozeUntil(10, now) },
      http: { snoozedUntil: null }
    }
  };
  const session = { concepts: { auth: { events: 2 }, http: { events: 1 } } };
  const result = taskConceptAvailability(state, session, now);
  assert.deepEqual(Object.keys(result.available), ['http']);
  assert.deepEqual(result.snoozed.map((item) => item.id), ['auth']);
  assert.equal(result.paused, false);
});

test('availability pauses only when every concept exposed by this task is snoozed', () => {
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  const until = snoozeUntil(10, now);
  const state = { ledger: { auth: { snoozedUntil: until }, http: { snoozedUntil: until } } };
  const session = { concepts: { auth: { events: 1 }, http: { events: 1 } } };
  const result = taskConceptAvailability(state, session, now);
  assert.equal(result.paused, true);
  assert.equal(result.resumeAt, until);
});

test('zero minutes clears a snooze', () => {
  assert.equal(snoozeUntil(0), null);
});
