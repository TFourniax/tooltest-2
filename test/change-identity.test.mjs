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

function cleanup(cwd) {
  fs.rmSync(cwd, { recursive:true, force:true, maxRetries:12, retryDelay:100 });
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
    cleanup(cwd);
  }
});

test('nested monorepo session binds sibling changes into the same full Git candidate tree', () => {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-monorepo-id-'));
  try {
    git(cwd,'init','-q');
    git(cwd,'config','user.email','monorepo@idleproof.local');
    git(cwd,'config','user.name','IdleProof Monorepo');
    const app=path.join(cwd,'packages','app');
    const shared=path.join(cwd,'packages','shared');
    fs.mkdirSync(app,{recursive:true});
    fs.mkdirSync(shared,{recursive:true});
    fs.writeFileSync(path.join(app,'main.ts'),'export const app = 1;\n');
    fs.writeFileSync(path.join(shared,'util.ts'),'export const shared = 1;\n');
    fs.writeFileSync(path.join(cwd,'root.config.js'),'export default 1;\n');
    git(cwd,'add','.');
    git(cwd,'commit','-qm','monorepo baseline');

    // IdleProof is deliberately launched from a nested package.
    const baseline=captureBaselineIdentity(app);
    assert.equal(baseline.available,true,JSON.stringify(baseline));

    // The agent touches its package, a sibling package, and a root-level file.
    fs.writeFileSync(path.join(app,'main.ts'),'export const app = 2;\n');
    fs.writeFileSync(path.join(shared,'util.ts'),'export const shared = 2;\n');
    fs.writeFileSync(path.join(cwd,'root.config.js'),'export default 2;\n');
    fs.mkdirSync(path.join(app,'.idleproof'),{recursive:true});
    fs.writeFileSync(path.join(app,'.idleproof','state.json'),'local only\n');
    fs.mkdirSync(path.join(shared,'.codex'),{recursive:true});
    fs.writeFileSync(path.join(shared,'.codex','hooks.json'),'{}\n');

    const change=finalizeChangeIdentity(app,baseline);
    assert.equal(change.available,true,JSON.stringify(change));

    // Build the expected global software tree with the real index, excluding local plumbing.
    fs.rmSync(path.join(app,'.idleproof'),{recursive:true,force:true});
    fs.rmSync(path.join(shared,'.codex'),{recursive:true,force:true});
    git(cwd,'add','-A','.');
    const expectedTree=git(cwd,'write-tree');
    git(cwd,'reset','--quiet','HEAD');

    assert.equal(change.candidate.tree,expectedTree,'nested IdleProof session did not bind the full repository worktree');
    assert.notEqual(change.candidate.tree,change.base.tree);
    assert.equal(change.changeId,changeId({repository:change.repository.fingerprint,baseTree:change.base.tree,candidateTree:expectedTree}));
  } finally {
    cleanup(cwd);
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
    cleanup(cwd);
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
    assert.equal(receipt.session.intent.chars,'Change the app behavior'.length);
    assert.equal(receipt.session.intent.retainedChars,'Change the app behavior'.length);
  } finally {
    cleanup(cwd);
  }
});
