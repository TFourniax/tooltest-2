import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildReceipt, processHookEvent } from '../src/hook.mjs';

function exercise(cwd, sessionId) {
  const file = path.join(cwd, 'app.ts');
  fs.writeFileSync(file, 'export function localThing(value) { return value; }\n');
  processHookEvent({ cwd, session_id:sessionId, hook_event_name:'UserPromptSubmit', prompt:'Update localThing without losing the current behavior' });
  processHookEvent({ cwd, session_id:sessionId, hook_event_name:'PreToolUse', tool_name:'Edit', tool_input:{ file_path:file } });
  fs.writeFileSync(file, 'export function localThing(value) { return String(value).trim(); }\n');
  processHookEvent({ cwd, session_id:sessionId, hook_event_name:'PostToolUse', tool_name:'Edit', tool_input:{ file_path:file } });
  const state = processHookEvent({ cwd, session_id:sessionId, hook_event_name:'Stop' });
  const session = state.sessions[sessionId];
  assert.equal(session.status, 'complete');
  assert.equal(session.changeIdentity?.available, false);
  assert.match(session.changeIdentity?.reason || '', /git-baseline-unavailable|baseline-unavailable/);
  assert.match(session.proof?.diffSha256 || '', /^[a-f0-9]{64}$/);
  assert.ok(session.touchedFiles.some((value)=>value.replaceAll('\\','/').endsWith('app.ts')));
  const receipt = buildReceipt(cwd);
  assert.equal(receipt.session.change.available, false);
  assert.equal(receipt.session.proof.changeId, null);
  return { session, receipt };
}

test('IdleProof remains usable in a directory with no Git repository without inventing change identity', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-no-git-'));
  try {
    const { receipt } = exercise(cwd, 'no-git-session');
    assert.equal(receipt.session.proof.head, null);
  } finally {
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});

test('IdleProof remains usable in an initialized repository with no first commit', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-unborn-git-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const { receipt } = exercise(cwd, 'unborn-git-session');
    assert.equal(receipt.session.proof.head, null);
    assert.ok(receipt.session.changed.added > 0, 'untracked file should still be visible in the local handoff');
  } finally {
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});
