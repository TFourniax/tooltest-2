import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasClaudeInstall, installClaude, uninstallClaude } from '../src/install.mjs';

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-install-'));
  const claude = path.join(cwd, '.claude');
  fs.mkdirSync(claude);
  fs.writeFileSync(path.join(claude, 'settings.local.json'), JSON.stringify({
    permissions: { allow: ['Bash(git status:*)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] }
  }, null, 2));
  const binDir = path.join(cwd, 'bin');
  fs.mkdirSync(binDir);
  const binPath = path.join(binDir, 'idleproof.mjs');
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n');
  return { cwd, binPath };
}

test('Claude installer is idempotent and preserves existing settings/hooks', () => {
  const { cwd, binPath } = fixture();
  try {
    const file = installClaude({ cwd, binPath });
    installClaude({ cwd, binPath });
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['Bash(git status:*)']);
    assert.ok(settings.hooks.Stop.some((entry) => entry.hooks?.[0]?.command === 'echo existing'));
    assert.equal(settings.hooks.Stop.filter((entry) => entry.hooks?.some((hook) => hook.command?.includes('idleproof.mjs'))).length, 1);
    assert.ok(hasClaudeInstall(cwd));

    assert.equal(uninstallClaude({ cwd }), true);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(after.hooks.Stop.some((entry) => entry.hooks?.[0]?.command === 'echo existing'));
    assert.equal(hasClaudeInstall(cwd), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Claude installer refuses a missing IdleProof entrypoint without changing user settings', () => {
  const { cwd } = fixture();
  try {
    const file = path.join(cwd, '.claude', 'settings.local.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(
      () => installClaude({ cwd, binPath:path.join(cwd, 'missing-idleproof.mjs') }),
      /does not exist/i
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(hasClaudeInstall(cwd), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
