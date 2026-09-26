import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { computeMetrics, loadState } from './state.mjs';
import { assuranceFromChangeEnvelope, assertPortalSnapshotSafe, buildPortalSnapshot } from './portal-snapshot.mjs';
import { buildPortalProjectModel, flushPortalQueue, isPortalTimestamp, queuePortalSnapshot } from './portal-client.mjs';
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
  for (const item of sessions) {
    if (currentChangeId(item)===changeId) return item;
    const record=(Array.isArray(item?.completedChanges) ? item.completedChanges : []).find((entry)=>entry?.changeId===changeId && CHANGE_ID.test(String(entry.changeId)));
    // Rebuilt entirely from that change's record, never mixed with the session's later turns.
    if (record) return { ...item, ...Object.fromEntries(COMPLETED_CHANGE_FIELDS.map((field)=>[field, record[field] ?? null])), proof:{ ...record.proof, changeId } };
  }
  return null;
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
const MAX_ASSURANCE_SENT=64;
const assuranceKey=(changeId,assurance)=>createHash('sha256').update(`${changeId}\n${JSON.stringify(assurance)}`).digest('hex').slice(0,32);

function readAssuranceSent(cwd) {
  try {
    const value=JSON.parse(fs.readFileSync(projectPaths(cwd).portalAssuranceSent,'utf8'));
    return value?.schema===ASSURANCE_SENT_SCHEMA && Array.isArray(value.entries) ? value.entries.filter((item)=>typeof item?.key==='string' && /^ipsnap_[a-f0-9]{24}$/.test(String(item?.snapshot?.snapshotId)) && isPortalTimestamp(item?.snapshot?.generatedAt)) : [];
  } catch { return []; }
}

function recordAssuranceSent(cwd, key, snapshot) {
  const entries=readAssuranceSent(cwd).filter((item)=>item.key!==key);
  entries.push({ key, snapshot });
  const file=projectPaths(cwd).portalAssuranceSent;
  fs.mkdirSync(path.dirname(file),{ recursive:true });
  // Retained receipts carry project metadata: private to the user, like every other Portal state file.
  const staged=`${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(staged,`${JSON.stringify({ schema:ASSURANCE_SENT_SCHEMA, entries:entries.slice(-MAX_ASSURANCE_SENT) })}\n`,{ encoding:'utf8', mode:0o600, flag:'wx' });
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
    const previous=readAssuranceSent(cwd).find((item)=>item.key===key);
    const receipt=previous ? previous.snapshot : snapshot;
    assertPortalSnapshotSafe(receipt);
    const queued=queuePortalSnapshot(cwd,receipt);
    if (!previous && (queued.queued || queued.reason==='duplicate')) recordAssuranceSent(cwd,key,receipt);
    return { receipt, previous:Boolean(previous), queued };
  },'IDLEPROOF_PORTAL_ASSURANCE_BUSY','Portal assurance receipt cache');
}

export async function syncPortalAssurance(cwd=process.cwd(), envelope, options={}) {
  const snapshot=buildAssurancePortalSnapshot(cwd,envelope);
  const { receipt, previous, queued }=queueAssuranceReceipt(cwd,snapshot);
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
