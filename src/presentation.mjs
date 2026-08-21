import { buildPlainExplanation } from './explain.mjs';

function compact(value = '', max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function firstSentence(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/^(.+?[.!?])(?:\s|$)/);
  return match ? match[1] : compact(text, 160);
}

export function learningDepth(session = {}) {
  if (session.status === 'complete') return 'handoff';
  const seconds = Number(session.estimatedWindow || 0);
  if (seconds > 0 && seconds <= 12) return 'glance';
  if (seconds > 35) return 'deep';
  return 'quick';
}

function naturalizeQuestion(question = '', target = '') {
  if (!target) return question;
  return String(question)
    .replace(`While the agent changes the code in ${target}:`, `While the agent changes ${target}:`)
    .replace(`While the agent inspects the code in ${target}:`, `While the agent inspects ${target}:`)
    .replace(`While the agent verifies the change in ${target}:`, `While the agent verifies ${target}:`)
    .replace(`Before you accept the finished change in ${target}:`, `Before you accept the finished change around ${target}:`)
    .replace(`While the agent recovers from a failure in ${target}:`, `While the agent recovers around ${target}:`);
}

function subjectFrom(signals = {}) {
  return signals.symbol || signals.route || signals.table || null;
}

function specializedQuestion(card, fallback) {
  const signals = card.context?.signals || {};
  const phase = card.context?.phase || 'work';
  const subject = subjectFrom(signals);
  const route = signals.route || null;
  const table = signals.table || null;
  const technologies = new Set(signals.technologies || []);

  if (card.id === 'http' && (technologies.has('Stripe') || /webhooks?/i.test(route || ''))) {
    const webhook = route || subject || 'this webhook';
    const handler = signals.symbol ? ` in ${signals.symbol}` : '';
    if (phase === 'implement') return `If Stripe retries ${webhook}${handler}, what property must this handler preserve?`;
    if (phase === 'verify') return `For ${webhook}${handler}, which behavior most needs an explicit retry or duplicate-delivery test?`;
    if (phase === 'handoff') return `Before accepting ${webhook}${handler}, what part of the API contract must still cover duplicate delivery and failure semantics?`;
  }

  if (card.id === 'auth' && (technologies.has('OAuth') || technologies.has('OpenID Connect'))) {
    const target = subject ? ` in ${subject}` : '';
    if (phase === 'implement') return `After OAuth identifies the user${target}, where must the permission check for the protected action still happen?`;
    if (phase === 'verify') return `For this OAuth flow${target}, which test best proves authentication did not accidentally become authorization?`;
    if (phase === 'handoff') return `Before accepting this OAuth change${target}, what should happen to a logged-in user who lacks the required role?`;
  }

  if (card.id === 'migration' && table) {
    if (phase === 'implement') return `For the migration touching ${table}, what makes deployment safer while old and new application versions may overlap?`;
    if (phase === 'verify') return `Before trusting the migration touching ${table}, which rollback or compatibility failure is most worth simulating?`;
    if (phase === 'handoff') return `Before accepting the schema change on ${table}, what must still be true if deploy or rollback fails halfway through?`;
  }

  if (card.id === 'secrets' && technologies.size) {
    const stack = [...technologies].slice(0, 2).join(' / ');
    if (phase === 'implement') return `For the ${stack} credential used by this task, where may the secret safely exist?`;
    if (phase === 'verify') return `After this ${stack} configuration change, where should you check for accidental secret exposure?`;
  }

  if (card.id === 'concurrency') {
    const target = subject ? ` in ${subject}` : '';
    if (phase === 'implement') return `For the shared state${target}, what must make the critical state transition atomic under concurrent attempts?`;
    if (phase === 'verify') return `Which concurrent or race-condition test should challenge the same state transition${target} at nearly the same time?`;
    if (phase === 'handoff') return `Before accepting this concurrent-state change${target}, what timing or interleaving failure could still violate the invariant?`;
  }

  return fallback;
}

function explanationSession(card, session) {
  const file = card.context?.file || session.currentResource || null;
  return {
    ...session,
    prompt:card.context?.task || session.prompt || '',
    currentResource:file,
    touchedFiles:(session.touchedFiles?.length ? session.touchedFiles : [file]).filter(Boolean),
    taskSignals:card.context?.signals || session.taskSignals || null
  };
}

function explanationLesson(explanation, depth) {
  if (!explanation) return '';
  const watch = explanation.watch?.length ? ` What to keep in mind: ${explanation.watch.join(' ')}` : '';
  if (depth === 'glance') return compact(`${explanation.project} ${explanation.why}`, 360);
  if (depth === 'quick') return `${explanation.project} ${explanation.why}${watch}`.trim();
  return `${explanation.project} ${explanation.why} ${explanation.expectedOutcome}${watch}`.trim();
}

export function presentLearningCard(card, session = {}) {
  if (!card) return null;
  const depth = learningDepth(session);
  const budget = Number(session.estimatedWindow || card.seconds || 20);
  const target = card.context?.target || '';
  const naturalQuestion = naturalizeQuestion(card.question, target);
  const question = specializedQuestion(card, naturalQuestion);
  const specialized = question !== naturalQuestion;
  const explanation = buildPlainExplanation({
    session:explanationSession(card, session),
    concept:card,
    phase:card.context?.phase || (session.status === 'complete' ? 'handoff' : 'work')
  });
  const explainWhy = explanation?.doing || card.why;
  const explainLesson = explanationLesson(explanation, depth) || card.lesson;

  if (depth === 'glance') {
    return {
      ...card,
      question,
      why:compact(explainWhy, 145),
      lesson:explainLesson,
      explanation,
      seconds:Math.max(5, Math.min(12, budget || 10)),
      presentation:{ depth, budgetSeconds:budget, label:'quick explanation', specialized, explainFirst:true, checkOptional:true }
    };
  }

  if (depth === 'deep') {
    return {
      ...card,
      question,
      why:explainWhy,
      lesson:explainLesson,
      explanation,
      seconds:Math.max(Number(card.seconds || 20), Math.min(60, budget || 40)),
      presentation:{ depth, budgetSeconds:budget, label:'deeper explanation', specialized, explainFirst:true, checkOptional:true }
    };
  }

  if (depth === 'handoff') {
    return {
      ...card,
      question,
      why:explainWhy,
      lesson:explainLesson,
      explanation,
      seconds:Math.max(15, Number(card.seconds || 20)),
      presentation:{ depth, budgetSeconds:budget, label:'handoff explanation', specialized, explainFirst:true, checkOptional:true }
    };
  }

  return {
    ...card,
    question,
    why:explainWhy,
    lesson:explainLesson,
    explanation,
    seconds:Math.max(10, Math.min(Number(card.seconds || 25), budget || Number(card.seconds || 25))),
    presentation:{ depth, budgetSeconds:budget, label:'plain-language explanation', specialized, explainFirst:true, checkOptional:true }
  };
}
