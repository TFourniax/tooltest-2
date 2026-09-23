import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {buildPortalSnapshot, assertPortalSnapshotSafe} from '../src/portal-snapshot.mjs';

function context(paths) {
  return {
    schema_version:'continuity-context-1',context_id:'dwctx_'+'a'.repeat(24),generated_at:'2026-09-23T00:00:00Z',
    project:{name:'fixture',fingerprint:'dwrepo_'+'b'.repeat(24)},task:'Path coverage',
    state:{eventHead:'c'.repeat(64),structureTree:'d'.repeat(40),structureCoverage:null},
    objectives:[],tasks:[],decisions:[],invariants:[],failedApproaches:[],knownDebt:[],
    components:paths.map((p,i)=>({id:'COMP-'+i,path:p,provider:'python',epistemicStatus:'OBSERVED'})),
    relations:paths.slice(1).map((p,i)=>({source:'COMP-0',target:'COMP-'+(i+1),predicate:'related_to',epistemicStatus:'INFERRED'})),
    recentRelatedChanges:[{changeId:'dwchg_'+'e'.repeat(24),files:paths,proof:null,softwareDebt:null,understanding:null}],
    requiredEvidence:[],warnings:[],trustBoundary:{contextIsAdvisory:true,proofRemainsAuthoritative:true}
  };
}
function args(paths,withContext=true) {
  return {state:{project:'Path fixture'},session:{touchedFiles:paths,currentResource:paths.at(-1)},
    explanation:{files:paths.map(p=>({path:p,role:'source',confidence:'observed'}))},
    featureModel:{story:paths.map(label=>({type:'file',label,role:'source'})),tests:paths},
    ...(withContext ? {projectModel:{continuity:context(paths)}} : {})};
}

test('long shared prefixes never become path aliases in any projection or relation',()=>{
  const prefix=('directory/'.repeat(29))+'filename__';
  const paths=['src/ok.py',prefix+'a.py',prefix+'b.py','密'.repeat(298)+'.py'];
  assert.ok(paths.slice(1).every(p=>p.length>300));
  const input=args(paths), original=structuredClone(input), snapshot=buildPortalSnapshot(input);
  assert.deepEqual(snapshot.files,['src/ok.py']);
  assert.deepEqual(snapshot.explanation.files.map(x=>x.path),['src/ok.py']);
  assert.deepEqual(snapshot.feature.story.map(x=>x.label),['src/ok.py']);
  assert.deepEqual(snapshot.feature.tests,['src/ok.py']);
  const memory=snapshot.projectMemory.continuity;
  assert.deepEqual(memory.components.map(x=>x.path),['src/ok.py']);
  assert.deepEqual(memory.relations,[]);
  assert.deepEqual(memory.recentChanges[0].files,['src/ok.py']);
  assert.ok(memory.warnings.some(x=>/path coverage.*300/i.test(x)));
  assert.match(snapshot.task.summary,/path coverage.*300/i);
  assert.ok(!JSON.stringify(snapshot).includes(prefix));
  assertPortalSnapshotSafe(snapshot);
  assert.equal(snapshot.snapshotId,buildPortalSnapshot(input).snapshotId);
  assert.deepEqual(input,original);
});

test('omission is visible without continuity and exact supported paths stay exact',()=>{
  const exact='密'.repeat(297)+'.py'; assert.equal(exact.length,300);
  const input=args([exact,exact+'x'],false), snapshot=buildPortalSnapshot(input);
  assert.deepEqual(snapshot.files,[exact]);
  assert.match(snapshot.task.summary,/path coverage.*300/i);
  assert.ok(snapshot.task.summary.length<=300);
  assertPortalSnapshotSafe(snapshot);
  const native=['src','accentué.py'].join(path.sep);
  assert.deepEqual(buildPortalSnapshot(args([native],false)).files,['src/accentué.py']);
});

test('unsupported control and traversal paths are omitted without dangling components',()=>{
  const invalid=['src/a\tb.py','src/a\nb.py','src/..','../outside.py','/absolute.py'];
  if(path.sep!=='\\') invalid.push('src/literal\\name.py');
  const snapshot=buildPortalSnapshot(args(['src/ok.py',...invalid]));
  assert.deepEqual(snapshot.files,['src/ok.py']);
  assert.deepEqual(snapshot.projectMemory.continuity.relations,[]);
  assert.match(snapshot.task.summary,/path coverage/i);
});

test('row limits remove relations to omitted components and disclose incomplete coverage',()=>{
  const paths=Array.from({length:14},(_,i)=>`src/file${i}.py`);
  const snapshot=buildPortalSnapshot(args(paths));
  const memory=snapshot.projectMemory.continuity, ids=new Set(memory.components.map(x=>x.id));
  assert.equal(ids.size,12);
  assert.ok(memory.relations.every(x=>ids.has(x.sourceId)&&ids.has(x.targetId)));
  assert.ok(memory.warnings.some(x=>/omitted|coverage|limit/i.test(x)));
});

test('legacy context without tasks retains exact projected paths and omission warnings',()=>{
  const input=args(['src/ok.py','x'.repeat(301)]);
  delete input.projectModel.continuity.tasks;
  const snapshot=buildPortalSnapshot(input);
  assert.deepEqual(snapshot.projectMemory.continuity.tasks,[]);
  assert.deepEqual(snapshot.files,['src/ok.py']);
  assert.deepEqual(snapshot.projectMemory.continuity.relations,[]);
  assert.match(snapshot.task.summary,/path coverage incomplete/);
  assertPortalSnapshotSafe(snapshot);
});

test('rejected advisory contexts cannot crash or contribute unadmitted paths',()=>{
  for(const continuity of [null, 'bad', {components:'bad'}, {recentRelatedChanges:'bad'},
    {components:[null]}, {...context([]),components:[null]},
    {...context([]),recentRelatedChanges:[{files:'bad'}]}]) {
    const input=args(['src/ok.py']);input.projectModel.continuity=continuity;
    const before=structuredClone(input), snapshot=buildPortalSnapshot(input);
    assert.equal(snapshot.projectMemory.continuity,null);
    assert.deepEqual(snapshot.files,['src/ok.py']);
    assert.doesNotMatch(snapshot.task.summary,/path coverage incomplete/);
    assertPortalSnapshotSafe(snapshot);assert.deepEqual(input,before);
  }
});

test('coverage notices retain a compact task description when exact paths fill the summary',()=>{
  for(const length of [187,250,300]) {
    const current='x'.repeat(length-3)+'.py', input=args(['y'.repeat(301),current]);
    const snapshot=buildPortalSnapshot(input);
    assert.deepEqual(snapshot.files,[current]);
    assert.match(snapshot.task.summary,/^Work involving/);
    assert.match(snapshot.task.summary,/path coverage incomplete/);
    assert.ok(snapshot.task.summary.length<=300);
    assertPortalSnapshotSafe(snapshot);
    assert.equal(snapshot.snapshotId,buildPortalSnapshot(input).snapshotId);
  }
});
