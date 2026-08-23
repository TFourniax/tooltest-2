import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasCodexInstall, installCodex, uninstallCodex } from '../src/install-codex.mjs';

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-codex-install-'));
  execFileSync('git', ['init', '-q'], { cwd });
  const codex = path.join(cwd, '.codex');
  fs.mkdirSync(codex);
  fs.writeFileSync(path.join(codex, 'hooks.json'), JSON.stringify({
    description: 'existing project hooks',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo existing', timeout: 1 }] }],
      PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'echo policy' }] }]
    }
  }, null, 2));
  const binDir = path.join(cwd, 'bin');
  fs.mkdirSync(binDir);
  const binPath = path.join(binDir, 'idleproof.mjs');
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n');
  return { cwd, binPath };
}

test('Codex installer is idempotent, project-local, and preserves existing hooks', () => {
  const { cwd, binPath } = fixture();
  try {
    const file = installCodex({ cwd, binPath });
    installCodex({ cwd, binPath });
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.equal(config.description, 'existing project hooks');
    assert.ok(config.hooks.Stop.some((entry) => entry.hooks?.[0]?.command === 'echo existing'));
    assert.ok(config.hooks.PreToolUse.some((entry) => entry.hooks?.[0]?.command === 'echo policy'));
    assert.equal(config.hooks.Stop.filter((entry) => entry.hooks?.some((hook) => hook.command?.includes('hook-codex'))).length, 1);
    assert.equal(config.hooks.PreToolUse.filter((entry) => entry.hooks?.some((hook) => hook.command?.includes('hook-codex'))).length, 1);
    assert.match(config.hooks.PreToolUse.find((entry) => entry.hooks?.some((hook) => hook.command?.includes('hook-codex'))).matcher, /apply_patch/);
    assert.ok(hasCodexInstall(cwd));

    const exclude = fs.readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(exclude.split(/\r?\n/).filter((line) => line.trim() === '.codex/hooks.json').length, 1);

    assert.equal(uninstallCodex({ cwd }), true);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(after.hooks.Stop.some((entry) => entry.hooks?.[0]?.command === 'echo existing'));
    assert.ok(after.hooks.PreToolUse.some((entry) => entry.hooks?.[0]?.command === 'echo policy'));
    assert.equal(hasCodexInstall(cwd), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Codex installer refuses a missing IdleProof entrypoint without changing user hooks', () => {
  const { cwd } = fixture();
  try {
    const file = path.join(cwd, '.codex', 'hooks.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(
      () => installCodex({ cwd, binPath:path.join(cwd, 'missing-idleproof.mjs') }),
      /does not exist/i
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(hasCodexInstall(cwd), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
