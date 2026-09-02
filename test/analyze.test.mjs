import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeDiff, captureGitSnapshot, detectConcepts, estimateWindow, eventText } from '../src/analyze.mjs';

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-analyze-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'IdleProof Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir });
  return dir;
}

test('detectConcepts maps agent activity to relevant cognitive concepts', () => {
  const ids = detectConcepts('Editing src/auth/session.tsx with React useEffect, JWT cookie, and npm test');
  for (const id of ['auth', 'react-state', 'typescript', 'testing']) assert.ok(ids.includes(id), `expected ${id}`);
});

test('hook protocol/session metadata does not fabricate an auth concept', () => {
  for (const event of [
    { session_id: 'calc-session', hook_event_name: 'SessionStart', source: 'codex' },
    { session_id: 'calc-session', hook_event_name: 'Stop', source: 'claude' },
    {
      session_id: 'calc-session',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/app.py', old_string: 'return a - b', new_string: 'return a + b' }
    }
  ]) {
    assert.ok(!detectConcepts(eventText(event)).includes('auth'), `protocol metadata leaked into auth classification: ${JSON.stringify(event)}`);
  }

  const realAuth = eventText({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: '/tmp/src/auth/session.ts', new_string: 'export function login() {}' }
  });
  assert.ok(detectConcepts(realAuth).includes('auth'), 'real auth/session project evidence must still classify as auth');
});

test('estimateWindow recognizes long-running validation commands', () => {
  assert.equal(estimateWindow({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }), 55);
  assert.equal(estimateWindow({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: {} }), 24);
  assert.equal(estimateWindow({ hook_event_name: 'Stop' }), 0);
});

test('analyzeDiff flags deterministic high-signal trust risks', () => {
  const findings = analyzeDiff('diff --git a/a.ts b/a.ts\n+const x = eval(userInput)\n+element.innerHTML = body');
  assert.ok(findings.some((item) => item.id === 'eval'));
  assert.ok(findings.some((item) => item.id === 'dangerous-html'));
});

test('captureGitSnapshot includes untracked source in proof hash and checks', () => {
  const dir = tempRepo();
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'auth.ts'), "export const token = process.env.VITE_SECRET_TOKEN;\n");
    const snapshot = captureGitSnapshot(dir);
    assert.ok(snapshot.files.includes('src/auth.ts'));
    assert.ok(snapshot.added >= 1);
    assert.match(snapshot.diff, /VITE_SECRET_TOKEN/);
    assert.match(snapshot.diffHash, /^[a-f0-9]{64}$/);
    assert.match(snapshot.head, /^[a-f0-9]{40}$/);
    assert.ok(analyzeDiff(snapshot.diff).some((item) => item.id === 'client-secret'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('captureGitSnapshot excludes IdleProof runtime/config artifacts from its own proof', () => {
  const dir = tempRepo();
  try {
    fs.mkdirSync(path.join(dir, '.idleproof'));
    fs.writeFileSync(path.join(dir, '.idleproof', 'state.json'), '{\"secret\":\"self\"}\n');
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{\"hooks\":{}}\n');
    fs.mkdirSync(path.join(dir, '.codex'));
    fs.writeFileSync(path.join(dir, '.codex', 'hooks.json'), '{\"hooks\":{}}\n');
    fs.writeFileSync(path.join(dir, 'real.js'), 'export const real = true;\n');
    const snapshot = captureGitSnapshot(dir);
    assert.deepEqual(snapshot.files, ['real.js']);
    assert.doesNotMatch(snapshot.diff, /idleproof|settings\.local|\.codex\/hooks/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
