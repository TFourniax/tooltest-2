// Cross-process lock for the Portal memory cursor. `portal configure` and `portal disconnect`
// take the same lock, so a configuration change is serialized with every cursor write and with
// the initiation of every memory page request: once a change is committed, no page is started
// with the old token or endpoint.
//
// A lock is never evicted because of its age: a paused but live owner keeps it. It is recovered
// only when the process recorded in it no longer exists (or the file is unreadable garbage left
// by a crash), and an owner only ever removes the file while it still holds its own token.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { projectPaths } from './paths.mjs';

const LOCK_TIMEOUT_MS = 3000;
const GARBAGE_STALE_MS = 10000;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function readOwner(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

// True only when the current holder provably cannot release the lock any more.
function abandoned(file, content) {
  const match = /^(\d+) [a-f0-9]{32}\n$/.exec(content ?? '');
  if (match) return !processAlive(Number(match[1]));
  // Unparseable (a crash between create and write): recover only after a grace period.
  try { return Date.now() - fs.statSync(file).mtimeMs > GARBAGE_STALE_MS; } catch { return false; }
}

export function withMemoryLock(cwd, fn) {
  const file = projectPaths(cwd).portalMemoryLock;
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const token = `${process.pid} ${randomBytes(16).toString('hex')}\n`;
  const started = Date.now();
  let owned = false;
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, token);
      owned = true;
      break;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      const content = readOwner(file);
      // Remove an abandoned lock only if it is still the same abandoned lock we inspected.
      if (content !== null && abandoned(file, content) && readOwner(file) === content) {
        try { fs.unlinkSync(file); } catch {}
        continue;
      }
      Atomics.wait(sleepBuffer, 0, 0, 10);
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }
  }
  if (!owned) {
    const error = new Error('Portal memory cursor stayed busy for 3s.');
    error.code = 'IDLEPROOF_PORTAL_MEMORY_BUSY';
    throw error;
  }
  try { return fn(); }
  finally {
    // Never remove a lock that is no longer ours.
    if (readOwner(file) === token) { try { fs.unlinkSync(file); } catch {} }
  }
}
