// Real installed npm producer -> exact supplied Portal validator. No HTTP/DB claim.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [installedRoot,validatorPath]=process.argv.slice(2);
assert.ok(installedRoot && validatorPath,'Pass installed idleproof root and exact Portal validator.ts path');
const {buildPortalSnapshot,assertPortalSnapshotSafe}=await import(pathToFileURL(join(resolve(installedRoot),'src/portal-snapshot.mjs')));
const {validateSnapshot,parseStrictJson,MAX_BODY_BYTES}=await import(pathToFileURL(resolve(validatorPath)));
const longPrefix='directory/'.repeat(29)+'filename__';
const cases=[
  {paths:[longPrefix+'a.py',longPrefix+'b.py'],expected:[],omitted:2},
  {paths:['密'.repeat(297)+'.py','密'.repeat(298)+'.py'],expected:['密'.repeat(297)+'.py'],omitted:1},
  {paths:['src/école.py','src/a\tb.py','src/a\nb.py','src/..'],expected:['src/école.py'],omitted:3},
];
for(const item of cases) {
  const context={schema_version:'continuity-context-1',context_id:'dwctx_'+'a'.repeat(24),generated_at:'2026-09-23T00:00:00Z',
    project:{name:'fixture',fingerprint:'dwrepo_'+'b'.repeat(24)},task:'Path coverage',
    state:{eventHead:'c'.repeat(64),structureTree:'d'.repeat(40),structureCoverage:null},
    objectives:[],tasks:[],decisions:[],invariants:[],failedApproaches:[],knownDebt:[],
    components:item.paths.map((path,i)=>({id:'COMP-'+i,path,provider:'python',epistemicStatus:'OBSERVED'})),
    relations:item.paths.slice(1).map((p,i)=>({source:'COMP-0',target:'COMP-'+(i+1),predicate:'related_to',epistemicStatus:'INFERRED'})),
    recentRelatedChanges:[{changeId:'dwchg_'+'e'.repeat(24),files:item.paths,proof:null,softwareDebt:null,understanding:null}],
    requiredEvidence:[],warnings:[],trustBoundary:{contextIsAdvisory:true,proofRemainsAuthoritative:true}};
  for(const withContext of [false,true]) {
    const args={state:{project:'Path fixture'},session:{touchedFiles:item.paths,currentResource:item.paths.at(-1)},
      explanation:{files:item.paths.map(path=>({path,role:'source',confidence:'observed'}))},
      featureModel:{story:item.paths.map(label=>({type:'file',label,role:'source'})),tests:item.paths},
      ...(withContext?{projectModel:{continuity:context}}:{})};
    const snapshot=buildPortalSnapshot(args), text=JSON.stringify(snapshot);
    assertPortalSnapshotSafe(snapshot); assert.ok(Buffer.byteLength(text)<=MAX_BODY_BYTES);
    const validated=await validateSnapshot(parseStrictJson(text));
    assert.deepEqual(validated.files,item.expected);
    assert.deepEqual(validated.explanation.files.map(x=>x.path),item.expected);
    assert.deepEqual(validated.feature.tests,item.expected);
    assert.deepEqual(validated.feature.story.map(x=>x.label),item.expected);
    assert.match(validated.task.summary,new RegExp(`path coverage incomplete: ${item.omitted} unique`));
    if(withContext) {
      const memory=validated.projectMemory.continuity;
      assert.deepEqual(memory.components.map(x=>x.path),item.expected);
      assert.deepEqual(memory.relations,[]);
      assert.deepEqual(memory.recentChanges[0].files,item.expected);
    }
    assert.equal(snapshot.snapshotId,buildPortalSnapshot(args).snapshotId);
  }
}
console.log(JSON.stringify({classification:'MACHINE',cases:6,producer:'installed npm package',validatorSha256:createHash('sha256').update(readFileSync(validatorPath)).digest('hex'),pathsExactOrExplicitlyOmitted:true,relationsCoherent:true,idempotency:true,maxBytes:MAX_BODY_BYTES,http:false,database:false}));
