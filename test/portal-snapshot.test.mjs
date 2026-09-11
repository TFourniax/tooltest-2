import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPortalSnapshotSafe, buildPortalSnapshot, __portalTest } from '../src/portal-snapshot.mjs';

function fixture(rawPrompt='Fix webhook with api_key=super-secret-value and source snippet const secretThing = 42') {
  return {
    state:{project:'acme-app',createdAt:'2026-01-01T00:00:00Z',metrics:{debt:7,coverage:72,conceptsSeen:4,featuresSeen:2,featureCoverage:66,featureDebt:3}},
    session:{
      prompt:rawPrompt,
      source:'claude',status:'complete',currentResource:'src/payments/weird.ts',touchedFiles:['src/payments/weird.ts'],changed:{added:10,deleted:2},
      taskSignals:{file:'src/payments/weird.ts',symbol:'handleAcmeWebhook',route:'/hooks/acme'},
      proof:{changeId:'dwchg_0123456789abcdef01234567',diffSha256:'a'.repeat(64)},events:[{tool_input:{content:'SECRET SOURCE'}}]
    },
    explanation:{concept:{id:'http',name:'request and API behavior'},certainty:{level:'observed-plus-inferred'},files:[{path:'src/payments/weird.ts',role:'integration',confidence:'medium'}]},
    featureModel:{fingerprint:'fp',surfaces:{routes:['/hooks/acme'],tables:['event_inbox'],technologies:['AcmeSDK']},story:[{type:'file',label:'src/payments/weird.ts',role:'service'}],tests:['tests/weird.test.ts']},
    projectModel:{stats:{features:2,files:3,sharedFiles:1,boundaryNodes:1},impact:{blastRadius:1}}
  };
}

test('portal snapshot carries longitudinal intelligence without source code, diff, raw agent events, or raw prompt text',()=>{
  const rawPrompt='Fix webhook with api_key=super-secret-value and source snippet const secretThing = 42';
  const snapshot=buildPortalSnapshot(fixture(rawPrompt));
  assert.equal(assertPortalSnapshotSafe(snapshot),true);
  assert.match(snapshot.snapshotId,/^ipsnap_[a-f0-9]{24}$/);
  assert.equal(snapshot.privacy.sourceCodeIncluded,false);
  assert.equal(snapshot.privacy.rawDiffIncluded,false);
  assert.equal(snapshot.privacy.rawAgentEventsIncluded,false);
  assert.equal(snapshot.privacy.rawPromptIncluded,false);
  assert.equal(snapshot.task.summary,'Work around handleAcmeWebhook in src/payments/weird.ts');
  assert.equal(snapshot.task.promptChars,rawPrompt.length);
  assert.match(snapshot.task.promptDigest,/^sha256:[a-f0-9]{64}$/);
  assert.equal(snapshot.change.changeId,'dwchg_0123456789abcdef01234567');
  const serialized=JSON.stringify(snapshot);
  assert.ok(Buffer.byteLength(serialized,'utf8') < __portalTest.MAX_SNAPSHOT_BYTES);
  assert.ok(!serialized.includes(rawPrompt));
  assert.ok(!serialized.includes('super-secret-value'));
  assert.ok(!serialized.includes('secretThing'));
  assert.ok(!serialized.includes('SECRET SOURCE'));
  assert.deepEqual(snapshot.files,['src/payments/weird.ts']);
});

test('identical snapshot retries keep the same id despite a different generation timestamp',async()=>{
  const first=buildPortalSnapshot(fixture());
  await new Promise((resolve)=>setTimeout(resolve,2));
  const retry=buildPortalSnapshot(fixture());
  assert.notEqual(first.generatedAt,retry.generatedAt);
  assert.equal(first.snapshotId,retry.snapshotId);
  assert.equal(__portalTest.stableSnapshotId(first),first.snapshotId);
  assert.equal(__portalTest.stableSnapshotId(retry),retry.snapshotId);
});

test('material longitudinal state change produces a new snapshot id',()=>{
  const firstFixture=fixture();
  const first=buildPortalSnapshot(firstFixture);
  const changed=fixture();
  changed.state.metrics.coverage=91;
  changed.state.metrics.debt=2;
  const second=buildPortalSnapshot(changed);
  assert.notEqual(first.snapshotId,second.snapshotId);
});

test('very large raw prompt stays out of the bounded snapshot while its digest remains stable',()=>{
  const rawPrompt=`token=NEVER_UPLOAD_${'x'.repeat(2_000_000)}`;
  const snapshot=buildPortalSnapshot(fixture(rawPrompt));
  assert.equal(assertPortalSnapshotSafe(snapshot),true);
  assert.equal(snapshot.task.promptChars,rawPrompt.length);
  assert.match(snapshot.task.promptDigest,/^sha256:[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot),'utf8') < __portalTest.MAX_SNAPSHOT_BYTES);
  assert.ok(!JSON.stringify(snapshot).includes('NEVER_UPLOAD'));
});

test('portal paths reject absolute and traversal paths',()=>{
  const snapshot=buildPortalSnapshot({state:{project:'x'},session:{prompt:'private task',touchedFiles:['../secret.txt','/etc/passwd','src/ok.ts']}});
  assert.deepEqual(snapshot.files,['src/ok.ts']);
  assert.equal(snapshot.task.summary,'Work involving src/ok.ts');
  assert.ok(!JSON.stringify(snapshot).includes('private task'));
  assert.equal(assertPortalSnapshotSafe(snapshot),true);
});

test('portal safety assertion rejects raw prompt fields, fail-open privacy, tampered ids, and oversized payloads',()=>{
  const safe=buildPortalSnapshot({state:{project:'x'},session:{prompt:'never upload this'}});
  assert.equal(assertPortalSnapshotSafe(safe),true);
  assert.throws(()=>assertPortalSnapshotSafe({...safe,task:{...safe.task,prompt:'leak'}}),/Forbidden portal field: prompt/);
  assert.throws(()=>assertPortalSnapshotSafe({...safe,privacy:{...safe.privacy,rawPromptIncluded:true}}),/idempotency key does not match|privacy declaration is not fail-closed/i);
  assert.throws(()=>assertPortalSnapshotSafe({...safe,snapshotId:'ipsnap_000000000000000000000000'}),/idempotency key does not match/i);
  const oversized={...safe,extensions:'x'.repeat(__portalTest.MAX_SNAPSHOT_BYTES)};
  oversized.snapshotId=__portalTest.stableSnapshotId(oversized);
  assert.throws(()=>assertPortalSnapshotSafe(oversized),/exceeds .* byte safety budget/i);
});
