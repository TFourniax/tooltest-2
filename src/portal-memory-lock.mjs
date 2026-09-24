// Cross-process lock for the Portal memory cursor. `portal configure` and `portal disconnect`
// take the same lock, so a configuration change is serialized with every cursor write and with
// the initiation of every memory page request: once a change is committed, no page is started
// with the old token or endpoint.
import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './paths.mjs';

const LOCK_STALE_MS = 10000;
const LOCK_TIMEOUT_MS = 3000;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export function withMemoryLock(cwd, fn) {
  const file = projectPaths(cwd).portalMemoryLock;
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const started = Date.now();
  let fd = null;
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid} ${Date.now()}\n`);
      break;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      try { if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(file); continue; } } catch {}
      Atomics.wait(sleepBuffer, 0, 0, 10);
    }
  }
  if (fd == null) {
    const error = new Error('Portal memory cursor stayed busy for 3s.');
    error.code = 'IDLEPROOF_PORTAL_MEMORY_BUSY';
    throw error;
  }
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(file); } catch {}
  }
}
