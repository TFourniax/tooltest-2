import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { computeMetrics, loadState } from './state.mjs';
import { assuranceFromChangeEnvelope, assertPortalSnapshotSafe, buildPortalSnapshot } from './portal-snapshot.mjs';
import { buildPortalProjectModel, flushPortalQueue, queuePortalSnapshot } from './portal-client.mjs';
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

export function buildAssurancePortalSnapshot(cwd=process.cwd(), envelope) {
  const state=loadState(cwd);
  const sessions=sessionsByRecency(state);
  if (!sessions.some((item)=>currentChangeId(item))) throw new Error('IdleProof has no completed exact-bound change to correlate with DiffWitness assurance.');
  const requested=String(envelope?.change_id || '');
  const session=sessions.find((item)=>currentChangeId(item)===requested) || null;
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
    return value?.schema===ASSURANCE_SENT_SCHEMA && Array.isArray(value.entries) ? value.entries.filter((item)=>typeof item?.key==='string' && /^ipsnap_[a-f0-9]{24}$/.test(String(item?.snapshot?.snapshotId))) : [];
  } catch { return []; }
}

function recordAssuranceSent(cwd, key, snapshot) {
  const entries=readAssuranceSent(cwd).filter((item)=>item.key!==key);
  entries.push({ key, snapshot });
  const file=projectPaths(cwd).portalAssuranceSent;
  fs.mkdirSync(path.dirname(file),{ recursive:true });
  const staged=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(staged,`${JSON.stringify({ schema:ASSURANCE_SENT_SCHEMA, entries:entries.slice(-MAX_ASSURANCE_SENT) })}\n`);
  fs.renameSync(staged,file);
}

export async function syncPortalAssurance(cwd=process.cwd(), envelope, options={}) {
  const snapshot=buildAssurancePortalSnapshot(cwd,envelope);
  const key=assuranceKey(snapshot.change.changeId,snapshot.assurance);
  const previous=readAssuranceSent(cwd).find((item)=>item.key===key);
  const receipt=previous ? previous.snapshot : snapshot;
  assertPortalSnapshotSafe(receipt);
  const queued=queuePortalSnapshot(cwd,receipt);
  if (!previous && (queued.queued || queued.reason==='duplicate')) recordAssuranceSent(cwd,key,receipt);
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
