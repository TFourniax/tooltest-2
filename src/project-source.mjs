import { normalizedProjectPath } from './project-path.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SOURCE_FILE_BYTES = 128 * 1024;
const norm = (value = '') => normalizedProjectPath(value);

export function isExcludedProjectPath(relative = '') {
  const value = norm(relative);
  return !value || ['.git/', '.idleproof/', 'node_modules/', 'dist/', 'build/', '.next/', 'coverage/', '.venv/', 'venv/', '__pycache__/'].some((prefix) => value.startsWith(prefix));
}

export function isInsideProject(cwd, candidate) {
  const relative = path.relative(path.resolve(cwd), path.resolve(cwd, candidate));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function admitProjectSource(cwd, candidate) {
  if (typeof candidate !== 'string' || !candidate || !isInsideProject(cwd, candidate)) return null;
  const absolute = path.resolve(cwd, candidate);
  const relative = norm(path.relative(path.resolve(cwd), absolute));
  // The shared structure protocol cannot represent literal backslashes.
  // Keep such local names unavailable instead of aliasing a supported path.
  if (relative.includes('\\') || isExcludedProjectPath(relative)) return null;
  try {
    const root = fs.realpathSync(cwd), canonical = fs.realpathSync(absolute);
    if (!isInsideProject(root, canonical) || isExcludedProjectPath(path.relative(root, canonical))) return null;
    const stat = fs.statSync(canonical);
    if (!stat.isFile() || stat.size > SOURCE_FILE_BYTES) return null;
    return {relative, absolute, root, canonical, stat};
  } catch { return null; }
}

function sameSource(left, right) {
  return right.isFile() && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => left[key] === right[key]);
}

export function readProjectSource(cwd, candidate) {
  const admitted = admitProjectSource(cwd, candidate);
  if (!admitted) return null;
  let fd;
  try {
    // Bind bounded reads to the checked target's descriptor. Rechecking identity
    // and paths detects common swaps; this does not constitute an OS sandbox.
    fd = fs.openSync(admitted.canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const before = fs.fstatSync(fd);
    if (!sameSource(admitted.stat, before)) return null;
    const buffer = Buffer.allocUnsafe(SOURCE_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size > SOURCE_FILE_BYTES || size !== before.size || !sameSource(before, fs.fstatSync(fd))) return null;
    if (fs.realpathSync(cwd) !== admitted.root || fs.realpathSync(admitted.absolute) !== admitted.canonical
        || !sameSource(before, fs.statSync(admitted.canonical))) return null;
    const bytes = buffer.subarray(0, size);
    if (bytes.includes(0)) return null;
    const text = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes);
    return {relative:admitted.relative, absolute:admitted.absolute, size, text,
            sha256:createHash('sha256').update(bytes).digest('hex')};
  } catch { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
