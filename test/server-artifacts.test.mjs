import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { processHookEvent } from '../src/hook.mjs';

test('GET evidence is side-effect free while local POST explicitly generates it', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-artifact-server-'));
  processHookEvent({ cwd, session_id:'artifact', hook_event_name:'UserPromptSubmit', prompt:'Add authentication tests' });
  processHookEvent({ cwd, session_id:'artifact', hook_event_name:'Stop' });
  const evidencePath = path.join(cwd, '.idleproof', 'evidence-bundle.json');
  fs.rmSync(evidencePath, { force:true });

  const { server, url } = await createServer({ cwd, port:0 });
  try {
    const readBefore = await fetch(`${url}/api/evidence`);
    assert.equal(readBefore.status, 404);
    assert.equal(fs.existsSync(evidencePath), false, 'GET unexpectedly generated evidence on disk');

    const generated = await fetch(`${url}/api/evidence`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:'{}'
    });
    assert.equal(generated.status, 200);
    const payload = await generated.json();
    assert.equal(payload.schema, 'idleproof.evidence-bundle.v1');
    assert.equal(fs.existsSync(evidencePath), true);

    const readAfter = await fetch(`${url}/api/evidence`);
    assert.equal(readAfter.status, 200);
    assert.equal((await readAfter.json()).schema, 'idleproof.evidence-bundle.v1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});
