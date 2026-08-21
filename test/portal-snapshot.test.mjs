import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPortalSnapshotSafe, buildPortalSnapshot } from '../src/portal-snapshot.mjs';

test('portal snapshot carries longitudinal intelligence without source code, diff, or raw agent events',()=>{
  const snapshot=buildPortalSnapshot({
    state:{project:'acme-app',createdAt:'2026-01-01T00:00:00Z',metrics:{debt:7,coverage:72,conceptsSeen:4,featuresSeen:2,featureCoverage:66,featureDebt:3}},
    session:{prompt:'Fix webhook with api_key=super-secret-value',source:'claude',status:'complete',touchedFiles:['src/payments/weird.ts'],changed:{added:10,deleted:2},proof:{diffSha256:'a'.repeat(64)},events:[{tool_input:{content:'SECRET SOURCE'}}]},
    explanation:{concept:{id:'http'},certainty:{level:'observed-plus-inferred'},files:[{path:'src/payments/weird.ts',role:'integration',confidence:'medium'}]},
    featureModel:{fingerprint:'fp',surfaces:{routes:['/hooks/acme'],tables:['event_inbox'],technologies:['AcmeSDK']},story:[{type:'file',label:'src/payments/weird.ts',role:'service'}],tests:['tests/weird.test.ts']},
    projectModel:{stats:{features:2},impact:{blastRadius:1}}
  });
  assert.equal(assertPortalSnapshotSafe(snapshot),true);
  assert.equal(snapshot.privacy.sourceCodeIncluded,false);
  assert.equal(snapshot.privacy.rawDiffIncluded,false);
  assert.match(snapshot.task.summary,/\[redacted\]/);
  assert.ok(!JSON.stringify(snapshot).includes('SECRET SOURCE'));
  assert.deepEqual(snapshot.files,['src/payments/weird.ts']);
});

test('portal paths reject absolute and traversal paths',()=>{
  const snapshot=buildPortalSnapshot({state:{project:'x'},session:{touchedFiles:['../secret.txt','/etc/passwd','src/ok.ts']}});
  assert.deepEqual(snapshot.files,['src/ok.ts']);
});
