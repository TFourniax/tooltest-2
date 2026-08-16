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
  return files.length ? files[files.length - 1] : (session?.currentResource || null);
}

function minutesSince(iso) {
  if (!iso) return Infinity;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? Math.max(0, (Date.now() - value) / 60000) : Infinity;
}

export function summarizeTask(prompt = '', max = 118) {
  return compact(prompt, max);
}

export function detectLearningPhase(session = {}) {
  if (session.status === 'complete') return 'handoff';
  const tool = String(session.currentTool || '');
  const capabilities = new Set(session.currentCapabilities || []);
  const recent = (session.events || []).slice(-4);
  if (recent.some((event) => event.failed) || /failed/i.test(tool)) return 'recover';
  if (capabilities.has('test.execute') || capabilities.has('build.execute')) return 'verify';
  if ([...capabilities].some((capability) => ['code.modify', 'database.mutate', 'database.destructive', 'database.migration', 'ci.modify', 'secrets.write', 'dependency.install'].includes(capability))) return 'implement';
  if ([...capabilities].some((capability) => ['code.read', 'scm.read', 'database.read'].includes(capability))) return 'inspect';
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

const APPLIED_QUIZZES = {
  auth: {
    implement: ['Where must the permission check still happen for this protected action?', ['On the server before the action runs', 'Only in the visible UI', 'Only after the response is sent']],
    verify: ['Which test gives the strongest authorization evidence for this change?', ['An authenticated user without the required role is rejected', 'The login page renders', 'The button has the expected color']],
    handoff: ['A logged-in user without the required role reaches this protected route. What should happen?', ['The server rejects the action', 'The client hides the button but the server allows it', 'The request succeeds because authentication already passed']]
  },
  sql: {
    implement: ['How should user-controlled values enter this SQL operation?', ['As parameterized values', 'By string concatenation', 'After HTML escaping']],
    verify: ['If the second write fails inside this operation, what should a transaction guarantee?', ['The related writes roll back together', 'The first write always remains', 'The database retries forever']],
    handoff: ['What is the most important boundary to re-check before accepting this data change?', ['Atomicity, constraints, and parameterized inputs', 'Whether SQL keywords are uppercase', 'Whether the table name is short']]
  },
  migration: {
    implement: ['What makes this migration safer during a rolling deployment?', ['Old and new application versions can coexist with the schema', 'It drops old columns immediately', 'It requires no rollback plan']],
    verify: ['What failure should you simulate before trusting this migration?', ['A rollback or old-version app against the migrated schema', 'A CSS build warning', 'A renamed local branch']],
    handoff: ['Before accepting this schema change, what should still be true?', ['The deploy can fail or roll back without corrupting existing data', 'Every column is nullable', 'The migration is only one line']]
  },
  async: {
    implement: ['What should you check first in this async path?', ['Every required promise is awaited or intentionally supervised', 'Every function uses setTimeout', 'All work is forced to be sequential']],
    verify: ['Which test is most valuable for this async change?', ['Overlapping or failing operations do not leave inconsistent state', 'The function name contains async', 'The request works once on a fast machine']],
    handoff: ['What hidden failure remains plausible even if the happy path passed once?', ['A race, forgotten await, or unobserved rejection', 'A missing semicolon changes HTTP semantics', 'The browser changes TypeScript types']]
  },
  'react-state': {
    implement: ['What is the best reason for an effect in this component?', ['Synchronizing React with an external system', 'Recomputing every derived value', 'Replacing normal event handlers']],
    verify: ['Which regression is most worth checking for this state/effect change?', ['Stale state, duplicate effects, or an update loop', 'A different variable name', 'A smaller source map']],
    handoff: ['Before accepting this React change, what should you question?', ['Whether each effect is truly needed and state has one source of truth', 'Whether every value is stored in state', 'Whether effects run during render']]
  },
  typescript: {
    implement: ['Where should runtime validation happen in this typed change?', ['Where external or persisted data enters the trusted code path', 'Only inside type aliases', 'Nowhere when strict mode is enabled']],
    verify: ['What test can expose a false TypeScript assumption?', ['Feed malformed runtime data across the external boundary', 'Rename an interface', 'Disable the network']],
    handoff: ['What should you remember before trusting these new types?', ['Compile-time types do not validate runtime input by themselves', 'Interfaces are runtime validators', 'A type assertion proves the payload shape']]
  },
  testing: {
    implement: ['What should the new test prove about this task?', ['An observable behavior or invariant that could genuinely regress', 'The implementation uses the same variable names', 'The agent followed the prompt wording']],
    verify: ['Which passing test is most convincing?', ['One that would fail for a plausible wrong implementation', 'One copied directly from the implementation', 'One with the most assertions']],
    handoff: ['Before accepting green tests, what question matters most?', ['Would these tests catch a subtly wrong implementation?', 'Did every file get a snapshot?', 'Are all test names long?']]
  },
  secrets: {
    implement: ['Where may this credential safely exist?', ['In a server-side secret store or protected environment', 'In browser-delivered JavaScript', 'In a committed example value']],
    verify: ['What should you inspect after this configuration change?', ['Bundles, logs, errors, and committed files for secret exposure', 'Only the CSS output', 'Only package-lock.json']],
    handoff: ['What is the safest assumption about code sent to the browser?', ['It cannot keep a secret', 'Minification makes secrets private', 'Environment variable names hide their values']]
  },
  http: {
    implement: ['What property matters if this write request can be retried?', ['Idempotency', 'Font weight', 'Source-map size']],
    verify: ['Which API behavior deserves an explicit test here?', ['Invalid input plus a retry/duplicate request path', 'Only a 200 happy path', 'The route filename']],
    handoff: ['What makes this endpoint a complete contract rather than just working JSON?', ['Validation, authorization, status/error semantics, and retry behavior', 'A short URL', 'A GET request for every operation']]
  },
  packages: {
    implement: ['Before keeping this new dependency, what should you ask?', ['Does the repo or platform already solve this without another package?', 'Does it add many transitive packages?', 'Is its name short?']],
    verify: ['What is worth validating after adding this package?', ['Lockfile impact, maintenance status, API use, and whether it is actually needed', 'Only that npm install exits zero', 'Only its README logo']],
    handoff: ['What debt does even a tiny dependency add?', ['Maintenance and supply-chain surface', 'Guaranteed performance', 'Fewer future upgrades']]
  },
  git: {
    implement: ['What makes this agent-authored change easier to trust?', ['A small coherent scope with unrelated files excluded', 'A single huge commit', 'Rewriting history after every tool call']],
    verify: ['What should you inspect before accepting the change boundary?', ['Whether unrelated files or scope creep slipped into the diff', 'Only the commit message', 'Only the branch name']],
    handoff: ['Why is a coherent change boundary especially useful with coding agents?', ['It is easier to review, revert, and explain', 'It removes the need for tests', 'It makes the agent slower']]
  },
  ci: {
    implement: ['What principle should these workflow credentials follow?', ['Least privilege', 'Repository-wide write by default', 'Maximum convenience']],
    verify: ['What should you verify beyond whether the workflow YAML parses?', ['Triggers, permissions, secret exposure, action pinning, and rollback', 'Only indentation', 'Only job names']],
    handoff: ['Why should this CI change receive extra scrutiny?', ['It changes executable policy for what can reach production', 'YAML is always unsafe', 'CI files cannot be tested']]
  },
  concurrency: {
    implement: ['What must protect the shared resource in this concurrent path?', ['An invariant enforced atomically at the ownership boundary', 'A longer timeout', 'A comment saying do not race']],
    verify: ['Which test is most likely to expose this class of bug?', ['Concurrent attempts at the same state transition', 'One sequential request', 'A type-only build']],
    handoff: ['What makes a race condition dangerous even after tests pass once?', ['Correctness depends on timing and interleaving', 'It only happens in CSS', 'It cannot affect databases']]
  },
  accessibility: {
    implement: ['What should you prefer for this interactive control?', ['A native semantic element when one exists', 'A clickable div plus many handlers', 'ARIA instead of HTML semantics']],
    verify: ['How should you quickly test this interaction?', ['Use it with keyboard navigation and visible focus', 'Only resize the browser', 'Turn off JavaScript comments']],
    handoff: ['What does a visually correct interaction still not prove?', ['That keyboard and assistive-technology users can operate it', 'That the CSS compiled', 'That the mouse pointer works']]
  },
  cache: {
    implement: ['What must be explicit for this cached value?', ['Key, freshness policy, invalidation rule, and failure behavior', 'Only a long TTL', 'Only JSON serialization']],
    verify: ['Which behavior is most important to test for this cache?', ['Readers observe fresh data after the source of truth changes', 'The first cache hit is fast', 'The key contains no spaces']],
    handoff: ['What is the core correctness risk of this cache?', ['It can become a stale second copy of truth', 'It always increases database writes', 'It removes network latency entirely']]
  }
};

function appliedQuiz(concept, phase) {
  const group = APPLIED_QUIZZES[concept.id];
  const selected = group?.[phase];
  if (!selected) return null;
  return { question: selected[0], options: selected[1], answer: 0, kind: 'applied' };
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

function challengeId(session, concept, phase, file, question) {
  const raw = [session?.id, concept.id, phase, file, question, session?.currentTool, ...(session?.currentCapabilities || []), session?.lastEventAt].filter(Boolean).join('|');
  return createHash('sha256').update(raw || concept.id).digest('hex').slice(0, 20);
}

export function nextReviewMinutes(confidence = 0) {
  if (confidence < 0.35) return 5;
  if (confidence < 0.65) return 30;
  if (confidence < 0.85) return 360;
  return 1440;
}

export function isReviewDue(entry = {}) {
  if (!entry.lastAnsweredAt) return true;
  return minutesSince(entry.lastAnsweredAt) >= nextReviewMinutes(entry.confidence || 0);
}

export function selectLearningCard(state = {}, session = {}, fallbackId = 'testing') {
  const sessionIds = Object.keys(session?.concepts || {}).filter((id) => CONCEPT_BY_ID[id]);
  const pool = sessionIds.length
    ? sessionIds
    : Object.keys(state.ledger || {}).filter((id) => CONCEPT_BY_ID[id] && state.ledger[id]?.exposures > 0);
  if (!pool.length) return fallbackId;

  const scored = pool.map((id) => {
    const concept = CONCEPT_BY_ID[id];
    const entry = state.ledger?.[id] || {};
    const inTask = Boolean(session?.concepts?.[id]);
    const eventCount = session?.concepts?.[id]?.events || 0;
    const uncertainty = 1 - (entry.confidence || 0);
    const due = isReviewDue(entry);
    const answeredAgo = minutesSince(entry.lastAnsweredAt);
    const repetitionPenalty = answeredAgo < 2 ? 8 : answeredAgo < 10 ? 3 : 0;
    const score = concept.risk * (1 + uncertainty * 2) + (inTask ? 8 : 0) + Math.min(4, eventCount) + (due ? 2 : -2) - repetitionPenalty;
    return { id, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.id || fallbackId;
}

export function buildContextualCard(concept, state = {}, session = {}) {
  if (!concept) return null;
  const phase = detectLearningPhase(session);
  const file = latestTouchedFile(session);
  const task = summarizeTask(session.prompt);
  const ledger = state.ledger?.[concept.id] || {};
  const lead = phaseLead(phase, file);
  const quiz = appliedQuiz(concept, phase) || { question: concept.question, options: concept.options, answer: concept.answer, kind: 'concept' };
  const taskCue = task ? ` For “${summarizeTask(task, 72)}”,` : '';
  const question = `${lead}:${taskCue} ${lowerFirst(quiz.question)}`;
  return {
    ...concept,
    question,
    options: quiz.options,
    answer: quiz.answer,
    why: taskConnection(concept, task, phase, file),
    lesson: `${concept.lesson} Apply it here: ${applicationPrompt(concept, phase, file)}`,
    review: `${concept.review}${file ? ` Apply that review directly to ${file}.` : ''}`,
    confidence: Math.round((ledger.confidence || 0) * 100),
    exposures: ledger.exposures || 0,
    reviewDue: isReviewDue(ledger),
    nextReviewMinutes: nextReviewMinutes(ledger.confidence || 0),
    challengeId: challengeId(session, concept, phase, file, question),
    kind: quiz.kind,
    context: {
      task,
      phase,
      file,
      tool: session.currentTool || null,
      capabilities: session.currentCapabilities || [],
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
    reviewDue: isReviewDue(ledger),
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

export function buildLearningExperience(state = {}, session = {}, fallbackId = 'testing') {
  const cardId = selectLearningCard(state, session, fallbackId);
  const concept = CONCEPT_BY_ID[cardId] || CONCEPT_BY_ID.testing;
  const journey = buildLearningJourney(state, session);
  return {
    ...journey,
    selectedConceptId: cardId,
    card: buildContextualCard(concept, state, session)
  };
}
