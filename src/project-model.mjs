import { buildDueFeatureReviews, nextFeatureRecallChallenge } from './feature-review.mjs';

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function fileSteps(entry = {}) {
  return (entry.story || []).filter((step) => step.type === 'file' && step.label);
}

function roleWeight(role) {
  if (['api', 'service', 'data'].includes(role)) return 4;
  if (['ui', 'core'].includes(role)) return 2;
  if (role === 'test') return 1;
  return 1;
}

function featureId(entry = {}) {
  return entry.featureKey || entry.fingerprint || null;
}

function publicFeature(entry = {}) {
  return {
    featureKey: featureId(entry),
    task: entry.task || 'Previously learned feature',
    confidence: Math.round((entry.confidence || 0) * 100),
    exposures: entry.exposures || 0,
    needsRefresh: Boolean(entry.needsRefresh),
    drift: entry.lastDrift || null,
    lastSeenAt: entry.lastSeenAt || null,
    story: (entry.story || []).slice(0, 5)
  };
}

function touchedFiles(session = {}) {
  return unique([
    session.currentResource,
    session.taskSignals?.file,
    ...(session.touchedFiles || []).slice(-20)
  ].map((file) => String(file || '').replaceAll('\\', '/')));
}

function modeledFiles(currentFeatureModel = null) {
  return unique(fileSteps(currentFeatureModel || {}).map((step) => String(step.label || '').replaceAll('\\', '/')));
}

export function buildChangeImpact(state = {}, session = {}, currentFeatureModel = null) {
  const directFiles = touchedFiles(session);
  // The active file alone can understate blast radius. A task reading an API route may have a
  // bounded local feature graph that reaches a shared service actually modified by the change.
  // Use that deterministic, project-local graph for overlap detection while keeping direct vs
  // modeled files separate in the public result so we never pretend every dependency was touched.
  const graphFiles = modeledFiles(currentFeatureModel);
  const relevant = new Set(unique([...directFiles, ...graphFiles]));
  const currentKey = currentFeatureModel?.featureKey || null;
  const affected = [];

  for (const entry of Object.values(state.features || {})) {
    const key = featureId(entry);
    if (!key) continue;
    const shared = fileSteps(entry).filter((step) => relevant.has(step.label));
    if (!shared.length) continue;
    const structuralWeight = shared.reduce((sum, step) => sum + roleWeight(step.role), 0);
    const uncertainty = 1 - (entry.confidence || 0);
    affected.push({
      ...publicFeature(entry),
      sameFeature: Boolean(currentKey && key === currentKey),
      sharedFiles: shared.map((step) => ({ file: step.label, role: step.role })),
      impactScore: Math.round((structuralWeight * (1 + uncertainty)) * 100) / 100
    });
  }

  affected.sort((a, b) => b.impactScore - a.impactScore || a.task.localeCompare(b.task));
  const otherFeatures = affected.filter((item) => !item.sameFeature);
  const weak = otherFeatures.filter((item) => item.needsRefresh || item.confidence < 60);
  const sharedFiles = unique(otherFeatures.flatMap((item) => item.sharedFiles.map((file) => file.file)));
  return {
    touchedFiles: directFiles,
    modeledFiles: graphFiles.filter((file) => !directFiles.includes(file)),
    relevantFiles: [...relevant],
    affected,
    otherFeatures,
    weak,
    blastRadius: otherFeatures.length,
    summary: otherFeatures.length
      ? `This task's observed feature surface overlaps ${otherFeatures.length} other learned feature${otherFeatures.length === 1 ? '' : 's'} through ${sharedFiles.slice(0, 3).join(', ')}.`
      : 'No other learned feature currently overlaps the observed files for this task.'
  };
}

export function buildProjectTopology(state = {}) {
  const fileMap = new Map();
  const boundaryMap = new Map();

  for (const entry of Object.values(state.features || {})) {
    const key = featureId(entry);
    if (!key) continue;
    for (const step of fileSteps(entry)) {
      const item = fileMap.get(step.label) || { file: step.label, role: step.role, features: new Set(), confidence: [], refresh: 0 };
      item.features.add(key);
      item.confidence.push(entry.confidence || 0);
      if (entry.needsRefresh) item.refresh += 1;
      fileMap.set(step.label, item);
    }
    const boundaries = [
      ...(entry.surfaces?.routes || []).map((value) => ['route', value]),
      ...(entry.surfaces?.tables || []).map((value) => ['data', value]),
      ...(entry.surfaces?.technologies || []).map((value) => ['external', value])
    ];
    for (const [type, value] of boundaries) {
      const id = `${type}:${value}`;
      const item = boundaryMap.get(id) || { type, value, features: new Set() };
      item.features.add(key);
      boundaryMap.set(id, item);
    }
  }

  const hotspots = [...fileMap.values()]
    .map((item) => ({
      file: item.file,
      role: item.role,
      featureCount: item.features.size,
      featureKeys: [...item.features],
      averageFluency: item.confidence.length ? Math.round((item.confidence.reduce((a, b) => a + b, 0) / item.confidence.length) * 100) : 0,
      refreshCount: item.refresh
    }))
    .filter((item) => item.featureCount >= 2)
    .sort((a, b) => b.featureCount - a.featureCount || b.refreshCount - a.refreshCount || a.file.localeCompare(b.file));

  const sharedBoundaries = [...boundaryMap.values()]
    .map((item) => ({ type: item.type, value: item.value, featureCount: item.features.size, featureKeys: [...item.features] }))
    .filter((item) => item.featureCount >= 2)
    .sort((a, b) => b.featureCount - a.featureCount || a.value.localeCompare(b.value));

  return { hotspots: hotspots.slice(0, 16), sharedBoundaries: sharedBoundaries.slice(0, 16) };
}

export function buildFeatureReviewQueue(state = {}, limit = 8, now = Date.now()) {
  return buildDueFeatureReviews(state, { limit, now });
}

export function buildProjectModel(state = {}, session = {}, currentFeatureModel = null, now = Date.now()) {
  const impact = buildChangeImpact(state, session, currentFeatureModel);
  const topology = buildProjectTopology(state);
  const reviewQueue = buildFeatureReviewQueue(state, 8, now);
  const reviewChallenge = nextFeatureRecallChallenge(state, now);
  return {
    schema: 'idleproof.project-mental-model.v1',
    impact,
    topology,
    reviewQueue,
    reviewChallenge: reviewChallenge ? {
      challengeId: reviewChallenge.challengeId,
      featureKey: reviewChallenge.featureKey,
      kind: reviewChallenge.kind,
      question: reviewChallenge.question,
      options: reviewChallenge.options
    } : null,
    stats: {
      learnedFeatures: Object.values(state.features || {}).filter((entry) => (entry.exposures || 0) > 0).length,
      sharedHotspots: topology.hotspots.length,
      pendingFeatureReviews: reviewQueue.filter((item) => item.due && (item.needsRefresh || item.confidence < 60 || item.reason.includes('spaced'))).length
    }
  };
}
