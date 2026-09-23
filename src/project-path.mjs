import path from 'node:path';

// Local paths use the host's separator. On POSIX, a backslash is a filename
// character, so replacing it would silently identify another file.
export function normalizedProjectPath(value = '') {
  return String(value || '').split(path.sep).join('/').replace(/^\.\//, '');
}
