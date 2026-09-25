// The memory cursor lock serializes configuration changes with page initiation; it must never be
// taken from a live owner, and an owner must never remove a lock that is not its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { projectPaths } from '../src/paths.mjs';
import { __memoryLockTest, withMemoryLock } from '../src/portal-memory-lock.mjs';

const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-memory-lock-'));
const ME = __memoryLockTest.ownIncarnation();
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
    const file = plant(cwd, `${process.pid} ${ME} ${'a'.repeat(32)}\n`, 60000);
    assert.throws(() => withMemoryLock(cwd, () => 'stolen'), { code:'IDLEPROOF_PORTAL_MEMORY_BUSY' });
    assert.equal(fs.readFileSync(file, 'utf8'), `${process.pid} ${ME} ${'a'.repeat(32)}\n`, 'the live owner still holds it');
  } finally { cleanup(cwd); }
});

test('a lock left by a dead process is recovered at once', () => {
  const cwd = fixture();
  try {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding:'utf8' });
    const pid = Number(dead.stdout);
    assert.ok(pid > 0);
    plant(cwd, `${pid} ${ME} ${'b'.repeat(32)}\n`, 0);
    assert.equal(withMemoryLock(cwd, () => 'recovered'), 'recovered');
    assert.equal(fs.existsSync(projectPaths(cwd).portalMemoryLock), false);
  } finally { cleanup(cwd); }
});

test('an owner never removes a lock that is no longer its own', () => {
  const cwd = fixture();
  try {
    const file = projectPaths(cwd).portalMemoryLock;
    const foreign = `${process.pid} ${ME} ${'c'.repeat(32)}\n`;
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
    withMemoryLock(cwd, () => { assert.match(fs.readFileSync(file, 'utf8'), /^\d+ [LW]\d+ [a-f0-9]{32}\n$/); });
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left behind');
  } finally { cleanup(cwd); }
});

test('a second evictor with a stale view never removes the lock the first evictor just took', () => {
  const cwd = fixture();
  try {
    const stale = `${deadPid()} ${ME} ${'d'.repeat(32)}\n`;
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
    const stale = `${deadPid()} ${ME} ${'e'.repeat(32)}\n`;
    const file = plant(cwd, stale, 0);
    const claim = __memoryLockTest.claimPath(file, stale);
    fs.writeFileSync(claim, `${process.pid} ${ME} ${'9'.repeat(32)}\n`); // a live evictor is between its check and its unlink
    assert.equal(__memoryLockTest.tryEvict(file, stale), false);
    assert.throws(() => withMemoryLock(cwd, () => 'stolen'), { code:'IDLEPROOF_PORTAL_MEMORY_BUSY' });
    assert.equal(fs.readFileSync(file, 'utf8'), stale, 'the lock is untouched');
    assert.equal(fs.readFileSync(claim, 'utf8'), `${process.pid} ${ME} ${'9'.repeat(32)}\n`, 'the live claim is untouched');
  } finally { cleanup(cwd); }
});

test('a claim left by an evictor that died is recovered, and so is a claim on that claim', () => {
  for (const levels of [1, 2]) {
    const cwd = fixture();
    try {
      const stale = `${deadPid()} ${ME} ${'7'.repeat(32)}\n`;
      const file = plant(cwd, stale, 0);
      // Evictors that died after taking their claim and before releasing it.
      let target = file, content = stale;
      for (let level = 0; level < levels; level += 1) {
        const claim = __memoryLockTest.claimPath(target, content);
        content = `${deadPid()} ${ME} ${String(level).repeat(32)}\n`;
        fs.writeFileSync(claim, content);
        target = claim;
      }
      assert.equal(withMemoryLock(cwd, () => 'recovered'), 'recovered', `${levels} abandoned claim level(s)`);
      assert.equal(fs.existsSync(file), false);
    } finally { cleanup(cwd); }
  }
});

test('a PID recycled by a later process is not mistaken for the lock owner', () => {
  const cwd = fixture();
  try {
    // This live process stands in for the unrelated process that received the dead owner's PID:
    // the lock records an earlier incarnation of that PID.
    const earlier = ME.startsWith('L') ? 'L1' : 'W1';
    const file = plant(cwd, `${process.pid} ${earlier} ${'5'.repeat(32)}\n`, 0);
    assert.equal(__memoryLockTest.abandoned(fs.readFileSync(file, 'utf8')), true);
    assert.equal(withMemoryLock(cwd, () => 'recovered'), 'recovered');
    assert.equal(fs.existsSync(file), false);
    // The start-time form (used outside Linux) compares the OS-recorded start exactly, on every platform.
    const startedAt = __memoryLockTest.startTimeOf(process.pid);
    assert.equal(typeof startedAt, 'number', 'the OS start time of this process is readable');
    assert.equal(startedAt, __memoryLockTest.startTimeOf(process.pid), 'the OS start value is stable across reads');
    assert.equal(__memoryLockTest.abandoned(`${process.pid} W${startedAt - 1000} ${'5'.repeat(32)}\n`), true, 'another incarnation of this PID is gone');
    assert.equal(__memoryLockTest.abandoned(`${process.pid} W${startedAt} ${'5'.repeat(32)}\n`), false, 'the current incarnation is alive');
    assert.equal(__memoryLockTest.abandoned(`${process.pid} U ${'5'.repeat(32)}\n`), false, 'an unknown incarnation of a live PID is held');
    // The same PID with its own incarnation is the live owner and keeps the lock.
    plant(cwd, `${process.pid} ${ME} ${'6'.repeat(32)}\n`, 0);
    assert.throws(() => withMemoryLock(cwd, () => 'stolen'), { code:'IDLEPROOF_PORTAL_MEMORY_BUSY' });
  } finally { cleanup(cwd); }
});

test('an abandoned claim chain of any depth is recovered, with bounded file names', () => {
  const cwd = fixture();
  try {
    const stale = `${deadPid()} ${ME} ${'4'.repeat(32)}\n`;
    const file = plant(cwd, stale, 0);
    let target = file, content = stale;
    for (let level = 0; level < 6; level += 1) { // six evictors killed in turn while holding their claims
      const claim = __memoryLockTest.claimPath(target, content);
      assert.ok(path.basename(claim).length <= path.basename(file).length + 40, 'claim names do not grow with depth');
      content = `${deadPid()} ${ME} ${String(level).repeat(32)}\n`;
      fs.writeFileSync(claim, content);
      target = claim;
    }
    assert.equal(withMemoryLock(cwd, () => 'recovered'), 'recovered');
    assert.equal(fs.existsSync(file), false);
  } finally { cleanup(cwd); }
});

test('many processes recovering the same dead lock never overlap their critical sections', async () => {
  const cwd = fixture();
  try {
    const stale = `${deadPid()} ${ME} ${'f'.repeat(32)}\n`;
    const file = plant(cwd, stale, 0);
    // The first recovery also has to get past a claim left by an evictor that died.
    fs.writeFileSync(__memoryLockTest.claimPath(file, stale), `${deadPid()} ${ME} ${'8'.repeat(32)}\n`);
    const marker = path.join(cwd, 'inside');
    const worker = `
      import fs from 'node:fs';
      import { withMemoryLock } from ${JSON.stringify(new URL('../src/portal-memory-lock.mjs', import.meta.url).href)};
      const sleep = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sleep, 0, 0, Number(process.argv[3]) - Date.now()); // start together
      for (let i = 0; i < 25; i += 1) {
        withMemoryLock(process.argv[1], () => {
          fs.writeFileSync(process.argv[2], String(process.pid), { flag:'wx' }); // throws if another holder is inside
          Atomics.wait(sleep, 0, 0, 1);
          fs.unlinkSync(process.argv[2]);
        });
      }`;
    const startAt = String(Date.now() + 1500);
    const run = () => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', worker, cwd, marker, startAt], { stdio:['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stderr }));
    });
    const children = await Promise.all(Array.from({ length:6 }, run)); // concurrently, not one after another
    for (const child of children) assert.equal(child.status, 0, child.stderr);
  } finally { cleanup(cwd); }
});
