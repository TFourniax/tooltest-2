import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './paths.mjs';
import { CONCEPTS } from './catalog.mjs';

export const CURRENT_STATE_VERSION = 2;

const LOCK_STALE_MS = 5000;
const LOCK_WAIT_MS = 8;
const LOCK_TIMEOUT_MS = 900;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms) {
  Atomics.wait(sleepBuffer, 0, 0, ms);
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
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(paths.lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(paths.lock);
          continue;
        }
      } catch {}
      sleep(LOCK_WAIT_MS);
    }
  }
  throw new Error('IdleProof state is busy; retry the hook event.');
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

  // Version 1 did not have the complete feature-memory surface. The additive merge below is the
  // migration: preserve known user data, introduce missing current fields, then persist version 2
  // on the next successful mutation. Future incompatible versions must get explicit migrations.
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
  // Filesystem/permission errors are operational failures, not corruption. Preserve them so an
  // unreadable primary cannot silently fall back to stale data.
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
    // A newer schema is not corruption. Falling back to an older backup would silently roll the
    // project backwards and can destroy fields the older runtime does not understand.
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

  // Preserve the last known-good primary before replacing it. Never rotate a malformed file into
  // the backup slot: an older healthy backup is more valuable for recovery.
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

export function computeMetrics(state) {
  let debt = 0;
  let weightedExposure = 0;
  let weightedConfidence = 0;
  let conceptsSeen = 0;

  for (const concept of CONCEPTS) {
    const entry = state.ledger[concept.id] || {};
    if (!entry.exposures) continue;
    conceptsSeen += 1;
    const weight = concept.risk;
    const exposureWeight = Math.min(8, entry.exposures) * weight;
    weightedExposure += exposureWeight;
    weightedConfidence += exposureWeight * (entry.confidence || 0);
    debt += Math.round(exposureWeight * (1 - (entry.confidence || 0)));
  }

  const coverage = weightedExposure === 0 ? 100 : Math.round((weightedConfidence / weightedExposure) * 100);
  const featureEntries = Object.values(state.features || {}).filter((entry) => (entry.exposures || 0) > 0);
  const featureExposure = featureEntries.reduce((sum, entry) => sum + Math.min(5, entry.exposures || 0), 0);
  const featureConfidence = featureEntries.reduce((sum, entry) => sum + Math.min(5, entry.exposures || 0) * (entry.confidence || 0), 0);
  const featureCoverage = featureExposure === 0 ? 0 : Math.round((featureConfidence / featureExposure) * 100);
  const featureDebt = featureEntries.reduce((sum, entry) => sum + Math.round(Math.min(5, entry.exposures || 0) * (1 - (entry.confidence || 0))), 0);
  return { debt, coverage, conceptsSeen, featureCoverage, featureDebt, featuresSeen: featureEntries.length };
}

export function trimSessions(state, maxSessions = 30) {
  const entries = Object.entries(state.sessions).sort((a, b) => {
    return String(b[1].lastEventAt || '').localeCompare(String(a[1].lastEventAt || ''));
  });
  state.sessions = Object.fromEntries(entries.slice(0, maxSessions));
  return state;
}
