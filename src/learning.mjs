import { createHash } from 'node:crypto';
import { CONCEPT_BY_ID } from './catalog.mjs';

function compact(value = '', max = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function lowerFirst(value = '') {
  return value ? `${value[0].toLowerCase()}${value.slice(1)}` : '';
}

function latestTouchedFile(session) {
  const files = session?.touchedFiles || [];
  return files.length ? files[files.length - 1] : null;
}

export function summarizeTask(prompt = '', max = 118) {
  return compact(prompt, max);
}

export function detectLearningPhase(session = {}) {
  if (session.status === 'complete') return 'handoff';
  const tool = String(session.currentTool || '');
  const recent = (session.events || []).slice(-4);
  if (recent.some((event) => event.failed) || /failed/i.test(tool)) return 'recover';
  if (/test|vitest|jest|pytest|playwright|cypress|build|compile/i.test(tool)) return 'verify';
  if (/read|grep|glob|search/i.test(tool)) return 'inspect';
  if (/write|edit|multiedit|apply_patch|notebookedit/i.test(tool)) return 'implement';
  if (/thinking/i.test(tool)) return (session.touchedFiles || []).length ? 'reason' : 'plan';
  return session.status === 'active' ? 'work' : 'idle';
}

function phaseLead(phase, file) {
  const where = file ? ` in ${file}` : '';
  if (phase === 'inspect') return `While the agent inspects the code${where}`;
  if (phase === 'implement') return `While the agent changes the code${where}`;
  if (phase === 'verify') return `While the agent verifies the change${where}`;
  if (phase === 'recover') return `While the agent recovers from a failure${where}`;
  if (phase === 'handoff') return `Before you accept the finished change${where}`;
  if (phase === 'reason') return `While the agent reasons about the next step${where}`;
  if (phase === 'plan') return 'Before the agent commits to an implementation';
  return file ? `For the code being touched in ${file}` : 'For the current task';
}

function taskConnection(concept, task, phase, file) {
  const anchor = task ? `“${task}”` : 'the current task';
  const location = file ? ` The latest observed file is ${file}.` : '';
  const action = phase === 'handoff'
    ? 'You are at the handoff boundary, so this is the moment to verify you understand the important behavior before accepting it.'
    : 'IdleProof selected this because the agent activity exposes this concept right now.';
  return `${action} The task is ${anchor}.${location} ${concept.why}`;
}

function applicationPrompt(concept, phase, file) {
  const target = file ? `Open ${file}` : 'Look at the agent’s current change';
  if (phase === 'handoff') return `${target} before accepting the turn and ${lowerFirst(concept.review)}`;
  if (phase === 'verify') return `${target} and predict which failure or invariant the current verification should catch.`;
  return `${target} when the agent pauses and ${lowerFirst(concept.review)}`;
}

function challengeId(session, concept, phase, file) {
  const raw = [session?.id, concept.id, phase, file, session?.currentTool, session?.lastEventAt].filter(Boolean).join('|');
  return createHash('sha256').update(raw || concept.id).digest('hex').slice(0, 20);
}

export function buildContextualCard(concept, state = {}, session = {}) {
  if (!concept) return null;
  const phase = detectLearningPhase(session);
  const file = latestTouchedFile(session);
  const task = summarizeTask(session.prompt);
  const ledger = state.ledger?.[concept.id] || {};
  const lead = phaseLead(phase, file);
  return {
    ...concept,
    question: `${lead}: ${lowerFirst(concept.question)}`,
    why: taskConnection(concept, task, phase, file),
    lesson: `${concept.lesson} Apply it here: ${applicationPrompt(concept, phase, file)}`,
    review: `${concept.review}${file ? ` Apply that review directly to ${file}.` : ''}`,
    confidence: Math.round((ledger.confidence || 0) * 100),
    exposures: ledger.exposures || 0,
    challengeId: challengeId(session, concept, phase, file),
    context: {
      task,
      phase,
      file,
      tool: session.currentTool || null,
      source: session.source || 'agent'
    }
  };
}

function conceptProgress(state, session, id) {
  const concept = CONCEPT_BY_ID[id];
  if (!concept) return null;
  const ledger = state.ledger?.[id] || {};
  const sessionDetail = session?.concepts?.[id] || {};
  const confidence = Math.round((ledger.confidence || 0) * 100);
  const status = confidence >= 80 ? 'mastered' : confidence >= 45 ? 'building' : 'learn-now';
  const score = concept.risk * (1 - (ledger.confidence || 0)) + Math.min(4, sessionDetail.events || 0) * 0.35;
  return {
    id,
    title: concept.title,
    risk: concept.risk,
    level: concept.level,
    confidence,
    exposures: ledger.exposures || 0,
    events: sessionDetail.events || 0,
    status,
    score: Math.round(score * 100) / 100
  };
}

export function buildLearningJourney(state = {}, session = {}) {
  const ids = Object.keys(session?.concepts || {});
  const journey = ids.map((id) => conceptProgress(state, session, id)).filter(Boolean)
    .sort((a, b) => b.score - a.score || b.risk - a.risk);
  const mastered = journey.filter((item) => item.status === 'mastered');
  const building = journey.filter((item) => item.status === 'building');
  const learnNow = journey.filter((item) => item.status === 'learn-now');
  return {
    phase: detectLearningPhase(session),
    task: summarizeTask(session?.prompt),
    file: latestTouchedFile(session),
    concepts: journey,
    recap: {
      touched: journey.length,
      mastered: mastered.length,
      building: building.length,
      review: learnNow.length,
      strongest: mastered[0]?.title || building[0]?.title || null,
      weakest: learnNow[0]?.title || building.at(-1)?.title || null
    }
  };
}

export function buildLearningExperience(state = {}, session = {}, cardId = 'testing') {
  const concept = CONCEPT_BY_ID[cardId] || CONCEPT_BY_ID.testing;
  const journey = buildLearningJourney(state, session);
  return {
    ...journey,
    card: buildContextualCard(concept, state, session)
  };
}
