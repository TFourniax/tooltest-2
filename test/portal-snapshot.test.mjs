import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPortalSnapshotSafe, buildPortalSnapshot } from '../src/portal-snapshot.mjs';

test('portal snapshot carries longitudinal intelligence without source code, diff, raw agent events, or raw prompt text',()=>{
  const rawPrompt='Fix webhook with api_key=super-secret-value and source snippet const secretThing = 42';
  const snapshot=buildPortalSnapshot({
    state:{project:'acme-app',createdAt:'2026-01-01T00:00:00Z',metrics:{debt:7,coverage:72,conceptsSeen:4,featuresSeen:2,featureCoverage:66,featureDebt:3}},
    session:{
      prompt:rawPrompt,
      source:'claude',status:'complete',currentResource:'src/payments/weird.ts',touchedFiles:['src/payments/weird.ts'],changed:{added:10,deleted:2},
      taskSignals:{file:'src/payments/weird.ts',symbol:'handleAcmeWebhook',route:'/hooks/acme'},
      proof:{changeId:'dwchg_0123456789abcdef01234567',diffSha256:'a'.repeat(64)},events:[{tool_input:{content:'SECRET SOURCE'}}]
    },
    explanation:{concept:{id:'http',name:'request and API behavior'},certainty:{level:'observed-plus-inferred'},files:[{path:'src/payments/weird.ts',role:'integration',confidence:'medium'}]},
    featureModel:{fingerprint:'fp',surfaces:{routes:['/hooks/acme'],tables:['event_inbox'],technologies:['AcmeSDK']},story:[{type:'file',label:'src/payments/weird.ts',role:'service'}],tests:['tests/weird.test.ts']},
    projectModel:{stats:{features:2},impact:{blastRadius:1}}
  });
  assert.equal(assertPortalSnapshotSafe(snapshot),true);
  assert.equal(snapshot.privacy.sourceCodeIncluded,false);
  assert.equal(snapshot.privacy.rawDiffIncluded,false);
  assert.equal(snapshot.privacy.rawAgentEventsIncluded,false);
  assert.equal(snapshot.privacy.rawPromptIncluded,false);
  assert.equal(snapshot.task.summary,'Work around handleAcmeWebhook in src/payments/weird.ts');
  assert.equal(snapshot.task.promptChars,rawPrompt.length);
  assert.match(snapshot.task.promptDigest,/^sha256:[a-f0-9]{64}$/);
  assert.equal(snapshot.change.changeId,'dwchg_0123456789abcdef01234567');
  const serialized=JSON.stringify(snapshot);
  assert.ok(!serialized.includes(rawPrompt));
  assert.ok(!serialized.includes('super-secret-value'));
  assert.ok(!serialized.includes('secretThing'));
  assert.ok(!serialized.includes('SECRET SOURCE'));
  assert.deepEqual(snapshot.files,['src/payments/weird.ts']);
});

test('portal paths reject absolute and traversal paths',()=>{
  const snapshot=buildPortalSnapshot({state:{project:'x'},session:{prompt:'private task',touchedFiles:['../secret.txt','/etc/passwd','src/ok.ts']}});
  assert.deepEqual(snapshot.files,['src/ok.ts']);
  assert.equal(snapshot.task.summary,'Work involving src/ok.ts');
  assert.ok(!JSON.stringify(snapshot).includes('private task'));
});

test('portal safety assertion rejects any future raw prompt field and fail-open privacy declaration',()=>{
  const safe=buildPortalSnapshot({state:{project:'x'},session:{prompt:'never upload this'}});
  assert.equal(assertPortalSnapshotSafe(safe),true);
  assert.throws(()=>assertPortalSnapshotSafe({...safe,task:{...safe.task,prompt:'leak'}}),/Forbidden portal field: prompt/);
  assert.throws(()=>assertPortalSnapshotSafe({...safe,privacy:{...safe.privacy,rawPromptIncluded:true}}),/privacy declaration is not fail-closed/i);
});
