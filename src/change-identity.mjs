import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const TRANSIENT_DIRS = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.hypothesis']);
const TRANSIENT_SUFFIXES = new Set(['.pyc', '.pyo']);
const TRANSIENT_FILES = new Set(['.coverage']);
const LOCAL_PRODUCT_PATHS = new Set(['.claude/settings.local.json', '.codex/hooks.json']);

function git(cwd, args, { env = process.env, input = undefined, timeout = 5000 } = {}) {
  return execFileSync('git', args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout,
    maxBuffer: 4 * 1024 * 1024
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

function isTransientUntracked(relative) {
  const value = normalized(relative);
  if (!value) return false;
  if (value === '.idleproof' || value.startsWith('.idleproof/')) return true;
  if (LOCAL_PRODUCT_PATHS.has(value)) return true;
  const parts = value.split('/');
  if (parts.some((part) => TRANSIENT_DIRS.has(part))) return true;
  const name = parts.at(-1) || '';
  if (TRANSIENT_FILES.has(name)) return true;
  const extension = path.posix.extname(name).toLowerCase();
  return TRANSIENT_SUFFIXES.has(extension);
}

function repositoryFingerprint(cwd) {
  const roots = git(cwd, ['rev-list', '--max-parents=0', 'HEAD'])
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

function meaningfulDirty(cwd) {
  const raw = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = raw.split('\0').filter(Boolean);
  for (const entry of entries) {
    const status = entry.slice(0, 2);
    const relative = entry.slice(3);
    if (status === '??' && isTransientUntracked(relative)) continue;
    return true;
  }
  return false;
}

function snapshotTree(cwd) {
  const head = git(cwd, ['rev-parse', '--verify', 'HEAD']).trim();
  if (!head) throw new Error('repository has no HEAD commit');
  const headTree = git(cwd, ['rev-parse', '--verify', 'HEAD^{tree}']).trim();
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter(isTransientUntracked);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-index-'));
  const indexFile = path.join(tempDir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    git(cwd, ['read-tree', head], { env });
    git(cwd, ['add', '-A', '--', '.'], { env, timeout: 15000 });
    for (const relative of [...new Set(untracked)]) {
      try { git(cwd, ['reset', '--quiet', head, '--', normalized(relative)], { env }); }
      catch { /* best-effort exclusion; write-tree still remains fail-closed below */ }
    }
    const tree = git(cwd, ['write-tree'], { env }).trim();
    if (!tree) throw new Error('Git did not produce a worktree tree');
    return { tree, sha: tree === headTree ? head : null, head, headTree, dirty: tree !== headTree };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function captureBaselineIdentity(cwd = process.cwd()) {
  try {
    const head = git(cwd, ['rev-parse', '--verify', 'HEAD']).trim();
    const tree = git(cwd, ['rev-parse', '--verify', 'HEAD^{tree}']).trim();
    const repository = repositoryFingerprint(cwd);
    if (meaningfulDirty(cwd)) {
      return {
        available: false,
        reason: 'preexisting-dirty-worktree',
        repository,
        observedHead: head,
        observedHeadTree: tree
      };
    }
    return {
      available: true,
      repository,
      base: { sha: head, tree, dirty: false }
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

export const __test = { canonical, isTransientUntracked, repositoryFingerprint };
