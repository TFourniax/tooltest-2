import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluatePolicy } from '../src/policy.mjs';
import { appendProvenanceEvent } from '../src/provenance.mjs';
import { replayPolicy } from '../src/replay.mjs';
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-replay-')); }
function record(cwd, command) { const event = { cwd, source:'claude', session_id:'s1', hook_event_name:'PreToolUse', tool_name:'Bash', tool_input:{ command } }; const decision = evaluatePolicy(event, { cwd }); appendProvenanceEvent(event, decision, cwd); }

test('strict policy replay finds historical actions that would require stronger control without raw command storage', () => {
  const cwd = tmp(); record(cwd, 'npm install left-pad'); record(cwd, 'git push --force origin main'); record(cwd, 'psql app -c "DROP TABLE users"'); const raw = fs.readFileSync(path.join(cwd, '.idleproof', 'events.jsonl'), 'utf8'); assert.equal(raw.includes('git push --force'), false);
  const replay = replayPolicy(cwd, { profile:'strict' }); assert.equal(replay.eventsEvaluated, 3); assert.ok(replay.impacts.some((item) => item.capabilities.includes('scm.history_rewrite'))); assert.ok(replay.counts.deny >= 1); assert.equal(replay.replayCoverage, 'semantic-complete');
});
