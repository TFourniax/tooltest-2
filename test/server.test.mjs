import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { processHookEvent } from '../src/hook.mjs';

test('local dashboard serves state, records one-tap answers, and snoozes without changing mastery', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-server-'));
  processHookEvent({ cwd, session_id: 'web', hook_event_name: 'UserPromptSubmit', prompt: 'Add authentication tests for a protected API route' });
  const { server, url } = await createServer({ cwd, port: 0 });
  try {
    const health = await fetch(`${url}/api/health`).then((res) => res.json());
    assert.equal(health.ok, true);

    const state = await fetch(`${url}/api/state`).then((res) => res.json());
    assert.equal(state.project, path.basename(cwd));
    assert.ok(state.card.id);

    const firstConcept = state.card.id;
    const beforeConfidence = state.ledger[firstConcept]?.confidence ?? 0;
    const snoozed = await fetch(`${url}/api/snooze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conceptId: firstConcept, minutes: 10 })
    }).then((res) => res.json());

    assert.equal(snoozed.ok, true);
    assert.ok(snoozed.snoozedUntil);
    assert.equal(snoozed.state.ledger[firstConcept].confidence, beforeConfidence);
    assert.ok(snoozed.state.learning.snoozedConceptIds.includes(firstConcept));
    if (!snoozed.state.learning.paused) assert.notEqual(snoozed.state.card.id, firstConcept);

    const resumed = await fetch(`${url}/api/snooze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conceptId: firstConcept, minutes: 0 })
    }).then((res) => res.json());
    assert.equal(resumed.ok, true);
    assert.equal(resumed.snoozedUntil, null);
    assert.equal(resumed.state.ledger[firstConcept].confidence, beforeConfidence);

    const answer = await fetch(`${url}/api/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conceptId: resumed.state.card.id, choice: 0 })
    }).then((res) => res.json());
    assert.equal(answer.correct, true);
    assert.ok(answer.state.ledger[resumed.state.card.id].confidence > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
