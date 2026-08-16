import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildFeatureModel } from './feature-model.mjs';

const modelCache = new Map();
const MAX_CACHE = 80;

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function sorted(values) {
  return unique(values).sort();
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function featureAnchor(model = {}) {
  const storyFiles = (model.story || []).filter((step) => step.type === 'file');
  const entry = storyFiles.find((step) => ['ui', 'api', 'core'].includes(step.role)) || storyFiles[0] || null;
  const route = model.surfaces?.routes?.[0] || null;
  const technology = model.surfaces?.technologies?.[0] || null;
  return {
    entry: entry?.label || null,
    route,
    technology: !entry && !route ? technology : null
  };
}

export function featureKey(model = {}) {
  const anchor = featureAnchor(model);
  if (!anchor.entry && !anchor.route && !anchor.technology) return model.fingerprint || null;
  return stableHash(anchor);
}

export function featureSnapshot(model = {}) {
  return {
    story: sorted((model.story || []).map((step) => `${step.role || step.type}:${step.label}`)),
    routes: sorted(model.surfaces?.routes),
    tables: sorted(model.surfaces?.tables),
    technologies: sorted(model.surfaces?.technologies),
    tests: sorted(model.tests)
  };
}

function setDiff(before = [], after = []) {
  const a = new Set(before);
  const b = new Set(after);
  return {
    added: [...b].filter((value) => !a.has(value)),
    removed: [...a].filter((value) => !b.has(value))
  };
}

export function compareFeatureSnapshots(previous = null, current = null) {
  if (!previous || !current) {
    return { changed: false, level: 'none', score: 0, added: {}, removed: {}, summary: 'No previous feature model to compare.' };
  }
  const groups = ['story', 'routes', 'tables', 'technologies', 'tests'];
  const diffs = Object.fromEntries(groups.map((key) => [key, setDiff(previous[key], current[key])]));
  const weights = { story: 1, routes: 4, tables: 3, technologies: 4, tests: 1 };
  let score = 0;
  const added = {};
  const removed = {};
  for (const key of groups) {
    if (diffs[key].added.length) added[key] = diffs[key].added;
    if (diffs[key].removed.length) removed[key] = diffs[key].removed;
    score += (diffs[key].added.length + diffs[key].removed.length) * weights[key];
  }
  const changed = score > 0;
  const materialBoundaryChange = Boolean(
    diffs.routes.added.length || diffs.routes.removed.length ||
    diffs.tables.added.length || diffs.tables.removed.length ||
    diffs.technologies.added.length || diffs.technologies.removed.length
  );
  const level = !changed ? 'none' : materialBoundaryChange || score >= 6 ? 'material' : 'minor';
  const summaries = [];
  if (diffs.routes.added.length) summaries.push(`new route ${diffs.routes.added.join(', ')}`);
  if (diffs.routes.removed.length) summaries.push(`removed route ${diffs.routes.removed.join(', ')}`);
  if (diffs.technologies.added.length) summaries.push(`new external boundary ${diffs.technologies.added.join(', ')}`);
  if (diffs.technologies.removed.length) summaries.push(`removed external boundary ${diffs.technologies.removed.join(', ')}`);
  if (diffs.tables.added.length) summaries.push(`new persistence surface ${diffs.tables.added.join(', ')}`);
  if (diffs.tables.removed.length) summaries.push(`removed persistence surface ${diffs.tables.removed.join(', ')}`);
  if (!summaries.length && changed) summaries.push('the connected code/test structure changed');
  return {
    changed,
    level,
    score,
    added,
    removed,
    summary: changed ? summaries.join(' · ') : 'No meaningful feature-model drift detected.'
  };
}

function cacheKey(cwd, session = {}) {
  return JSON.stringify({
    cwd: path.resolve(cwd),
    id: session.id || null,
    event: session.lastEventAt || null,
    resource: session.currentResource || null,
    files: (session.touchedFiles || []).slice(-8),
    signalFile: session.taskSignals?.file || null,
    technologies: session.taskSignals?.technologies || []
  });
}

export function cachedFeatureModel(cwd = process.cwd(), session = {}) {
  const key = cacheKey(cwd, session);
  if (modelCache.has(key)) return modelCache.get(key);
  const model = buildFeatureModel(cwd, session);
  model.featureKey = featureKey(model);
  modelCache.set(key, model);
  if (modelCache.size > MAX_CACHE) modelCache.delete(modelCache.keys().next().value);
  return model;
}

export function findFeatureMemory(state = {}, model = {}) {
  const key = model.featureKey || featureKey(model);
  if (key && state.features?.[key]) return state.features[key];
  if (model.fingerprint && state.features?.[model.fingerprint]) return state.features[model.fingerprint];
  return null;
}

export function previewFeatureDrift(state = {}, model = {}) {
  const memory = findFeatureMemory(state, model);
  if (!memory?.snapshot || !model?.generatedFrom?.filesInspected) return null;
  const drift = compareFeatureSnapshots(memory.snapshot, featureSnapshot(model));
  return drift.changed ? drift : null;
}

function baseMemory(model, session) {
  return {
    featureKey: model.featureKey || featureKey(model),
    fingerprint: model.fingerprint,
    exposures: 0,
    checks: 0,
    correct: 0,
    wrong: 0,
    confidence: 0,
    firstSeenAt: new Date().toISOString(),
    sessionIds: [],
    task: String(session?.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 180)
  };
}

export function rememberFeature(state, session, model, { exposure = true } = {}) {
  if (!model?.generatedFrom?.filesInspected) return null;
  state.features ||= {};
  const key = model.featureKey || featureKey(model);
  if (!key) return null;
  const legacy = model.fingerprint ? state.features[model.fingerprint] : null;
  const current = state.features[key] || legacy || baseMemory(model, session);
  const nextSnapshot = featureSnapshot(model);
  const drift = current.snapshot ? compareFeatureSnapshots(current.snapshot, nextSnapshot) : { changed: false, level: 'none', score: 0, added: {}, removed: {}, summary: 'First observed model for this feature.' };

  if (exposure && session?.id && !current.sessionIds?.includes(session.id)) current.exposures = (current.exposures || 0) + 1;
  current.sessionIds = unique([...(current.sessionIds || []), session?.id]).slice(-12);
  current.lastSeenAt = new Date().toISOString();
  current.task = String(session?.prompt || current.task || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  current.previousFingerprint = current.fingerprint || null;
  current.fingerprint = model.fingerprint;
  current.featureKey = key;
  current.story = (model.story || []).slice(0, 7);
  current.surfaces = model.surfaces || { routes: [], tables: [], technologies: [] };
  current.tests = (model.tests || []).slice(0, 12);
  current.riskNotes = (model.riskNotes || []).slice(0, 6);
  current.snapshot = nextSnapshot;

  if (drift.changed) {
    current.lastDrift = { ...drift, at: new Date().toISOString(), fromFingerprint: current.previousFingerprint, toFingerprint: model.fingerprint };
    current.needsRefresh = true;
    if (drift.level === 'material') current.confidence = Math.min(current.confidence || 0, 0.65);
    else current.confidence = Math.min(current.confidence || 0, 0.85);
  } else if (current.needsRefresh == null) {
    current.needsRefresh = false;
  }

  if (legacy && key !== model.fingerprint) delete state.features[model.fingerprint];
  state.features[key] = current;
  return current;
}

export function scoreFeatureAnswer(state, session, model, correct) {
  const entry = rememberFeature(state, session, model, { exposure: true }) || baseMemory(model, session);
  entry.checks = (entry.checks || 0) + 1;
  if (correct) {
    entry.correct = (entry.correct || 0) + 1;
    entry.confidence = Math.min(1, (entry.confidence || 0) + ((entry.confidence || 0) < 0.5 ? 0.32 : 0.16));
    entry.needsRefresh = false;
  } else {
    entry.wrong = (entry.wrong || 0) + 1;
    entry.confidence = Math.max(0, (entry.confidence || 0) - 0.08);
  }
  entry.lastAnsweredAt = new Date().toISOString();
  state.features[entry.featureKey] = entry;
  return entry;
}

export function recentFeatureMemory(state = {}, limit = 8) {
  return Object.values(state.features || {})
    .filter((entry) => entry?.featureKey || entry?.fingerprint)
    .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))
    .slice(0, limit);
}
