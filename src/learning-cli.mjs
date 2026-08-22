import { extractTaskSignals } from './context.mjs';
import { cachedFeatureModel, findFeatureMemory, previewFeatureDrift } from './feature-memory.mjs';
import { nextFeatureRecallChallenge, scoreStoredFeatureReview } from './feature-review.mjs';
import { buildProjectModel } from './project-model.mjs';
import { computeMetrics, loadState, mutateState } from './state.mjs';

function latestSession(state) {
  return Object.values(state.sessions || {}).sort((a,b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))[0] || null;
}

function currentModel(cwd, state, session) {
  if (!session) return null;
  const enriched = { ...session, taskSignals:extractTaskSignals(cwd, session) };
  const model = cachedFeatureModel(cwd, enriched);
  if (!model.generatedFrom?.filesInspected) return null;
  return { model, memory:findFeatureMemory(state, model), drift:previewFeatureDrift(state, model), session:enriched };
}

function safeChallenge(challenge) {
  if (!challenge) return null;
  return { challengeId:challenge.challengeId, featureKey:challenge.featureKey, kind:challenge.kind, question:challenge.question, options:challenge.options };
}

function modelJson(cwd) {
  const state = loadState(cwd);
  const session = latestSession(state);
  const current = currentModel(cwd, state, session);
  const project = buildProjectModel(state, current?.session || session || {}, current?.model || null);
  return {
    project:state.project,
    metrics:computeMetrics(state),
    currentFeature:current ? {
      featureKey:current.model.featureKey,
      fingerprint:current.model.fingerprint,
      story:current.model.story,
      surfaces:current.model.surfaces,
      fluency:Math.round((current.memory?.confidence || 0) * 100),
      needsRefresh:Boolean(current.drift || current.memory?.needsRefresh),
      drift:current.drift || current.memory?.lastDrift || null,
      disclaimer:current.model.disclaimer
    } : null,
    impact:project.impact,
    hotspots:project.topology.hotspots,
    sharedBoundaries:project.topology.sharedBoundaries,
    reviewQueue:project.reviewQueue,
    nextReview:project.reviewChallenge
  };
}

function printMentalModel(data) {
  const metrics = data.metrics;
  console.log(`IdleProof mental model · ${data.project}`);
  console.log(`Feature fluency ${metrics.featureCoverage}% · ${metrics.featuresSeen} learned feature${metrics.featuresSeen === 1 ? '' : 's'} · feature debt ${metrics.featureDebt}`);
  if (data.currentFeature) {
    console.log(`\nCurrent feature · ${data.currentFeature.fluency}% fluent${data.currentFeature.needsRefresh ? ' · REVIEW NEEDED' : ''}`);
    const story = (data.currentFeature.story || []).map((step) => step.label).join(' → ');
    if (story) console.log(`  ${story}`);
    if (data.currentFeature.drift?.summary) console.log(`  Drift: ${data.currentFeature.drift.summary}`);
  }
  if (data.impact?.otherFeatures?.length) {
    console.log(`\nChange impact · ${data.impact.blastRadius} other learned feature${data.impact.blastRadius === 1 ? '' : 's'}`);
    for (const item of data.impact.otherFeatures.slice(0, 5)) console.log(`  - ${item.task} · ${item.confidence}% fluent · via ${item.sharedFiles.map((file) => file.file).join(', ')}`);
  }
  if (data.hotspots?.length) {
    console.log('\nShared hotspots');
    for (const item of data.hotspots.slice(0, 5)) console.log(`  - ${item.file} · ${item.featureCount} features · ${item.averageFluency}% avg fluency`);
  }
  const due = (data.reviewQueue || []).filter((item) => item.due);
  if (due.length) {
    console.log(`\nReviews due · ${due.length}`);
    for (const item of due.slice(0, 5)) console.log(`  - ${item.task} · ${item.confidence}% · ${item.reason}`);
  }
}

function printChallenge(challenge) {
  console.log(`Feature review · ${challenge.kind}`);
  console.log(challenge.question);
  challenge.options.forEach((option, index) => console.log(`  ${index + 1}. ${option}`));
  console.log('\nAnswer with: idleproof review --answer <number>');
}

export function learningCliHelp() {
  return `\nMental model:\n  idleproof mental-model [--json]\n  idleproof review [--json]\n  idleproof review --answer N`;
}

export async function runLearningCli(args = [], { cwd = process.cwd() } = {}) {
  const cmd = args[0];
  if (cmd === 'mental-model') {
    const data = modelJson(cwd);
    if (args.includes('--json')) console.log(JSON.stringify(data, null, 2));
    else printMentalModel(data);
    return true;
  }
  if (cmd !== 'review') return false;

  if (args.includes('--answer')) {
    const index = args.indexOf('--answer');
    const humanChoice = Number(args[index + 1]);
    if (!Number.isInteger(humanChoice) || humanChoice < 1) throw new Error('Usage: idleproof review --answer <number>');
    let result = null;
    mutateState(cwd, (state) => {
      const challenge = nextFeatureRecallChallenge(state);
      if (!challenge) throw new Error('No feature review is currently due.');
      if (humanChoice > challenge.options.length) throw new Error(`Answer must be between 1 and ${challenge.options.length}.`);
      result = scoreStoredFeatureReview(state, challenge, humanChoice - 1);
      return state;
    });
    const metrics = computeMetrics(loadState(cwd));
    if (args.includes('--json')) console.log(JSON.stringify({ correct:result.correct, answer:result.answer + 1, explanation:result.explanation, metrics }, null, 2));
    else {
      console.log(`${result.correct ? '✓ Correct' : '✗ Not quite'} · ${result.explanation}`);
      console.log(`Feature fluency ${metrics.featureCoverage}% · feature debt ${metrics.featureDebt}`);
    }
    return true;
  }

  const state = loadState(cwd);
  const challenge = nextFeatureRecallChallenge(state);
  if (args.includes('--json')) console.log(JSON.stringify({ challenge:safeChallenge(challenge), metrics:computeMetrics(state) }, null, 2));
  else if (!challenge) console.log('✓ No feature review is currently due. Keep building.');
  else printChallenge(challenge);
  return true;
}
