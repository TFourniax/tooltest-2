import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { computeMetrics, loadState } from './state.mjs';
import { assuranceFromChangeEnvelope, assertPortalSnapshotSafe, buildPortalSnapshot } from './portal-snapshot.mjs';
import { buildPortalProjectModel, flushPortalQueue, isPortalTimestamp, queuedPortalSnapshot, queuePortalSnapshot } from './portal-client.mjs';
import { withOwnedLock } from './portal-memory-lock.mjs';
import { COMPLETED_CHANGE_FIELDS } from './change-identity.mjs';
import { projectPaths } from './paths.mjs';

// Assurance belongs to one exact change. It is attached to the IdleProof session whose completed
// change carries the same dwchg_ identity, never to "the latest session": measuring an earlier
// change after a newer task must still reach that earlier change, and a measurement of another
// change must be refused rather than attached to whatever ran last.
function sessionsByRecency(state) {
  return Object.values(state?.sessions || {}).sort((a,b)=>String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')));
}

function currentChangeId(session) {
  const value=session?.proof?.changeId || session?.changeIdentity?.changeId || null;
  return /^dwchg_[a-f0-9]{24}$/.test(String(value || '')) ? value : null;
}

export function readChangeEnvelope(file, cwd=process.cwd()) {
  const absolute=path.resolve(cwd,String(file || ''));
  let envelope;
  try { envelope=JSON.parse(fs.readFileSync(absolute,'utf8')); }
  catch (error) { throw new Error(`Cannot read DiffWitness change envelope: ${error.message}`); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('DiffWitness change envelope must be a JSON object.');
  return envelope;
}

const CHANGE_ID=/^dwchg_[a-f0-9]{24}$/;

// The session as it was when it completed `changeId`: its latest change, or an earlier change of a
// reused IDE session kept in its completed-change history.
function sessionForChange(sessions, changeId) {
  // The frozen record of a completed change wins over the live session: once a later turn of the
  // same session starts, its task fields change while `proof` still names the earlier change.
  for (const item of sessions) {
    const record=(Array.isArray(item?.completedChanges) ? item.completedChanges : []).find((entry)=>entry?.changeId===changeId && CHANGE_ID.test(String(entry.changeId)));
    // Rebuilt entirely from that change's record, never mixed with the session's later turns.
    if (record) return { ...item, ...Object.fromEntries(COMPLETED_CHANGE_FIELDS.map((field)=>[field, record[field] ?? null])), proof:{ ...record.proof, changeId } };
  }
  return sessions.find((item)=>currentChangeId(item)===changeId) || null;
}

export function buildAssurancePortalSnapshot(cwd=process.cwd(), envelope) {
  const state=loadState(cwd);
  const sessions=sessionsByRecency(state);
  if (!sessions.some((item)=>currentChangeId(item) || (item?.completedChanges || []).length)) throw new Error('IdleProof has no completed exact-bound change to correlate with DiffWitness assurance.');
  const requested=String(envelope?.change_id || '');
  const session=CHANGE_ID.test(requested) ? sessionForChange(sessions,requested) : null;
  if (!session) throw new Error(`DiffWitness change ${/^dwchg_[a-f0-9]{24}$/.test(requested) ? requested : '(invalid id)'} matches no change completed by IdleProof in this project. Measure the exact change IdleProof observed (its base and resulting Git trees), then retry; nothing was sent.`);
  const assurance=assuranceFromChangeEnvelope(envelope,currentChangeId(session));
  const metrics=computeMetrics(state);
  const featureModel=session?.featureModel || null;
  const projectModel=buildPortalProjectModel(cwd,state,session,featureModel);
  const snapshot=buildPortalSnapshot({
    state:{...state,metrics},
    session,
    featureModel,
    projectModel,
    explanation:null,
    assurance
  });
  if (snapshot.change.changeId !== envelope.change_id) throw new Error('Assurance snapshot lost exact change correlation.');
  assertPortalSnapshotSafe(snapshot);
  return snapshot;
}

// The same measurement of the same change is one receipt. The assurance snapshot also carries the
// project's current understanding state, so rebuilding it later would yield a new snapshot identity
// for an identical measurement. The original receipt is kept instead and queued again as is, so each
// destination deduplicates it: the same Portal project answers duplicate, a newly enrolled one
// accepts it. A different measurement of that change is a new receipt.
const ASSURANCE_SENT_SCHEMA='idleproof.portal-assurance-sent.v2';
// Every measurement ever sent keeps its identity, without an eviction boundary: forgetting one would
// let a later resend build a second receipt for it. An identity is about a hundred bytes. Only the
// most recent ones also keep the full receipt body, which is what a new destination needs.
const MAX_ASSURANCE_BODIES=64;
const assuranceKey=(changeId,assurance)=>createHash('sha256').update(`${changeId}\n${JSON.stringify(assurance)}`).digest('hex').slice(0,32);
// A retained body is trusted only if it is still the exact receipt its identity names; anything
// else is treated as absent, so a copy still in the retry queue can be used instead.
const boundTo=(snapshot,key)=>assuranceKey(snapshot?.change?.changeId,snapshot?.assurance)===key;
const validBody=(snapshot)=>{
  if (!snapshot || typeof snapshot!=='object' || !isPortalTimestamp(snapshot.generatedAt)) return false;
  try { return assertPortalSnapshotSafe(snapshot); } catch { return false; }
};

// Only a missing file is an empty history. A damaged or unreadable one stops assurance with an
// explicit local-state error: treating it as empty could send a second receipt for a measurement.
function assuranceStateError(detail) {
  const error=new Error(`IdleProof assurance receipt history is unreadable (${detail}); nothing was sent. Inspect or remove ${'.idleproof/portal-assurance-sent.json'} deliberately.`);
  error.code='IDLEPROOF_ASSURANCE_STATE_CORRUPT';
  return error;
}

function readAssuranceSent(cwd) {
  let value;
  try { value=JSON.parse(fs.readFileSync(projectPaths(cwd).portalAssuranceSent,'utf8')); }
  catch (error) {
    if (error?.code==='ENOENT') return [];
    throw assuranceStateError(error?.code || 'invalid JSON');
  }
  if (value?.schema!==ASSURANCE_SENT_SCHEMA || !Array.isArray(value.entries)) throw assuranceStateError('unsupported schema');
  return value.entries.map((item)=>{
    // A damaged receipt body is dropped, never uploaded; the measurement's identity is kept. A body
    // is kept only if it is the receipt of this very entry: its change and measurement recompute to
    // the entry's key and it carries the entry's snapshot id.
    const snapshotId=String(item?.snapshotId || '');
    const snapshot=validBody(item?.snapshot) && boundTo(item.snapshot,item?.key) && item.snapshot.snapshotId===snapshotId ? item.snapshot : null;
    if (typeof item?.key!=='string' || !/^[a-f0-9]{32}$/.test(item.key) || !/^ipsnap_[a-f0-9]{24}$/.test(snapshotId)) throw assuranceStateError('invalid entry');
    return { key:item.key, snapshotId, snapshot };
  });
}

function recordAssuranceSent(cwd, key, snapshot) {
  const entries=[...readAssuranceSent(cwd).filter((item)=>item.key!==key), { key, snapshotId:snapshot.snapshotId, snapshot }];
  const firstBody=entries.length-MAX_ASSURANCE_BODIES;
  const stored=entries.map((item,index)=>index>=firstBody && item.snapshot ? item : { key:item.key, snapshotId:item.snapshotId });
  const file=projectPaths(cwd).portalAssuranceSent;
  fs.mkdirSync(path.dirname(file),{ recursive:true });
  // Retained receipts carry project metadata: private to the user, like every other Portal state file.
  const staged=`${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(staged,`${JSON.stringify({ schema:ASSURANCE_SENT_SCHEMA, entries:stored })}\n`,{ encoding:'utf8', mode:0o600, flag:'wx' });
    fs.renameSync(staged,file);
  } finally {
    try { fs.rmSync(staged,{ force:true }); } catch {}
  }
}

// Every delivery route (this command and the IDE hook) queues an assurance through here, so one
// measurement of one change stays one receipt whichever route sent it first.
export function queueAssuranceReceipt(cwd, snapshot) {
  const key=assuranceKey(snapshot.change.changeId,snapshot.assurance);
  // Lookup, queueing and recording form one step per project, so concurrent hook and CLI
  // processes neither lose each other's receipts nor queue two receipts for one measurement.
  // The lock is recovered only from an owner that provably no longer exists, never by age.
  fs.mkdirSync(projectPaths(cwd).dir,{ recursive:true });
  return withOwnedLock(projectPaths(cwd).portalAssuranceLock,()=>{
    let previous=readAssuranceSent(cwd).find((item)=>item.key===key);
    let recovered=false;
    if (previous && !previous.snapshot) {
      // Its body may still be waiting in the retry queue (for example while Portal was offline).
      const queuedBody=queuedPortalSnapshot(cwd,previous.snapshotId);
      if (queuedBody && boundTo(queuedBody,key)) { previous={ ...previous, snapshot:queuedBody }; recovered=true; }
    }
    if (previous && !previous.snapshot) {
      // Queued long ago and its body is no longer retained locally: it is never rebuilt as a second
      // receipt, and never reported delivered either, since this client cannot tell which Portal
      // project received it. The caller is told explicitly; sending it again needs a new measurement.
      return { receipt:{ snapshotId:previous.snapshotId, change:{ changeId:snapshot.change.changeId } }, previous:true, notRetained:true, queued:{ queued:false, reason:'not-retained', snapshotId:previous.snapshotId, pending:null, skippedSnapshots:0 } };
    }
    const receipt=previous ? previous.snapshot : snapshot;
    assertPortalSnapshotSafe(receipt);
    // The receipt is recorded before it is queued: an interruption between the two writes leaves a
    // recorded receipt that a retry resends as is, never a queued body that a retry would duplicate
    // under a new snapshot id. A body recovered from the queue is retained again the same way,
    // before a delivery can drop its last copy.
    if (!previous || recovered) recordAssuranceSent(cwd,key,receipt);
    const queued=queuePortalSnapshot(cwd,receipt);
    return { receipt, previous:Boolean(previous), queued };
  },'IDLEPROOF_PORTAL_ASSURANCE_BUSY','Portal assurance receipt cache');
}

export async function syncPortalAssurance(cwd=process.cwd(), envelope, options={}) {
  const snapshot=buildAssurancePortalSnapshot(cwd,envelope);
  const { receipt, previous, queued, notRetained }=queueAssuranceReceipt(cwd,snapshot);
  if (notRetained) {
    return { configured:true, ok:false, errorCode:'IDLEPROOF_ASSURANCE_NOT_RETAINED', message:'This measurement was queued for Portal long ago and its receipt is no longer kept locally, so it cannot be resent or confirmed; measure the change again to send it. Nothing was sent.', snapshotId:receipt.snapshotId, changeId:receipt.change.changeId, newlyQueued:false, queueReason:'not-retained', assurance:snapshot.assurance };
  }
  const flushed=await flushPortalQueue(cwd,options);
  const retained=queued.reason !== 'queue-full';
  return {
    ...flushed,
    ok:flushed.configured === false ? true : Boolean(flushed.ok) && retained,
    errorCode:retained ? flushed.errorCode : (flushed.errorCode || 'QUEUE_FULL'),
    snapshotId:receipt.snapshotId,
    changeId:receipt.change.changeId,
    newlyQueued:queued.queued,
    queueReason:previous ? 'already-sent' : (queued.reason || null),
    skippedSnapshots:Math.max(queued.skippedSnapshots || 0,flushed.skippedSnapshots || 0),
    assurance:snapshot.assurance
  };
}
