import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshState, saveState } from '../src/state.mjs';
import { buildCurrentPortalSnapshot, flushPortalQueue, portalStatus, queuePortalSnapshot, writePortalConfig } from '../src/portal-client.mjs';
import { PORTAL_INGEST_ACK_SCHEMA, validatePortalIngestAck } from '../src/portal-ingest-ack.mjs';
import { projectPaths } from '../src/paths.mjs';

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-ack-'));
  const state = freshState(cwd);
  state.sessions.s1 = {
    id:'s1', source:'claude', status:'complete',
    startedAt:'2026-08-21T18:00:00Z', lastEventAt:'2026-08-21T18:01:00Z', completedAt:'2026-08-21T18:01:00Z',
    promptChars:12, promptSha256:'a'.repeat(64), touchedFiles:['src/app.ts'], changed:{added:1,deleted:0}, concepts:{}, events:[],
    proof:{ changeId:`dwchg_${'b'.repeat(24)}`, diffSha256:'c'.repeat(64) }, taskSignals:{file:'src/app.ts'}
  };
  saveState(cwd, state);
  writePortalConfig(cwd, { endpoint:'http://127.0.0.1:8787/api/v1/snapshots', token:`ipd_${'a'.repeat(32)}` });
  const snapshot = buildCurrentPortalSnapshot(cwd);
  queuePortalSnapshot(cwd, snapshot);
  return { cwd, snapshot };
}

function cleanup(cwd) { try { fs.rmSync(cwd, {recursive:true,force:true}); } catch {} }
function queueLength(cwd) { return JSON.parse(fs.readFileSync(projectPaths(cwd).portalQueue,'utf8')).length; }

test('ingestion ack validator accepts only exact versioned accepted/duplicate acknowledgements', () => {
  const id=`ipsnap_${'a'.repeat(24)}`;
  for (const status of ['accepted','duplicate']) {
    assert.deepEqual(validatePortalIngestAck({schema:PORTAL_INGEST_ACK_SCHEMA,status,snapshotId:id}, id), {schema:PORTAL_INGEST_ACK_SCHEMA,status,snapshotId:id});
  }
  assert.throws(() => validatePortalIngestAck({status:'accepted',snapshotId:id}, id), /must use/);
  assert.throws(() => validatePortalIngestAck({schema:PORTAL_INGEST_ACK_SCHEMA,status:'accepted',snapshotId:`ipsnap_${'b'.repeat(24)}`}, id), (error)=>error?.code==='IDLEPROOF_PORTAL_ACK_MISMATCH');
  assert.throws(() => validatePortalIngestAck({schema:PORTAL_INGEST_ACK_SCHEMA,status:'accepted',snapshotId:id,extra:true}, id), /unknown field/);
});

test('HTTP 202 with empty body never dequeues a snapshot', async () => {
  const {cwd}=fixture();
  try {
    const result=await flushPortalQueue(cwd,{fetchImpl:async()=>new Response('',{status:202})});
    assert.equal(result.ok,false);
    assert.equal(result.errorCode,'IDLEPROOF_PORTAL_ACK_INVALID');
    assert.equal(result.pending,1);
    assert.equal(queueLength(cwd),1);
    assert.equal(portalStatus(cwd).lastErrorCode,'IDLEPROOF_PORTAL_ACK_INVALID');
  } finally { cleanup(cwd); }
});

test('HTTP 200 with HTML or malformed JSON never dequeues a snapshot', async () => {
  for (const body of ['<html>proxy success</html>', '{not-json']) {
    const {cwd}=fixture();
    try {
      const result=await flushPortalQueue(cwd,{fetchImpl:async()=>new Response(body,{status:200})});
      assert.equal(result.ok,false);
      assert.equal(result.errorCode,'IDLEPROOF_PORTAL_ACK_INVALID');
      assert.equal(result.pending,1);
      assert.equal(queueLength(cwd),1);
    } finally { cleanup(cwd); }
  }
});

test('wrong snapshot acknowledgement never dequeues queued evidence', async () => {
  const {cwd}=fixture();
  try {
    const wrong=`ipsnap_${'f'.repeat(24)}`;
    const result=await flushPortalQueue(cwd,{fetchImpl:async()=>new Response(JSON.stringify({schema:PORTAL_INGEST_ACK_SCHEMA,status:'accepted',snapshotId:wrong}),{status:202})});
    assert.equal(result.ok,false);
    assert.equal(result.errorCode,'IDLEPROOF_PORTAL_ACK_MISMATCH');
    assert.equal(result.pending,1);
    assert.equal(queueLength(cwd),1);
  } finally { cleanup(cwd); }
});

test('duplicate acknowledgement is authoritative and safely dequeues the idempotent retry', async () => {
  const {cwd,snapshot}=fixture();
  try {
    const result=await flushPortalQueue(cwd,{fetchImpl:async()=>new Response(JSON.stringify({schema:PORTAL_INGEST_ACK_SCHEMA,status:'duplicate',snapshotId:snapshot.snapshotId}),{status:200})});
    assert.equal(result.ok,true);
    assert.equal(result.delivered,1);
    assert.equal(result.pending,0);
    assert.equal(fs.existsSync(projectPaths(cwd).portalQueue),false);
  } finally { cleanup(cwd); }
});
