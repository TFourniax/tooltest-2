import { createHash } from 'node:crypto';

function featureId(entry = {}) {
  return entry.featureKey || entry.fingerprint || null;
}

function minutesSince(iso, now = Date.now()) {
  if (!iso) return Infinity;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? Math.max(0, (now - value) / 60000) : Infinity;
}

export function nextFeatureReviewMinutes(confidence = 0, needsRefresh = false) {
  if (needsRefresh) return 0;
  if (confidence < 0.35) return 10;
  if (confidence < 0.6) return 24 * 60;
  if (confidence < 0.8) return 3 * 24 * 60;
  return 7 * 24 * 60;
}

export function featureReviewDue(entry = {}, now = Date.now()) {
  if (entry.needsRefresh) return true;
  if (!entry.lastAnsweredAt) return true;
  return minutesSince(entry.lastAnsweredAt, now) >= nextFeatureReviewMinutes(entry.confidence || 0, false);
}

export function featureReviewDueAt(entry = {}) {
  if (entry.needsRefresh || !entry.lastAnsweredAt) return null;
  const base = Date.parse(entry.lastAnsweredAt);
  if (!Number.isFinite(base)) return null;
  return new Date(base + nextFeatureReviewMinutes(entry.confidence || 0, false) * 60000).toISOString();
}

function collectBoundaries(state = {}, excludeKey = null) {
  const values = [];
  for (const entry of Object.values(state.features || {})) {
    if (featureId(entry) === excludeKey) continue;
    for (const value of entry.surfaces?.technologies || []) values.push(value);
    for (const value of entry.surfaces?.routes || []) values.push(value);
    for (const value of entry.surfaces?.tables || []) values.push(value);
    for (const step of entry.story || []) if (step.type === 'file' && step.label) values.push(step.label);
  }
  return [...new Set(values.filter(Boolean))];
}

function stableShuffle(values, seed) {
  const scored = values.map((value, index) => ({
    value,
    score: createHash('sha256').update(`${seed}|${index}|${value}`).digest('hex')
  }));
  return scored.sort((a, b) => a.score.localeCompare(b.score)).map((item) => item.value);
}

function pickDistractors(state, entry, correct, fallbacks = []) {
  const key = featureId(entry);
  const own = new Set([
    ...(entry.surfaces?.technologies || []),
    ...(entry.surfaces?.routes || []),
    ...(entry.surfaces?.tables || []),
    ...(entry.story || []).map((step) => step.label)
  ]);
  const project = collectBoundaries(state, key).filter((value) => value !== correct && !own.has(value));
  return [...new Set([...project, ...fallbacks].filter((value) => value && value !== correct))].slice(0, 2);
}

// A diff of bounded observations is not a diff of deployed behavior. In particular,
// a newly detected test tool does not prove a new external runtime dependency.
function driftTarget(entry) {
  const added = entry.lastDrift?.added || {};
  if (added.technologies?.[0]) return { type:'technology reference', value:added.technologies[0] };
  if (added.routes?.[0]) return { type:'route reference', value:added.routes[0] };
  if (added.tables?.[0]) return { type:'data reference', value:added.tables[0] };
  if (added.story?.[0]) return { type:'code or test reference', value:String(added.story[0]).replace(/^[^:]+:/, '') };
  return null;
}

function challengeMaterial(state, entry) {
  const drift = entry.needsRefresh ? driftTarget(entry) : null;
  if (drift) {
    return {
      kind: 'drift-recall',
      prompt: `Which ${drift.type} was newly recorded in IdleProof's model for “${entry.task || 'this feature'}”?`,
      correct: drift.value,
      distractors: pickDistractors(state, entry, drift.value, ['No new reference was recorded', 'Only formatting changed']),
      // Do not re-emit a legacy summary which may assert an unsupported boundary.
      explanation: `The compared feature-model snapshots record ${drift.value} as a new ${drift.type}. This does not establish when it entered the project or how it is used at runtime.`,
      resolvesRefresh: true
    };
  }
  if (entry.surfaces?.technologies?.[0]) {
    const correct = entry.surfaces.technologies[0];
    return {
      kind: 'technology-recall', prompt: `Which technology reference is recorded in IdleProof's model for “${entry.task || 'this feature'}”?`, correct,
      distractors: pickDistractors(state, entry, correct, ['No technology reference recorded', '/assets/app.css']),
      explanation: `${correct} is a technology reference in the stored feature model. Its origin, introduction time and runtime use are not established by this reference alone.`, resolvesRefresh: false
    };
  }
  if (entry.surfaces?.routes?.[0]) {
    const correct = entry.surfaces.routes[0];
    return {
      kind: 'route-recall', prompt: `Which route reference is recorded in IdleProof's model for “${entry.task || 'this feature'}”?`, correct,
      distractors: pickDistractors(state, entry, correct, ['/api/unrelated', '/health']),
      explanation: `${correct} is recorded as a route reference in this feature model; this does not prove that the route is deployed or reachable.`, resolvesRefresh: false
    };
  }
  if (entry.surfaces?.tables?.[0]) {
    const correct = entry.surfaces.tables[0];
    return {
      kind: 'data-recall', prompt: `Which data reference is recorded in IdleProof's model for “${entry.task || 'this feature'}”?`, correct,
      distractors: pickDistractors(state, entry, correct, ['users_archive', 'localStorage']),
      explanation: `${correct} is recorded as a data reference in this feature model; runtime persistence is not established by this reference alone.`, resolvesRefresh: false
    };
  }
  const file = (entry.story || []).find((step) => step.type === 'file' && step.label)?.label;
  if (file) {
    return {
      kind: 'file-recall', prompt: `Which file is part of the mental model for “${entry.task || 'this feature'}”?`, correct:file,
      distractors: pickDistractors(state, entry, file, ['README.md', 'package-lock.json']),
      explanation: `${file} was part of the bounded static feature story you previously learned.`, resolvesRefresh: false
    };
  }
  return null;
}

export function buildFeatureRecallChallenge(state = {}, entry = {}) {
  const key = featureId(entry);
  if (!key) return null;
  const material = challengeMaterial(state, entry);
  if (!material) return null;
  // Version the meaning as well as the answer. A previously displayed misleading
  // question must not award credit after the renderer changes without a refresh.
  const seed = JSON.stringify(['feature-recall-observation-2', key, entry.fingerprint || '',
    material.kind, material.correct, material.prompt, material.explanation, material.resolvesRefresh]);
  const rawOptions = [...new Set([material.correct, ...material.distractors])].slice(0, 3);
  if (rawOptions.length < 2) return null;
  const options = stableShuffle(rawOptions, seed);
  const answer = options.indexOf(material.correct);
  const challengeId = createHash('sha256').update(`${seed}|${options.join('|')}`).digest('hex').slice(0, 24);
  return {
    schema: 'idleproof.feature-recall.v1',
    challengeId,
    featureKey: key,
    kind: material.kind,
    question: material.prompt,
    options,
    answer,
    explanation: material.explanation,
    resolvesRefresh: material.resolvesRefresh
  };
}

export function buildDueFeatureReviews(state = {}, { limit = 8, now = Date.now() } = {}) {
  return Object.values(state.features || {})
    .filter((entry) => featureId(entry) && (entry.exposures || 0) > 0)
    .map((entry) => {
      const confidence = Math.round((entry.confidence || 0) * 100);
      const due = featureReviewDue(entry, now);
      const driftBoost = entry.needsRefresh ? 100 : 0;
      const uncertainty = 100 - confidence;
      const exposureBoost = Math.min(20, (entry.exposures || 0) * 4);
      return {
        featureKey: featureId(entry), task:entry.task || 'Previously learned feature', confidence,
        exposures:entry.exposures || 0, needsRefresh:Boolean(entry.needsRefresh), drift:entry.lastDrift || null,
        lastSeenAt:entry.lastSeenAt || null, due, dueAt:featureReviewDueAt(entry),
        priority: (due ? 40 : 0) + driftBoost + uncertainty + exposureBoost,
        reason: entry.needsRefresh ? 'feature-model observations changed; review the recorded differences' : confidence < 50 ? 'low demonstrated feature fluency' : due ? 'spaced feature recall is due' : 'future spaced feature recall'
      };
    })
    .sort((a, b) => b.priority - a.priority || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))
    .slice(0, limit);
}

export function nextFeatureRecallChallenge(state = {}, now = Date.now()) {
  const due = buildDueFeatureReviews(state, { limit: 20, now }).find((item) => item.due);
  if (!due) return null;
  const entry = Object.values(state.features || {}).find((candidate) => featureId(candidate) === due.featureKey);
  return entry ? buildFeatureRecallChallenge(state, entry) : null;
}

export function scoreStoredFeatureReview(state, challenge, choice) {
  if (!challenge || !Number.isInteger(choice)) throw new Error('Invalid feature review answer.');
  const entry = Object.values(state.features || {}).find((candidate) => featureId(candidate) === challenge.featureKey);
  if (!entry) throw new Error('Feature memory not found.');
  const current = buildFeatureRecallChallenge(state, entry);
  if (!current || current.challengeId !== challenge.challengeId) throw new Error('Feature review changed; refresh before answering.');
  const correct = choice === current.answer;
  entry.checks = (entry.checks || 0) + 1;
  if (correct) {
    entry.correct = (entry.correct || 0) + 1;
    entry.confidence = Math.min(1, (entry.confidence || 0) + ((entry.confidence || 0) < 0.6 ? 0.22 : 0.12));
    if (current.resolvesRefresh) entry.needsRefresh = false;
  } else {
    entry.wrong = (entry.wrong || 0) + 1;
    entry.confidence = Math.max(0, (entry.confidence || 0) - 0.08);
  }
  entry.lastAnsweredAt = new Date().toISOString();
  state.features[featureId(entry)] = entry;
  return { correct, answer:current.answer, explanation:current.explanation, challenge:current, entry };
}
