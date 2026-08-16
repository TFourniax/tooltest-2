import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './paths.mjs';
import { CONCEPTS } from './catalog.mjs';

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
    version: 2,
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

export function loadState(cwd = process.cwd()) {
  const { state: statePath } = projectPaths(cwd);
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const base = freshState(cwd);
    return {
      ...base,
      ...parsed,
      preferences: { ...base.preferences, ...(parsed.preferences || {}) },
      ledger: { ...base.ledger, ...(parsed.ledger || {}) },
      sessions: parsed.sessions || {},
      features: parsed.features || {}
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return freshState(cwd);
    throw error;
  }
}

export function saveState(cwd, state) {
  const paths = projectPaths(cwd);
  fs.mkdirSync(paths.dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temp = `${paths.state}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, paths.state);
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
