import { createHash } from 'node:crypto';
import { CONCEPT_BY_ID } from './catalog.mjs';
import { extractTaskSignals } from './context.mjs';
import { buildPlainExplanation } from './explain.mjs';
import { detectLearningPhase, selectLearningCard } from './learning.mjs';
import { taskContextQuery, taskDisplayText } from './task.mjs';

const ELIGIBLE_EVENTS = new Set(['PostToolUse','PostToolUseFailure','Stop','SessionEnd','generic-stop']);

function compact(value='',max=430) {
  const text=String(value||'').replace(/\s+/g,' ').trim();
  if (!text) return '';
  return text.length<=max ? text : `${text.slice(0,max-1).trimEnd()}…`;
}

function deliveryKey(phase, signals={}, session={}) {
  const payload={
    phase,
    taskId:session.task?.id||null,
    taskFocus:session.task?.latestFocusSha256||null,
    file:signals.file||null,
    symbol:signals.symbol||null,
    route:signals.route||null,
    table:signals.table||null,
    dependencies:(signals.dependencies||[]).slice(0,4),
    technologies:(signals.technologies||[]).slice(0,4),
    status:session.status||null,
    diff:phase==='handoff' ? session.proof?.diffSha256||null : null
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0,24);
}

function fileLines(explanation) {
  return (explanation.files||[]).slice(0,3).map((item)=>{
    const detail=item.explanation.replace(/^`[^`]+`\s*/, '').replace(/IdleProof/gi,'').trim();
    return `• ${item.path} — ${compact(detail,210)}`;
  });
}

function userMessage(explanation, phase, session) {
  const handoff=phase==='handoff';
  const lines=[
    `IdleProof · ${handoff?'task handoff':'what this means in your project'}${session?.task?.id ? ` · ${session.task.id}` : ''}`,
    compact(explanation.doing,480),
    ...fileLines(explanation),
    `Why it matters: ${compact(explanation.why,420)}`
  ];
  if (explanation.watch?.[0]) lines.push(`Keep in mind: ${compact(explanation.watch[0],360)}`);
  if (handoff) lines.push('This explains the observed change; it does not claim the code is correct. Use tests/DiffWitness for proof.');
  lines.push('Open the local IdleProof cockpit for the current feature map. Understanding checks are optional.');
  return lines.filter(Boolean).join('\n');
}

function conceptFor(state,session) {
  const ids=Object.keys(session.concepts||{}).filter((id)=>CONCEPT_BY_ID[id]);
  if (!ids.length) return null;
  const id=selectLearningCard(state,session,ids[0]);
  return CONCEPT_BY_ID[id]||null;
}

export function buildHookDelivery(cwd,state,session,eventName) {
  if (!ELIGIBLE_EVENTS.has(eventName) || !session) return null;
  // Relevance uses the stable task plus its current substantive focus. Human-facing copy stays
  // anchored to the primary objective so a turn such as "yes, continue" never becomes the task.
  const semanticSession={...session,prompt:taskContextQuery(session)};
  const signals=extractTaskSignals(cwd,semanticSession);
  const phase=detectLearningPhase({...semanticSession,taskSignals:signals});
  if (phase!=='handoff' && !signals.file) return null;
  const enriched={...semanticSession,prompt:taskDisplayText(session),taskSignals:signals};
  const concept=conceptFor(state,enriched);
  const explanation=buildPlainExplanation({session:enriched,concept,phase});
  const key=deliveryKey(phase,signals,session);
  if (key===session.lastSurfacedExplanationKey) return null;
  return {key,message:userMessage(explanation,phase,session),explanation,signals,phase};
}
