import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 4777;

export function projectPaths(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const dir = path.join(root, '.idleproof');
  return {
    root,
    dir,
    state: path.join(dir, 'state.json'),
    lock: path.join(dir, 'state.lock'),
    server: path.join(dir, 'server.json'),
    receipt: path.join(dir, 'receipt.json'),
    claudeSettings: path.join(root, '.claude', 'settings.local.json'),
    codexHooks: path.join(root, '.codex', 'hooks.json')
  };
}
