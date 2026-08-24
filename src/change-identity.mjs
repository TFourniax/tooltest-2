import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const TRANSIENT_DIRS = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.hypothesis']);
const TRANSIENT_SUFFIXES = new Set(['.pyc', '.pyo']);
const TRANSIENT_FILES = new Set(['.coverage']);

function git(cwd, args, { env = process.env, input = undefined, timeout = 7000 } = {}) {
  return execFileSync('git', args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalized(relative = '') {
  return String(relative).replaceAll('\\', '/').replace(/^\.\//, '');
}

function repoRoot(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  if (!root) throw new Error('repository root unavailable');
  return path.resolve(root);
}

function isTransientUntracked(relative) {
  const value = normalized(relative);
  if (!value) return false;
  const parts = value.split('/').filter(Boolean);
  if (parts.includes('.idleproof')) return true;
  if (parts.length >= 2 && parts.at(-2) === '.claude' && parts.at(-1) === 'settings.local.json') return true;
  if (parts.length >= 2 && parts.at(-2) === '.codex' && parts.at(-1) === 'hooks.json') return true;
  if (parts.length >= 2 && parts.at(-2) === '.cursor' && parts.at(-1) === 'hooks.json') return true;
  if (parts.length >= 3 && parts.slice(-3).join('/') === '.cursor/rules/idleproof-continuity.mdc') return true;
  if (parts.some((part) => TRANSIENT_DIRS.has(part))) return true;
  const name = parts.at(-1) || '';
  if (TRANSIENT_FILES.has(name)) return true;
  const extension = path.posix.extname(name).toLowerCase();
  return TRANSIENT_SUFFIXES.has(extension);
}

export function repositoryFingerprint(cwd = process.cwd()) {
  const root=repoRoot(cwd);
  const roots = git(root, ['rev-list', '--max-parents=0', 'HEAD'])
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
  if (!roots.length) throw new Error('repository has no Git root commit');
  return `dwrepo_${sha256(roots.join('\n')).slice(0, 24)}`;
}

export function changeId({ repository, baseTree, candidateTree }) {
  const stable = {
    schema_version: 'change-envelope-1',
    repository,
    base_tree: baseTree,
    candidate_tree: candidateTree
  };
  return `dwchg_${sha256(canonical(stable)).slice(0, 24)}`;
}

function snapshotTree(cwd) {
  const root=repoRoot(cwd);
  const head = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  if (!head) throw new Error('repository has no HEAD commit');
  const headTree = git(root, ['rev-parse', '--verify', 'HEAD^{tree}']).trim();
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter(isTransientUntracked);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-index-'));
  const indexFile = path.join(tempDir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    git(root, ['read-tree', head], { env });
    // Snapshot the full meaningful worktree with an alternate index. This deliberately supports a
    // dirty repository: the user's pre-existing edits become the exact baseline, so only work made
    // after the coding task starts is attributed to that task. Local agent/IdleProof plumbing stays
    // outside the software identity and the user's real index is never modified.
    git(root, ['add', '-A', '--', '.'], { env, timeout: 20000 });
    for (const relative of [...new Set(untracked)]) {
      try { git(root, ['reset', '--quiet', head, '--', normalized(relative)], { env }); }
      catch { /* best-effort exclusion; write-tree still remains fail-closed below */ }
    }
    const tree = git(root, ['write-tree'], { env }).trim();
    if (!tree) throw new Error('Git did not produce a worktree tree');
    return { tree, sha: tree === headTree ? head : null, head, headTree, dirty: tree !== headTree };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
}

export function captureBaselineIdentity(cwd = process.cwd()) {
  try {
    const root=repoRoot(cwd);
    const repository = repositoryFingerprint(root);
    const base = snapshotTree(root);
    return {
      available: true,
      repository,
      base: { sha: base.sha, tree: base.tree, dirty: base.dirty }
    };
  } catch {
    return { available: false, reason: 'git-baseline-unavailable' };
  }
}

export function finalizeChangeIdentity(cwd = process.cwd(), baseline = null) {
  if (!baseline?.available || !baseline.repository || !baseline.base?.tree) {
    return {
      available: false,
      reason: baseline?.reason || 'baseline-unavailable'
    };
  }
  try {
    const candidate = snapshotTree(cwd);
    const id = changeId({
      repository: baseline.repository,
      baseTree: baseline.base.tree,
      candidateTree: candidate.tree
    });
    return {
      available: true,
      schema: 'change-envelope-1',
      changeId: id,
      repository: { fingerprint: baseline.repository },
      base: baseline.base,
      candidate: { sha: candidate.sha, tree: candidate.tree, dirty: candidate.dirty }
    };
  } catch {
    return { available: false, reason: 'git-candidate-unavailable' };
  }
}

export const __test = { canonical, isTransientUntracked, repositoryFingerprint, repoRoot, snapshotTree };
