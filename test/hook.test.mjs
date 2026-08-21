import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildReceipt, processHookEvent } from '../src/hook.mjs';
import { loadState } from '../src/state.mjs';
import { projectPaths } from '../src/paths.mjs';

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-hook-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'IdleProof Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const ok = true;\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir });
  return dir;
}

test('hook lifecycle records unverified exposure, footprint, trust findings, and a diff-bound receipt', () => {
  const cwd = tempRepo();
  const sessionId = 'session-test';
  try {
    processHookEvent({ cwd, session_id: sessionId, hook_event_name: 'UserPromptSubmit', prompt: 'Add JWT auth and protected API tests' });
    processHookEvent({ cwd, session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'app.js') } });
    fs.writeFileSync(path.join(cwd, 'app.js'), "export const html = user => eval(user); // auth session jwt\n");
    processHookEvent({ cwd, session_id: sessionId, hook_event_name: 'Stop' });

    const state = loadState(cwd);
    const session = state.sessions[sessionId];
    assert.equal(session.status, 'complete');
    assert.ok(session.concepts.auth);
    assert.ok(state.ledger.auth.exposures >= 1);
    assert.ok(session.changed.added >= 1);
    assert.ok(session.findings.some((item) => item.id === 'eval'));
    assert.match(session.proof.diffSha256, /^[a-f0-9]{64}$/);

    const receipt = buildReceipt(cwd);
    assert.equal(receipt.schema, 'idleproof.receipt.v1');
    assert.equal(receipt.session.proof.diffSha256, session.proof.diffSha256);
    assert.equal(receipt.metrics.debt, 0, 'mere exposure must not be mislabeled as Knowledge Debt');
    assert.equal(receipt.metrics.coverageStatus, 'unverified');
    assert.ok(receipt.metrics.conceptsUnverified > 0, 'unverified concepts should remain visible');
    assert.ok(receipt.metrics.unverifiedExposure > 0, 'unverified exposure should be measured separately from debt');
    assert.ok(fs.existsSync(projectPaths(cwd).receipt));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
