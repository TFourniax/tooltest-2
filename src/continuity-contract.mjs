// Admission of advisory Core context. This is not certificate verification.
export const MAX_CONTEXT_BYTES = 256 * 1024;
const STATUS = new Set(['DECLARED','INFERRED','OBSERVED','VERIFIED']);
const CLAIMS = new Set(['causal','preservation','validation','not-required','inconclusive','unknown']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max=4096) => typeof value === 'string' && value.length <= max;
const identity = value => text(value,512) && value.length>0 && !/[\s\x00-\x1f\x7f]/u.test(value);
const status = value => STATUS.has(value);
const nullableText = (value,max) => value === null || text(value,max);
const array = (value,validate,max=128) => Array.isArray(value) && value.length<=max && value.every(validate);
const matches = (value,pattern) => typeof value === 'string' && pattern.test(value);
const hash = (value,pattern) => value === null || matches(value,pattern);
const integer = value => Number.isSafeInteger(value) && value>=0;

function source(value) {
  if (value === undefined) return true; // Legacy contexts are explicitly uncited.
  return object(value) && Object.keys(value).sort().join('|')==='eventHash|eventId|kind'
    && value.kind==='project-event' && matches(value.eventId,/^dwev_[a-f0-9]{24}$/)
    && matches(value.eventHash,/^[a-f0-9]{64}$/);
}

function lifecycle(value) {
  if (value === undefined) return true; // Compatible with older Core contexts.
  if (!object(value)) return false;
  if (!Object.keys(value).length) return true;
  return value.action==='confirmed' && value.active===true && value.epistemicStatus==='DECLARED'
    && text(value.reason,4096) && value.reason.trim().length>0
    && matches(value.sourceEventId,/^dwev_[a-f0-9]{24}$/) && matches(value.assertionEventId,/^dwev_[a-f0-9]{24}$/)
    && value.sourceEventId!==value.assertionEventId
    && text(value.updatedAt,80) && value.replacementId===null && value.replacementEventId===null;
}

function entity(value,kind) {
  return object(value) && identity(value.id) && value.kind===kind && nullableText(value.label,2000)
    && status(value.epistemicStatus) && object(value.details) && lifecycle(value.lifecycle) && source(value.source)
    && !(kind==='task' && value.lifecycle?.action==='confirmed')
    && !(value.source && value.lifecycle?.action==='confirmed' && value.lifecycle.assertionEventId!==value.source.eventId);
}

function boundedJson(value) {
  const stack=[[value,0]]; const seen=new Set(); let count=0;
  while (stack.length) {
    const [item,depth]=stack.pop();
    if (++count>20000 || depth>24) return false;
    if (item!==null && typeof item==='object') {
      if (seen.has(item)) return false;
      seen.add(item);
      for (const child of Object.values(item)) stack.push([child,depth+1]);
    } else if (!['string','boolean','number'].includes(typeof item) && item!==null || typeof item==='number' && !Number.isFinite(item)) return false;
  }
  return Buffer.byteLength(JSON.stringify(value),'utf8')<=MAX_CONTEXT_BYTES;
}

function change(value) {
  if (!object(value) || !matches(value.changeId,/^dwchg_[a-f0-9]{24}$/) || !array(value.files,x=>text(x,4096),20)) return false;
  if (value.proof!==null && !(object(value.proof) && CLAIMS.has(value.proof.claim)
    && typeof value.proof.accepted==='boolean' && status(value.proof.epistemicStatus))) return false;
  if (value.softwareDebt!==null && !(object(value.softwareDebt) && integer(value.softwareDebt.points)
    && integer(value.softwareDebt.obligations) && [true,false,null].includes(value.softwareDebt.budgetPassed))) return false;
  return true;
}

export function validContext(value,{expectedTask}={}) {
  try {
    if (!object(value) || !boundedJson(value) || value.schema_version!=='continuity-context-1'
      || !matches(value.context_id,/^dwctx_[a-f0-9]{24}$/) || !text(value.generated_at,80)
      || !object(value.project) || !text(value.project.name,512) || !matches(value.project.fingerprint,/^dwrepo_[a-f0-9]{24}$/)
      || !text(value.task,16000) || expectedTask!==undefined && value.task!==expectedTask
      || !object(value.state) || !hash(value.state.eventHead,/^[a-f0-9]{64}$/)
      || !hash(value.state.structureTree,/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      || !object(value.trustBoundary) || value.trustBoundary.contextIsAdvisory!==true || value.trustBoundary.proofRemainsAuthoritative!==true) return false;
    for (const [key,kind] of [['objectives','objective'],['decisions','decision'],['invariants','invariant'],['failedApproaches','failed-approach'],['tasks','task']]) {
      if (key==='tasks' && value[key]===undefined) continue; // Additive PM-002 field.
      if (!array(value[key],item=>entity(item,kind))) return false;
    }
    return array(value.components,item=>object(item) && identity(item.id) && text(item.path,4096) && text(item.provider,120) && status(item.epistemicStatus))
      && array(value.relations,item=>object(item) && identity(item.source) && identity(item.target) && identity(item.predicate) && status(item.epistemicStatus),200)
      && array(value.knownDebt,item=>object(item) && identity(item.debt_id) && item.status==='open' && nullableText(item.title,2000) && status(item.epistemic_status))
      && array(value.recentRelatedChanges,change,8)
      && array(value.requiredEvidence,item=>object(item) && text(item.kind,120))
      && array(value.warnings,item=>text(item,4096),64);
  } catch { return false; }
}
