import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshState, saveState } from '../src/state.mjs';
import { buildCurrentPortalSnapshot, syncPortal, writePortalConfig } from '../src/portal-client.mjs';
import { __portalTest } from '../src/portal-snapshot.mjs';
import { projectPaths } from '../src/paths.mjs';

function fixture() {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-portal-hardening-'));
  const state=freshState(cwd);
  state.sessions.s1={
    id:'s1',source:'claude',status:'complete',startedAt:'2026-08-21T20:00:00Z',lastEventAt:'2026-08-21T20:01:00Z',completedAt:'2026-08-21T20:01:00Z',
    promptChars:4,promptSha256:'a'.repeat(64),touchedFiles:['src/app.ts'],changed:{added:1,deleted:0},concepts:{},events:[],
    proof:{changeId:`dwchg_${'b'.repeat(24)}`,diffSha256:'c'.repeat(64)},taskSignals:{file:'src/app.ts'}
  };
  saveState(cwd,state);
  return cwd;
}
function cleanup(cwd){try{fs.rmSync(cwd,{recursive:true,force:true});}catch{}}

test('Portal endpoint cannot hide credentials in authority or query parameters',()=>{
  const cwd=fixture();
  try {
    const token=`ipd_${'x'.repeat(32)}`;
    assert.throws(
      ()=>writePortalConfig(cwd,{endpoint:'https://user:password@example.com/api/v1/snapshots',token}),
      (error)=>error?.code==='IDLEPROOF_PORTAL_ENDPOINT_CREDENTIALS'
    );
    assert.throws(
      ()=>writePortalConfig(cwd,{endpoint:'https://example.com/api/v1/snapshots?token=secret',token}),
      (error)=>error?.code==='IDLEPROOF_PORTAL_ENDPOINT_QUERY'
    );
  } finally { cleanup(cwd); }
});

test('manual sync never reports success when the current snapshot could not be retained',async()=>{
  const cwd=fixture();
  try {
    writePortalConfig(cwd,{endpoint:'http://127.0.0.1:8787/api/v1/snapshots',token:`ipd_${'q'.repeat(32)}`});
    const base=buildCurrentPortalSnapshot(cwd);
    const fullQueue=Array.from({length:200},(_,index)=>{
      const item=structuredClone(base);
      item.task.summary=`offline backlog ${index}`;
      item.snapshotId=__portalTest.stableSnapshotId(item);
      return item;
    });
    fs.writeFileSync(projectPaths(cwd).portalQueue,`${JSON.stringify(fullQueue,null,2)}\n`,{encoding:'utf8',mode:0o600});
    const result=await syncPortal(cwd,{
      fetchImpl:async (_url,options)=>{
        const snapshot=JSON.parse(options.body);
        return new Response(JSON.stringify({schema:'idleproof.portal-ingest-ack.v1',status:'accepted',snapshotId:snapshot.snapshotId}),{status:202});
      },
      timeoutMs:500
    });
    assert.equal(result.queueReason,'queue-full');
    assert.equal(result.ok,false);
    assert.equal(result.errorCode,'QUEUE_FULL');
    assert.equal(result.skippedSnapshots,1);
    assert.equal(result.delivered,200);
    assert.equal(result.pending,0);
    assert.equal(fs.existsSync(projectPaths(cwd).portalQueue),false);
  } finally { cleanup(cwd); }
});
