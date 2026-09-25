// The memory cursor lock serializes configuration changes with page initiation; it must never be
// taken from a live owner, and an owner must never remove a lock that is not its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { projectPaths } from '../src/paths.mjs';
import { __memoryLockTest, withMemoryLock } from '../src/portal-memory-lock.mjs';

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

const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding:'utf8' }).stdout);

test('an unreadable lock is never evicted by age: its creator may still be about to publish itself', () => {
  const cwd = fixture();
  try {
    const file = plant(cwd, '', 60000);
    assert.throws(() => withMemoryLock(cwd, () => 'stolen'), { code:'IDLEPROOF_PORTAL_MEMORY_BUSY' });
    assert.equal(fs.existsSync(file), true, 'the unreadable lock is left in place');
  } finally { cleanup(cwd); }
});

test('the lock never exists without its owner token', () => {
  const cwd = fixture();
  try {
    const file = projectPaths(cwd).portalMemoryLock;
    withMemoryLock(cwd, () => { assert.match(fs.readFileSync(file, 'utf8'), /^\d+ [a-f0-9]{32}\n$/); });
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left behind');
  } finally { cleanup(cwd); }
});

test('a second evictor with a stale view never removes the lock the first evictor just took', () => {
  const cwd = fixture();
  try {
    const stale = `${deadPid()} ${'d'.repeat(32)}\n`;
    const file = plant(cwd, stale, 0);
    const kept = withMemoryLock(cwd, () => {
      // The first contender evicted the dead lock and now holds a new one. The second contender,
      // which inspected the same dead lock earlier, tries to recover it now.
      const mine = fs.readFileSync(file, 'utf8');
      assert.equal(__memoryLockTest.tryEvict(file, stale), false);
      return fs.readFileSync(file, 'utf8') === mine;
    });
    assert.equal(kept, true, 'the live replacement lock survived the stale eviction attempt');
  } finally { cleanup(cwd); }
});

test('while one evictor holds the recovery claim, no other evictor can remove the lock', () => {
  const cwd = fixture();
  try {
    const stale = `${deadPid()} ${'e'.repeat(32)}\n`;
    const file = plant(cwd, stale, 0);
    const claim = `${file}.evict-${createHash('sha256').update(stale).digest('hex').slice(0, 24)}`;
    fs.linkSync(file, claim); // a first evictor is between its checks and its unlink
    assert.equal(__memoryLockTest.tryEvict(file, stale), false);
    assert.equal(fs.readFileSync(file, 'utf8'), stale, 'the lock is untouched');
  } finally { cleanup(cwd); }
});

test('many processes recovering the same dead lock never overlap their critical sections', () => {
  const cwd = fixture();
  try {
    plant(cwd, `${deadPid()} ${'f'.repeat(32)}\n`, 0);
    const marker = path.join(cwd, 'inside');
    const worker = `
      import fs from 'node:fs';
      import { withMemoryLock } from ${JSON.stringify(new URL('../src/portal-memory-lock.mjs', import.meta.url).href)};
      const sleep = new Int32Array(new SharedArrayBuffer(4));
      for (let i = 0; i < 25; i += 1) {
        withMemoryLock(process.argv[1], () => {
          fs.writeFileSync(process.argv[2], String(process.pid), { flag:'wx' }); // throws if another holder is inside
          Atomics.wait(sleep, 0, 0, 1);
          fs.unlinkSync(process.argv[2]);
        });
      }`;
    const children = Array.from({ length:6 }, () => spawnSync(process.execPath, ['--input-type=module', '-e', worker, cwd, marker], { encoding:'utf8', timeout:60000 }));
    for (const child of children) assert.equal(child.status, 0, child.stderr);
  } finally { cleanup(cwd); }
});
