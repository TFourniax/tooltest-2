// Cross-process lock for the Portal memory cursor. `portal configure` and `portal disconnect`
// take the same lock, so a configuration change is serialized with every cursor write and with
// the initiation of every memory page request: once a change is committed, no page is started
// with the old token or endpoint.
//
// Acquisition is atomic with the owner's identity: the token is written to a private temporary
// file which is then hard-linked into place, so the lock never exists without its owner. A lock is
// never evicted because of its age. It is recovered only when the process recorded in it no longer
// exists, and recovery is itself exclusive: the evictor first pins the stale inode with a hard
// link that only one contender can create, then removes the lock only if that pinned inode still
// carries the stale content and is still the one at the lock path. An owner only ever removes the
// file while it still holds its own token.
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

function sameInode(left, right) {
  try {
    const a = fs.statSync(left, { bigint:true });
    const b = fs.statSync(right, { bigint:true });
    return a.ino === b.ino && a.dev === b.dev;
  } catch { return false; }
}

// Exclusive recovery of the abandoned lock whose content was observed as `content`.
function tryEvict(file, content) {
  const claim = `${file}.evict-${createHash('sha256').update(content).digest('hex').slice(0, 24)}`;
  try { fs.linkSync(file, claim); }
  catch { return false; } // another evictor holds the claim, or the lock is already gone
  try {
    // The claim pins whatever inode was at the lock path; it must be the abandoned one we inspected
    // and still be the one there. Nobody can publish a new lock while the path is occupied, and no
    // other evictor can pass the claim, so the unlink removes exactly the abandoned lock.
    if (readOwner(claim) !== content || !abandoned(content) || !sameInode(claim, file)) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(claim); } catch {}
  }
}

export function withMemoryLock(cwd, fn) {
  const file = projectPaths(cwd).portalMemoryLock;
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const token = `${process.pid} ${randomBytes(16).toString('hex')}\n`;
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

export const __memoryLockTest = { tryEvict, abandoned };
