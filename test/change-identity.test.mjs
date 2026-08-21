import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureBaselineIdentity, changeId, finalizeChangeIdentity } from '../src/change-identity.mjs';
import { buildReceipt, processHookEvent } from '../src/hook.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding:'utf8', stdio:['ignore', 'pipe', 'pipe'] }).trim();
}

function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-change-id-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'change-id@idleproof.local');
  git(cwd, 'config', 'user.name', 'IdleProof Change Identity');
  fs.writeFileSync(path.join(cwd, 'app.js'), 'export const value = 1;\n');
  git(cwd, 'add', 'app.js');
  git(cwd, 'commit', '-qm', 'base');
  return cwd;
}

test('change id is byte-compatible with the frozen DiffWitness change-envelope contract', () => {
  assert.equal(
    changeId({
      repository:`dwrepo_${'a'.repeat(24)}`,
      baseTree:'b'.repeat(40),
      candidateTree:'c'.repeat(40)
    }),
    'dwchg_1ff5eae63c529eb78e69a82d'
  );
});

test('clean Git session produces exact before/after tree identity while local IdleProof plumbing stays out of the change', () => {
  const cwd = repo();
  try {
    fs.mkdirSync(path.join(cwd, '.idleproof'), { recursive:true });
    fs.writeFileSync(path.join(cwd, '.idleproof', 'state.json'), '{}\n');
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive:true });
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), '{}\n');

    const baseline = captureBaselineIdentity(cwd);
    assert.equal(baseline.available, true, JSON.stringify(baseline));
    assert.equal(baseline.base.sha, git(cwd, 'rev-parse', 'HEAD'));
    assert.equal(baseline.base.tree, git(cwd, 'rev-parse', 'HEAD^{tree}'));

    fs.writeFileSync(path.join(cwd, 'app.js'), 'export const value = 2;\n');
    const change = finalizeChangeIdentity(cwd, baseline);
    assert.equal(change.available, true, JSON.stringify(change));
    assert.match(change.changeId, /^dwchg_[a-f0-9]{24}$/);
    assert.equal(change.base.tree, baseline.base.tree);
    assert.notEqual(change.candidate.tree, change.base.tree);
    assert.equal(change.candidate.dirty, true);
    assert.equal(change.candidate.sha, null);

    fs.writeFileSync(path.join(cwd, '.idleproof', 'state.json'), '{"updated":true}\n');
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), '{"hooks":true}\n');
    const sameChange = finalizeChangeIdentity(cwd, baseline);
    assert.equal(sameChange.changeId, change.changeId, 'local tool state changed the software change identity');
    assert.equal(sameChange.candidate.tree, change.candidate.tree);
  } finally {
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});

test('pre-existing dirty software work fails closed instead of being attributed to the agent session', () => {
  const cwd = repo();
  try {
    fs.writeFileSync(path.join(cwd, 'app.js'), 'export const value = 99;\n');
    const baseline = captureBaselineIdentity(cwd);
    assert.equal(baseline.available, false);
    assert.equal(baseline.reason, 'preexisting-dirty-worktree');
    const change = finalizeChangeIdentity(cwd, baseline);
    assert.equal(change.available, false);
    assert.equal(change.reason, 'preexisting-dirty-worktree');
  } finally {
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});

test('IdleProof receipt carries the same deterministic change id as the completed session proof', () => {
  const cwd = repo();
  try {
    const sessionId = 'identity-session';
    processHookEvent({ cwd, session_id:sessionId, hook_event_name:'UserPromptSubmit', prompt:'Change the app behavior' });
    fs.writeFileSync(path.join(cwd, 'app.js'), 'export const value = 3;\n');
    processHookEvent({ cwd, session_id:sessionId, hook_event_name:'PreToolUse', tool_name:'Edit', tool_input:{ file_path:path.join(cwd, 'app.js') } });
    processHookEvent({ cwd, session_id:sessionId, hook_event_name:'Stop' });

    const receipt = buildReceipt(cwd);
    assert.equal(receipt.schema, 'idleproof.receipt.v1');
    assert.equal(receipt.session.change.available, true, JSON.stringify(receipt.session.change));
    assert.equal(receipt.session.proof.changeId, receipt.session.change.changeId);
    assert.match(receipt.session.change.changeId, /^dwchg_[a-f0-9]{24}$/);
    assert.equal(receipt.session.change.repository.fingerprint.startsWith('dwrepo_'), true);
    assert.equal(receipt.session.change.base.dirty, false);
    assert.equal(receipt.session.change.candidate.dirty, true);
  } finally {
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});
