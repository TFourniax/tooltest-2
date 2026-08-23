import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './paths.mjs';
import { CONCEPTS } from './catalog.mjs';

export const CURRENT_STATE_VERSION = 2;

// Agent hooks can arrive in bursts from parallel tool calls/subagents. An uncontended
// lock is still acquired immediately, but a writer now waits long enough for other
// short atomic mutations instead of dropping an otherwise valid hook after <1s.
// A stale lock threshold longer than the acquisition timeout prevents a slow but live
// writer from being unlinked by another process.
const LOCK_STALE_MS = 15000;
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 7500;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms) {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function isLockContention(error, file) {
  if (error?.code === 'EEXIST') return true;
  // Windows can surface an active exclusive/share lock as EPERM/EACCES rather than
  // EEXIST. Treat that as contention only when the lock path actually exists; a real
  // directory/ACL failure with no lock must still fail immediately and visibly.
  if (!['EPERM', 'EACCES'].includes(error?.code)) return false;
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function acquireLock(cwd) {
  const paths = projectPaths(cwd);
  fs.mkdirSync(paths.dir, { recursive: true });
  const started = Date.now();

  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      const fd = fs.openSync(paths.lock, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid} ${Date.now()}\n`);
      return () => {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(paths.lock); } catch {}
      };
    } catch (error) {
      if (!isLockContention(error, paths.lock)) throw error;
      try {
        const stat = fs.statSync(paths.lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try { fs.unlinkSync(paths.lock); } catch {}
          continue;
        }
      } catch {}
      sleep(LOCK_WAIT_MS);
    }
  }
  throw new Error('IdleProof state stayed busy for 7.5s; refusing to drop or overwrite a concurrent hook event.');
}

export function freshState(cwd = process.cwd()) {
  return {
    version: CURRENT_STATE_VERSION,
    project: path.basename(path.resolve(cwd)),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    preferences: {
      level: 'adaptive',
      mode: 'learn',
      sponsorCards: false
    },
    sessions: {},
    features: {},
    ledger: Object.fromEntries(CONCEPTS.map((concept) => [concept.id, {
      exposures: 0,
      correct: 0,
      wrong: 0,
      confidence: 0,
      lastSeenAt: null,
      lastAnsweredAt: null
    }]))
  };
}

function normalizeState(cwd, parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('IdleProof state root must be a JSON object.');
    error.code = 'IDLEPROOF_STATE_CORRUPT';
    throw error;
  }

  const rawVersion = parsed.version ?? 1;
  if (!Number.isInteger(rawVersion) || rawVersion < 1) {
    const error = new Error(`IdleProof state has an invalid version: ${String(rawVersion)}`);
    error.code = 'IDLEPROOF_STATE_CORRUPT';
    throw error;
  }
  if (rawVersion > CURRENT_STATE_VERSION) {
    const error = new Error(
      `IdleProof state version ${rawVersion} is newer than this runtime supports (${CURRENT_STATE_VERSION}). Upgrade IdleProof before opening this project.`
    );
    error.code = 'IDLEPROOF_STATE_NEWER_VERSION';
    throw error;
  }

  const migrated = { ...parsed, version: CURRENT_STATE_VERSION };
  const base = freshState(cwd);
  return {
    ...base,
    ...migrated,
    version: CURRENT_STATE_VERSION,
    preferences: { ...base.preferences, ...(migrated.preferences || {}) },
    ledger: { ...base.ledger, ...(migrated.ledger || {}) },
    sessions: migrated.sessions || {},
    features: migrated.features || {}
  };
}

function readStateFile(file, cwd) {
  const raw = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const wrapped = new Error(`Cannot parse IdleProof state file ${file}: ${error.message}`);
    wrapped.code = 'IDLEPROOF_STATE_CORRUPT';
    wrapped.cause = error;
    throw wrapped;
  }
  return normalizeState(cwd, parsed);
}

function recoverStateFromBackup(cwd, primaryError) {
  const paths = projectPaths(cwd);
  try {
    return readStateFile(paths.stateBackup, cwd);
  } catch (backupError) {
    if (backupError.code === 'ENOENT') {
      const error = new Error(
        `IdleProof state is unreadable and no backup exists at ${paths.stateBackup}. Refusing to silently reset your learning history.`
      );
      error.code = 'IDLEPROOF_STATE_UNRECOVERABLE';
      error.cause = primaryError;
      throw error;
    }
    if (backupError.code === 'IDLEPROOF_STATE_NEWER_VERSION') throw backupError;
    const error = new Error(
      `IdleProof state and backup are both unreadable. Primary: ${primaryError.message} Backup: ${backupError.message}`
    );
    error.code = 'IDLEPROOF_STATE_UNRECOVERABLE';
    error.cause = primaryError;
    throw error;
  }
}

export function loadState(cwd = process.cwd()) {
  const paths = projectPaths(cwd);
  try {
    return readStateFile(paths.state, cwd);
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        return readStateFile(paths.stateBackup, cwd);
      } catch (backupError) {
        if (backupError.code === 'ENOENT') return freshState(cwd);
        throw backupError;
      }
    }
    if (error.code === 'IDLEPROOF_STATE_NEWER_VERSION') throw error;
    if (error.code === 'IDLEPROOF_STATE_CORRUPT') return recoverStateFromBackup(cwd, error);
    throw error;
  }
}

function writeAtomic(file, content) {
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

export function saveState(cwd, state) {
  const paths = projectPaths(cwd);
  fs.mkdirSync(paths.dir, { recursive: true });
  state.version = CURRENT_STATE_VERSION;
  state.updatedAt = new Date().toISOString();

  try {
    const previous = fs.readFileSync(paths.state, 'utf8');
    const parsedPrevious = JSON.parse(previous);
    normalizeState(cwd, parsedPrevious);
    writeAtomic(paths.stateBackup, previous.endsWith('\n') ? previous : `${previous}\n`);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'IDLEPROOF_STATE_CORRUPT' || error instanceof SyntaxError) {
      // First save, or a corrupt primary being explicitly repaired after successful backup load.
    } else {
      throw error;
    }
  }

  writeAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

export function mutateState(cwd, mutator) {
  const release = acquireLock(cwd);
  try {
    const state = loadState(cwd);
    const result = mutator(state) ?? state;
    saveState(cwd, result);
    return result;
  } finally {
    release();
  }
}

function conceptChecks(entry = {}) {
  return Number(entry.correct || 0) + Number(entry.wrong || 0);
}

export function computeMetrics(state) {
  let debt = 0;
  let checkedWeight = 0;
  let checkedConfidence = 0;
  let unverifiedExposure = 0;
  let conceptsSeen = 0;
  let conceptsChecked = 0;
  let conceptsUnverified = 0;

  for (const concept of CONCEPTS) {
    const entry = state.ledger?.[concept.id] || {};
    if (!entry.exposures) continue;
    conceptsSeen += 1;
    const exposureWeight = Math.min(8, Number(entry.exposures || 0)) * concept.risk;
    const checks = conceptChecks(entry);
    if (!checks) {
      conceptsUnverified += 1;
      unverifiedExposure += exposureWeight;
      continue;
    }
    conceptsChecked += 1;
    const evidenceWeight = Math.min(8, checks) * concept.risk;
    checkedWeight += evidenceWeight;
    checkedConfidence += evidenceWeight * Number(entry.confidence || 0);
    debt += Math.round(evidenceWeight * (1 - Number(entry.confidence || 0)));
  }

  const coverage = checkedWeight === 0 ? 0 : Math.round((checkedConfidence / checkedWeight) * 100);
  const coverageStatus = checkedWeight === 0 ? 'unverified' : 'demonstrated';

  const featureEntries = Object.values(state.features || {}).filter((entry) => (entry.exposures || 0) > 0);
  const checkedFeatures = featureEntries.filter((entry) => Number(entry.checks || 0) > 0);
  const featuresUnverified = featureEntries.length - checkedFeatures.length;
  const featureEvidence = checkedFeatures.reduce((sum, entry) => sum + Math.min(5, Number(entry.checks || 0)), 0);
  const featureConfidence = checkedFeatures.reduce((sum, entry) => sum + Math.min(5, Number(entry.checks || 0)) * Number(entry.confidence || 0), 0);
  const featureCoverage = featureEvidence === 0 ? 0 : Math.round((featureConfidence / featureEvidence) * 100);
  const featureDebt = checkedFeatures.reduce((sum, entry) => {
    const evidenceWeight = Math.min(5, Number(entry.checks || 0));
    return sum + Math.round(evidenceWeight * (1 - Number(entry.confidence || 0)));
  }, 0);

  return {
    debt,
    coverage,
    coverageStatus,
    conceptsSeen,
    conceptsChecked,
    conceptsUnverified,
    unverifiedExposure,
    featureCoverage,
    featureDebt,
    featuresSeen:featureEntries.length,
    featuresChecked:checkedFeatures.length,
    featuresUnverified
  };
}

export function trimSessions(state, maxSessions = 30) {
  const entries = Object.entries(state.sessions).sort((a, b) => {
    return String(b[1].lastEventAt || '').localeCompare(String(a[1].lastEventAt || ''));
  });
  state.sessions = Object.fromEntries(entries.slice(0, maxSessions));
  return state;
}
