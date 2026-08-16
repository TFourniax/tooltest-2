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

export function presentLearningCard(card, session = {}) {
  if (!card) return null;
  const depth = learningDepth(session);
  const budget = Number(session.estimatedWindow || card.seconds || 20);
  const target = card.context?.target || '';
  const question = naturalizeQuestion(card.question, target);

  if (depth === 'glance') {
    return {
      ...card,
      question,
      why: compact(card.why, 145),
      lesson: firstSentence(card.lesson),
      seconds: Math.max(5, Math.min(12, budget || 10)),
      presentation: { depth, budgetSeconds: budget, label: 'quick glance' }
    };
  }

  if (depth === 'deep') {
    const review = card.review ? ` Next, ${String(card.review).replace(/^./, (c) => c.toLowerCase())}` : '';
    return {
      ...card,
      question,
      lesson: `${card.lesson}${review}`.trim(),
      seconds: Math.max(Number(card.seconds || 20), Math.min(60, budget || 40)),
      presentation: { depth, budgetSeconds: budget, label: 'deeper pass' }
    };
  }

  if (depth === 'handoff') {
    return {
      ...card,
      question,
      seconds: Math.max(15, Number(card.seconds || 20)),
      presentation: { depth, budgetSeconds: budget, label: 'handoff check' }
    };
  }

  return {
    ...card,
    question,
    seconds: Math.max(10, Math.min(Number(card.seconds || 25), budget || Number(card.seconds || 25))),
    presentation: { depth, budgetSeconds: budget, label: 'quick lesson' }
  };
}
