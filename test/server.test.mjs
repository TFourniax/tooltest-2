import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { processHookEvent } from '../src/hook.mjs';

test('local dashboard serves state and records one-tap proof answers', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-server-'));
  processHookEvent({ cwd, session_id: 'web', hook_event_name: 'UserPromptSubmit', prompt: 'Add authentication tests' });
  const { server, url } = await createServer({ cwd, port: 0 });
  try {
    const health = await fetch(`${url}/api/health`).then((res) => res.json());
    assert.equal(health.ok, true);

    const state = await fetch(`${url}/api/state`).then((res) => res.json());
    assert.equal(state.project, path.basename(cwd));
    assert.ok(state.card.id);

    const answer = await fetch(`${url}/api/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conceptId: state.card.id, choice: 0 })
    }).then((res) => res.json());
    assert.equal(answer.correct, true);
    assert.ok(answer.state.ledger[state.card.id].confidence > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
