// The memory cursor lock serializes configuration changes with page initiation; it must never be
// taken from a live owner, and an owner must never remove a lock that is not its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectPaths } from '../src/paths.mjs';
import { withMemoryLock } from '../src/portal-memory-lock.mjs';

const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-memory-lock-'));
const cleanup = (cwd) => { try { fs.rmSync(cwd, { recursive:true, force:true }); } catch {} };
const plant = (cwd, content, ageMs) => {
  const file = projectPaths(cwd).portalMemoryLock;
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.writeFileSync(file, content);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  return file;
};

test('a live owner keeps the lock however old it is', () => {
  const cwd = fixture();
  try {
    // A paused but live process (this one) holding the lock for a minute.
    const file = plant(cwd, `${process.pid} ${'a'.repeat(32)}\n`, 60000);
    assert.throws(() => withMemoryLock(cwd, () => 'stolen'), { code:'IDLEPROOF_PORTAL_MEMORY_BUSY' });
    assert.equal(fs.readFileSync(file, 'utf8'), `${process.pid} ${'a'.repeat(32)}\n`, 'the live owner still holds it');
  } finally { cleanup(cwd); }
});

test('a lock left by a dead process is recovered at once', () => {
  const cwd = fixture();
  try {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding:'utf8' });
    const pid = Number(dead.stdout);
    assert.ok(pid > 0);
    plant(cwd, `${pid} ${'b'.repeat(32)}\n`, 0);
    assert.equal(withMemoryLock(cwd, () => 'recovered'), 'recovered');
    assert.equal(fs.existsSync(projectPaths(cwd).portalMemoryLock), false);
  } finally { cleanup(cwd); }
});

test('an owner never removes a lock that is no longer its own', () => {
  const cwd = fixture();
  try {
    const file = projectPaths(cwd).portalMemoryLock;
    const foreign = `${process.pid} ${'c'.repeat(32)}\n`;
    withMemoryLock(cwd, () => { fs.writeFileSync(file, foreign); });
    assert.equal(fs.readFileSync(file, 'utf8'), foreign, 'the replacement owner keeps its lock');
  } finally { cleanup(cwd); }
});
