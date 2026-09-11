import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/idleproof.mjs');

function run(cwd, ...args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 5000
  });
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-reset-'));
  execFileSync('git', ['init', '-q'], { cwd });
  const dir = path.join(cwd, '.idleproof');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 2, sentinel: 'keep-me' }));
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ proof: 'keep-me-too' }));
  return cwd;
}

test('reset archives local learning/evidence state by default', () => {
  const cwd = fixture();
  try {
    const output = run(cwd, 'reset');
    assert.match(output, /archived before reset/i);
    assert.equal(fs.existsSync(path.join(cwd, '.idleproof')), false);

    const recovery = path.join(cwd, '.git', 'idleproof-recovery');
    const entries = fs.readdirSync(recovery);
    assert.equal(entries.length, 1);
    const archived = path.join(recovery, entries[0]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(archived, 'state.json'), 'utf8')).sentinel, 'keep-me');
    assert.equal(JSON.parse(fs.readFileSync(path.join(archived, 'receipt.json'), 'utf8')).proof, 'keep-me-too');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('reset --force is explicit irreversible deletion', () => {
  const cwd = fixture();
  try {
    const output = run(cwd, 'reset', '--force');
    assert.match(output, /permanently deleted/i);
    assert.equal(fs.existsSync(path.join(cwd, '.idleproof')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.git', 'idleproof-recovery')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
