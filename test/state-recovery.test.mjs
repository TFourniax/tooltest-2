import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CURRENT_STATE_VERSION, freshState, loadState, saveState } from '../src/state.mjs';
import { projectPaths } from '../src/paths.mjs';

function withProject(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-state-'));
  try { return fn(cwd); }
  finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

test('state keeps a last-known-good backup and recovers instead of silently resetting', () => {
  withProject((cwd) => {
    const paths = projectPaths(cwd);
    const first = freshState(cwd);
    first.preferences.level = 'beginner';
    saveState(cwd, first);

    const second = loadState(cwd);
    second.preferences.level = 'experienced';
    saveState(cwd, second);
    assert.equal(fs.existsSync(paths.stateBackup), true);

    fs.writeFileSync(paths.state, '{broken json', 'utf8');
    const recovered = loadState(cwd);
    assert.equal(recovered.preferences.level, 'beginner');
    assert.equal(recovered.version, CURRENT_STATE_VERSION);
  });
});

test('state corruption without a healthy backup fails visibly', () => {
  withProject((cwd) => {
    const paths = projectPaths(cwd);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.state, '{broken', 'utf8');
    fs.writeFileSync(paths.stateBackup, '{also broken', 'utf8');
    assert.throws(
      () => loadState(cwd),
      (error) => error?.code === 'IDLEPROOF_STATE_UNRECOVERABLE' && /both unreadable/i.test(error.message)
    );
  });
});

test('older additive state is migrated while a newer state is never downgraded', () => {
  withProject((cwd) => {
    const paths = projectPaths(cwd);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.state, JSON.stringify({
      version: 1,
      project: 'legacy-project',
      preferences: { level: 'beginner' },
      ledger: {},
      sessions: {}
    }), 'utf8');
    const migrated = loadState(cwd);
    assert.equal(migrated.version, CURRENT_STATE_VERSION);
    assert.equal(migrated.project, 'legacy-project');
    assert.equal(migrated.preferences.level, 'beginner');
    assert.ok(migrated.features);

    fs.writeFileSync(paths.state, JSON.stringify({ version: CURRENT_STATE_VERSION + 1 }), 'utf8');
    assert.throws(
      () => loadState(cwd),
      (error) => error?.code === 'IDLEPROOF_STATE_NEWER_VERSION' && /upgrade IdleProof/i.test(error.message)
    );
  });
});
