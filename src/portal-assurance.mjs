import fs from 'node:fs';
import path from 'node:path';
import { computeMetrics, loadState } from './state.mjs';
import { assuranceFromChangeEnvelope, assertPortalSnapshotSafe, buildPortalSnapshot } from './portal-snapshot.mjs';
import { flushPortalQueue, queuePortalSnapshot, resolvePortalProjectSeed } from './portal-client.mjs';

function latestSession(state) {
  return Object.values(state?.sessions || {}).sort((a,b)=>String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))[0] || null;
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
  const session=latestSession(state);
  const expectedChangeId=currentChangeId(session);
  if (!expectedChangeId) throw new Error('IdleProof has no completed exact-bound change to correlate with DiffWitness assurance.');
  const assurance=assuranceFromChangeEnvelope(envelope,expectedChangeId);
  const metrics=computeMetrics(state);
  const projectIdentitySeed=resolvePortalProjectSeed(cwd,state);
  const snapshot=buildPortalSnapshot({
    state:{...state,metrics,createdAt:projectIdentitySeed},
    session,
    featureModel:session?.featureModel || null,
    projectModel:null,
    explanation:null,
    assurance
  });
  if (snapshot.change.changeId !== envelope.change_id) throw new Error('Assurance snapshot lost exact change correlation.');
  assertPortalSnapshotSafe(snapshot);
  return snapshot;
}

export async function syncPortalAssurance(cwd=process.cwd(), envelope, options={}) {
  const snapshot=buildAssurancePortalSnapshot(cwd,envelope);
  const queued=queuePortalSnapshot(cwd,snapshot);
  const flushed=await flushPortalQueue(cwd,options);
  const retained=queued.reason !== 'queue-full';
  return {
    ...flushed,
    ok:flushed.configured === false ? true : Boolean(flushed.ok) && retained,
    errorCode:retained ? flushed.errorCode : (flushed.errorCode || 'QUEUE_FULL'),
    snapshotId:snapshot.snapshotId,
    changeId:snapshot.change.changeId,
    newlyQueued:queued.queued,
    queueReason:queued.reason || null,
    skippedSnapshots:Math.max(queued.skippedSnapshots || 0,flushed.skippedSnapshots || 0),
    assurance:snapshot.assurance
  };
}
