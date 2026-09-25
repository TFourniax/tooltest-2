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
// A lock (or claim) is a directory holding its owner line.
const put = (lock, content) => { fs.mkdirSync(lock, { recursive:true }); fs.writeFileSync(path.join(lock, 'owner'), content); };
const ownerOf = (lock) => fs.readFileSync(path.join(lock, 'owner'), 'utf8');
const plant = (cwd, content, ageMs) => {
  const file = projectPaths(cwd).portalMemoryLock;
  fs.mkdirSync(path.dirname(file), { recursive:true });
  put(file, content);
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
    assert.equal(ownerOf(file), `${process.pid} ${ME} ${'a'.repeat(32)}\n`, 'the live owner still holds it');
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
    withMemoryLock(cwd, () => { fs.writeFileSync(path.join(file, 'owner'), foreign); });
    assert.equal(ownerOf(file), foreign, 'the replacement owner keeps its lock');
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
    withMemoryLock(cwd, () => { assert.match(ownerOf(file), /^\d+ [LW]\d+ [a-f0-9]{32}\n$/); });
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), [], 'no temporary directory is left behind');
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
      const mine = ownerOf(file);
      assert.equal(__memoryLockTest.tryEvict(file, stale), false);
      return ownerOf(file) === mine;
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
    put(claim, `${process.pid} ${ME} ${'9'.repeat(32)}\n`); // a live evictor is between its check and its unlink
    assert.equal(__memoryLockTest.tryEvict(file, stale), false);
    assert.throws(() => withMemoryLock(cwd, () => 'stolen'), { code:'IDLEPROOF_PORTAL_MEMORY_BUSY' });
    assert.equal(ownerOf(file), stale, 'the lock is untouched');
    assert.equal(ownerOf(claim), `${process.pid} ${ME} ${'9'.repeat(32)}\n`, 'the live claim is untouched');
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
        put(claim, content);
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
    assert.equal(__memoryLockTest.abandoned(ownerOf(file)), true);
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
      put(claim, content);
      target = claim;
    }
    assert.equal(withMemoryLock(cwd, () => 'recovered'), 'recovered');
    assert.equal(fs.existsSync(file), false);
  } finally { cleanup(cwd); }
});

test('a lock directory left without its owner by an interrupted release is reclaimed', () => {
  const cwd = fixture();
  try {
    const file = projectPaths(cwd).portalMemoryLock;
    fs.mkdirSync(file, { recursive:true }); // the owner file was removed, the directory was not
    assert.equal(withMemoryLock(cwd, () => 'acquired'), 'acquired');
    assert.equal(fs.existsSync(file), false);
  } finally { cleanup(cwd); }
});

test('the lock never needs hard links (filesystems without them work)', () => {
  const cwd = fixture();
  const original = fs.linkSync;
  // As on exFAT or some network mounts: every hard link is refused although no lock exists.
  fs.linkSync = () => { const error = new Error('operation not permitted'); error.code = 'EPERM'; throw error; };
  try {
    assert.equal(withMemoryLock(cwd, () => 'acquired'), 'acquired');
    assert.equal(withMemoryLock(cwd, () => 'again'), 'again', 'released and acquired again');
  } finally { fs.linkSync = original; cleanup(cwd); }
});

// Linux-only by nature: zombies and /proc process states are Linux kernel semantics.
test('a lock owner that is a zombie (killed, not yet reaped) is recovered', { skip:process.platform !== 'linux' }, async () => {
  const cwd = fixture();
  // `sleep 0` exits in the background; its parent execs into `sleep 5`, which never reaps it.
  const parent = spawn('sh', ['-c', 'sleep 0 & echo $!; exec sleep 5'], { stdio:['ignore', 'pipe', 'ignore'] });
  try {
    const pid = Number(await new Promise((resolve) => parent.stdout.once('data', (chunk) => resolve(String(chunk).trim()))));
    let state = '';
    for (let i = 0; i < 100 && state !== 'Z'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]; } catch { state = 'gone'; }
    }
    assert.equal(state, 'Z', 'the fixture owner is a zombie');
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const file = plant(cwd, `${pid} L${ticks} ${'3'.repeat(32)}\n`, 0); // its exact incarnation
    assert.equal(withMemoryLock(cwd, () => 'recovered'), 'recovered');
    assert.equal(fs.existsSync(file), false);
  } finally { parent.kill(); cleanup(cwd); }
});

test('a lock that changes hands is never probed for its owner start time, a settled one is', async () => {
  const cwd = fixture();
  try {
    // A live owner (this process, in the start-time form used outside Linux) releases after 200 ms.
    const file = plant(cwd, `${process.pid} W${__memoryLockTest.startTimeOf(process.pid)} ${'2'.repeat(32)}\n`, 0);
    const releaser = spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').rmSync(${JSON.stringify(file)}, { recursive:true, force:true }), 200)`]);
    const before = __memoryLockTest.startTimeProbes();
    assert.equal(withMemoryLock(cwd, () => 'acquired'), 'acquired');
    assert.equal(__memoryLockTest.startTimeProbes() - before, 0, 'no start-time lookup while the lock is simply busy');
    await new Promise((resolve) => releaser.once('close', resolve));
    // A lock left under a recycled PID never changes; once settled it is probed and recovered.
    const startedAt = __memoryLockTest.startTimeOf(process.pid);
    plant(cwd, `${process.pid} W${startedAt - 1000} ${'1'.repeat(32)}\n`, 0);
    const t0 = Date.now();
    assert.equal(withMemoryLock(cwd, () => 'recovered'), 'recovered');
    assert.ok(Date.now() - t0 >= 450, 'probed only after the lock settled');
  } finally { cleanup(cwd); }
});

test('many processes recovering the same dead lock never overlap their critical sections', async () => {
  const cwd = fixture();
  try {
    const stale = `${deadPid()} ${ME} ${'f'.repeat(32)}\n`;
    const file = plant(cwd, stale, 0);
    // The first recovery also has to get past a claim left by an evictor that died.
    put(__memoryLockTest.claimPath(file, stale), `${deadPid()} ${ME} ${'8'.repeat(32)}\n`);
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
