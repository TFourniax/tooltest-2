// Cross-process lock for the Portal memory cursor. `portal configure` and `portal disconnect`
// take the same lock, so a configuration change is serialized with every cursor write and with
// the initiation of every memory page request: once a change is committed, no page is started
// with the old token or endpoint.
//
// Acquisition is atomic with the owner's identity: the `<pid> <random token>` line is written to a
// private temporary file which is then hard-linked into place, so a lock never exists without its
// owner, and its content identifies that one lock instance. A lock is never evicted because of its
// age. It is recovered only when the process recorded in it no longer exists, and recovery is
// itself exclusive: the evictor first takes a claim named after the abandoned instance, then removes
// the lock only if it still holds that instance. A claim is a lock of the same kind (owner token,
// atomic publication, never evicted while its owner lives), so a claim left by an evictor that died
// is recovered by the same protocol, one level down. An owner only ever removes the file while it
// still holds its own token.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { projectPaths } from './paths.mjs';

const LOCK_TIMEOUT_MS = 3000;
const OWNER = /^(\d+) [a-f0-9]{32}\n$/;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function readOwner(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

// Only a lock whose recorded owner provably no longer exists is abandoned. Anything unreadable is
// treated as held: acquisition never publishes a lock without its owner, so it cannot be ours to
// recover.
function abandoned(content) {
  const match = OWNER.exec(content ?? '');
  return Boolean(match) && !processAlive(Number(match[1]));
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

const MAX_CLAIM_DEPTH = 4;
const newToken = () => `${process.pid} ${randomBytes(16).toString('hex')}\n`;
const claimPath = (file, content) => `${file}.evict-${createHash('sha256').update(content).digest('hex').slice(0, 24)}`;

// Removes `file` only if it is still the abandoned instance observed as `content`. The claim for
// that instance is exclusive: it is created atomically with its owner's token, removed only by that
// owner, or recovered (under its own claim) once that owner is gone. While we hold it, the instance
// can be removed by nobody else and its dead owner never releases it, so the check and the unlink
// cannot be separated by another removal.
function tryEvict(file, content, depth = 0) {
  if (!abandoned(content)) return false;
  const claim = claimPath(file, content);
  const token = newToken();
  if (!tryCreate(claim, token)) {
    // A claim left by an evictor that died is recovered one level down, then retried once.
    const held = readOwner(claim);
    if (depth >= MAX_CLAIM_DEPTH || held === null || !abandoned(held) || !tryEvict(claim, held, depth + 1)) return false;
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
  let owned = false;
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    if (tryCreate(file, token)) { owned = true; break; }
    const content = readOwner(file);
    if (content !== null && abandoned(content) && tryEvict(file, content)) continue;
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

export const __memoryLockTest = { tryEvict, abandoned, claimPath };
