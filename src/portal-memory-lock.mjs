// Cross-process lock for the Portal memory cursor. `portal configure` and `portal disconnect`
// take the same lock, so a configuration change is serialized with every cursor write and with
// the initiation of every memory page request: once a change is committed, no page is started
// with the old token or endpoint.
//
// Acquisition is atomic with the owner's identity: the `<pid> <incarnation> <random token>` line is
// written to a private temporary file which is then hard-linked into place, so a lock never exists
// without its owner, and its content identifies that one lock instance. The incarnation is the
// process start as the OS reports it (the start tick on Linux, the recorded start time from `ps` or
// Windows elsewhere; the same source contenders read), so a PID recycled by an unrelated process is
// not mistaken for the owner. When the OS value cannot be read the lock records none and only PID
// liveness is judged, which can keep a lock held but never evicts a live owner. A lock is never evicted because of its age. It
// is recovered only when the process recorded in it provably no longer exists (its PID is gone or
// now belongs to a later process); when that cannot be determined the lock stays held. Recovery is
// itself exclusive: the evictor first takes a claim named after the abandoned instance, then removes
// the lock only if it still holds that instance. A claim is a lock of the same kind (owner token,
// atomic publication, never evicted while its owner lives), so a claim left by an evictor that died
// is recovered by the same protocol, one level down. An owner only ever removes the file while it
// still holds its own token.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { projectPaths } from './paths.mjs';

const LOCK_TIMEOUT_MS = 3000;
const OWNER = /^(\d+) ([LW]\d+|U) [a-f0-9]{32}\n$/;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function readOwner(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function linuxStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return /^\d+$/.test(ticks ?? '') ? ticks : null;
  } catch { return null; }
}

const LINUX = process.platform === 'linux' && linuxStartTicks('self') !== null;
let selfIncarnation = null;

// This process's incarnation, recorded in every lock and claim it publishes: read once from the same
// OS source contenders use, never estimated.
function ownIncarnation() {
  if (selfIncarnation === null) {
    if (LINUX) selfIncarnation = `L${linuxStartTicks('self')}`;
    else { const started = startTimeOf(process.pid); selfIncarnation = started === null ? 'U' : `W${started}`; }
  }
  return selfIncarnation;
}

// Start time (epoch ms, UTC) the OS recorded for whichever process now has `pid`, or null when it
// cannot be read. The value is fixed at process creation, so later clock changes do not move it.
function startTimeOf(pid) {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding:'utf8', timeout:5000, windowsHide:true });
      const at = result.status === 0 ? Date.parse(result.stdout.trim()) : NaN;
      return Number.isFinite(at) ? at : null;
    }
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding:'utf8', timeout:5000, env:{ ...process.env, LC_ALL:'C', TZ:'UTC0' } });
    const at = result.status === 0 && result.stdout.trim() ? Date.parse(`${result.stdout.trim()} GMT`) : NaN;
    return Number.isFinite(at) ? at : null;
  } catch { return null; }
}

// True only when the recorded incarnation provably no longer runs: its PID is gone, or that PID now
// belongs to a process with another OS start value (a recycled PID). Unknown is never "gone".
function ownerGone(pid, incarnation, probe) {
  if (!processAlive(pid)) return true;
  if (incarnation === 'U') return false;
  if (incarnation.startsWith('L')) {
    if (!LINUX) return false;
    const now = probe.linux(pid);
    return now !== null && `L${now}` !== incarnation;
  }
  const started = probe.startTime(pid);
  return started !== null && `W${started}` !== incarnation;
}

const defaultProbe = { linux:linuxStartTicks, startTime:startTimeOf };
// One start-time lookup per PID per acquisition attempt: the wait loop polls every 10 ms and must
// not spawn a process each time. A stale answer only ever keeps a lock held, never evicts it.
function memoProbe() {
  const seen = new Map();
  return { linux:linuxStartTicks, startTime:(pid) => { if (!seen.has(pid)) seen.set(pid, startTimeOf(pid)); return seen.get(pid); } };
}

// Only a lock whose recorded owner provably no longer runs is abandoned. Anything unreadable is
// treated as held: acquisition never publishes a lock without its owner, so it cannot be ours to
// recover.
function abandoned(content, probe = defaultProbe) {
  const match = OWNER.exec(content ?? '');
  return Boolean(match) && ownerGone(Number(match[1]), match[2], probe);
}

function tryCreate(file, token) {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, token, { mode:0o600, flag:'wx' });
  try {
    fs.linkSync(temporary, file);
    return true;
  } catch (error) {
    if (['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) return false;
    throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

const newToken = () => `${process.pid} ${ownIncarnation()} ${randomBytes(16).toString('hex')}\n`;
// Claims are flat, fixed-length names derived from the claimed file and instance, so a chain of
// abandoned claims of any depth stays within file-name limits.
const claimPath = (file, content) => path.join(path.dirname(file),
  `${path.basename(file).split('.evict-')[0]}.evict-${createHash('sha256').update(`${path.basename(file)}\n${content}`).digest('hex').slice(0, 32)}`);

// Removes `file` only if it is still the abandoned instance observed as `content`. The claim for
// that instance is exclusive: it is created atomically with its owner's token, removed only by that
// owner, or recovered (under its own claim) once that owner is gone. While we hold it, the instance
// can be removed by nobody else and its dead owner never releases it, so the check and the unlink
// cannot be separated by another removal.
function tryEvict(file, content, probe = defaultProbe) {
  if (!abandoned(content, probe)) return false;
  const claim = claimPath(file, content);
  const token = newToken();
  if (!tryCreate(claim, token)) {
    // A claim left by an evictor that died is recovered one level down (to any depth: every level
    // is a claim whose owner is gone), then retried once.
    const held = readOwner(claim);
    if (held === null || !abandoned(held, probe) || !tryEvict(claim, held, probe)) return false;
    if (!tryCreate(claim, token)) return false;
  }
  try {
    if (readOwner(file) !== content) return false; // already recovered, possibly replaced by a live lock
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  } finally {
    if (readOwner(claim) === token) { try { fs.unlinkSync(claim); } catch {} }
  }
}

export function withMemoryLock(cwd, fn) {
  const file = projectPaths(cwd).portalMemoryLock;
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const token = newToken();
  const started = Date.now();
  const probe = memoProbe();
  let owned = false;
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    if (tryCreate(file, token)) { owned = true; break; }
    const content = readOwner(file);
    if (content !== null && abandoned(content, probe) && tryEvict(file, content, probe)) continue;
    Atomics.wait(sleepBuffer, 0, 0, 10);
  }
  if (!owned) {
    const error = new Error(`Portal memory cursor stayed busy for 3s (lock ${file}).`);
    error.code = 'IDLEPROOF_PORTAL_MEMORY_BUSY';
    throw error;
  }
  try { return fn(); }
  finally {
    // Never remove a lock that is no longer ours.
    if (readOwner(file) === token) { try { fs.unlinkSync(file); } catch {} }
  }
}

export const __memoryLockTest = { tryEvict, abandoned, claimPath, ownIncarnation, newToken, startTimeOf };
