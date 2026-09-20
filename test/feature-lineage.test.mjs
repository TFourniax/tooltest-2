import test from 'node:test';
import assert from 'node:assert/strict';
import { featureKey, rememberFeature } from '../src/feature-memory.mjs';
import { queryFeatureLineage, validFileLineage, renderFeatureLineage, featureLineageCli } from '../src/feature-lineage.mjs';

const sha='a'.repeat(64);
function model(path='old.py', source=sha) {
  const value={fingerprint:'b'.repeat(24),generatedFrom:{filesInspected:1,coverage:[{path,source_sha256:source,canonical:true,parsed:true}]},
    nodes:[{type:'file',label:path,source:{path,source_sha256:source}}],story:[{type:'file',label:path,role:'core'}],
    surfaces:{routes:[],tables:[],technologies:[]},tests:[],riskNotes:[]};
  value.featureKey=featureKey(value);return value;
}
function memory(value=model()) { const state={features:{}};rememberFeature(state,{id:'s'},value);return state; }

test('feature memory retains source-bound observations without migrating scores',()=>{
  const before=model(),after=model('new.py'),state=memory(before);
  state.features[before.featureKey].confidence=0.9;
  rememberFeature(state,{id:'s2'},after);
  const a=state.features[before.featureKey],b=state.features[after.featureKey];
  assert.equal(a.lineageObservations.items[0].anchor.source_sha256,sha);
  assert.notEqual(a.lineageObservations.items[0].id,b.lineageObservations.items[0].id);
  assert.equal(a.confidence,0.9);assert.equal(b.confidence,0);
  assert.equal(Object.keys(state.features).length,2);
});

test('observation retention is bounded, content deduplicated and explicitly incomplete',()=>{
  const state=memory(),key=model().featureKey;
  rememberFeature(state,{id:'s'},model());
  assert.equal(state.features[key].lineageObservations.items.length,1);
  for(let i=1;i<=10;i++) rememberFeature(state,{id:'s'},model('old.py',i.toString(16).repeat(64)));
  const log=state.features[key].lineageObservations;
  assert.equal(log.items.length,8);assert.equal(log.discarded,3);
});

test('legacy or unparsed models cannot fabricate source-bound history',()=>{
  for(const edit of [m=>delete m.generatedFrom.coverage,m=>m.generatedFrom.coverage[0].parsed=false,m=>m.nodes[0].source.source_sha256='c'.repeat(64)]) {
    const m=model();edit(m);const state=memory(m);
    assert.equal(state.features[m.featureKey].lineageObservations,undefined);
  }
});

test('corrupt retained observations fail before mutation',()=>{
  const m=model(),state=memory(m);state.features[m.featureKey].lineageObservations.items[0].anchor.entry='tampered.py';
  const before=structuredClone(state);
  assert.throws(()=>rememberFeature(state,{id:'new'},m),/observation/i);
  assert.deepEqual(state,before);
});

function view() {
  return {schema_version:'git-file-lineage-1',path:'new.py',matches:1,omitted:0,assessments:2,
    scope:'imported exact-blob relocation hypotheses; no identity or authority transfer',items:[{
      from:'old.py',to:'new.py',mode:'100644',blob:'1'.repeat(40),blob_sha256:sha,blob_bytes:42,
      event_id:'dwev_'+'2'.repeat(24),event_hash:'3'.repeat(64),commit:'4'.repeat(40),parent:'5'.repeat(40),tree:'6'.repeat(40),
      epistemic_status:'INFERRED',method:'unique-exact-regular-blob-first-parent-1',coverage:{
        before_files:1,after_files:1,excluded_before:0,excluded_after:0,removed:1,added:1,
        ambiguous_removed:0,ambiguous_added:0,unmatched_removed:0,unmatched_added:0,complete:true}}]};
}
function pair() {
  const a=model(),b=model('new.py'),state=memory(a);rememberFeature(state,{id:'other'},b);
  return {state,a:a.featureKey,b:b.featureKey};
}
const output=value=>({status:0,stdout:Buffer.from(JSON.stringify(value))});

test('Core relocation links two exact retained observations without changing state',()=>{
  const {state,a,b}=pair(),before=structuredClone(state);let calls=0;
  const result=queryFeatureLineage('.',state,a,b,{command:'/trusted/dw',run:(command,args,options)=>{
    calls++;assert.equal(command,'/trusted/dw');assert.deepEqual(args,['state','lineage','--path=new.py','--limit','100','--json']);
    assert.equal(options.timeout,3000);assert.equal(options.maxBuffer,512*1024);return output(view());
  }});
  assert.equal(calls,1);assert.equal(result.status,'available');assert.equal(result.links.length,1);
  assert.equal(result.links[0].source.event_hash,'3'.repeat(64));
  assert.equal(result.links[0].fromObservation,state.features[a].lineageObservations.items[0].id);
  assert.equal(result.transfersScores,false);assert.equal(result.transfersAssertionAuthority,false);
  assert.deepEqual(state,before);
  assert.match(renderFeatureLineage(result,'fr'),/Filiation de fonctionnalités/);
  assert.match(renderFeatureLineage(result,'en'),/Feature lineage/);
  assert.match(renderFeatureLineage(result,'fr'),/dwev_/);
});

test('hash mismatch, missing history and corruption cannot inherit feature memory',()=>{
  const {state,a,b}=pair();let calls=0;
  const run=()=>{calls++;const v=view();v.items[0].blob_sha256='f'.repeat(64);return output(v);};
  assert.equal(queryFeatureLineage('.',state,a,b,{command:'dw',run}).links.length,0);
  state.features[a].lineageObservations.items[0].snapshot.story.push('forged');
  assert.equal(queryFeatureLineage('.',state,a,b,{command:'dw',run}).reason,'invalid-feature-observations');
  delete state.features[a].lineageObservations;
  assert.equal(queryFeatureLineage('.',state,a,b,{command:'dw',run}).reason,'missing-source-bound-observations');
  assert.equal(calls,1);
});

test('consumer rejects altered schema, paths, authority, counts, identity and duplicate items',()=>{
  const changes=[v=>v.schema_version='future',v=>v.path='elsewhere.py',v=>v.items[0].from='../old.py',
    v=>v.items[0].epistemic_status='VERIFIED',v=>v.omitted=1,v=>v.items[0].coverage.complete=false,
    v=>v.items[0].coverage.removed=true,v=>v.items[0].coverage.unmatched_added=1,
    v=>v.items[0].commit='x',v=>v.items[0].event_hash='x',v=>v.items[0].mode='120000',
    v=>v.items[0].extra=true,v=>{v.items.push(structuredClone(v.items[0]));v.matches=2;}];
  for(const mutate of changes) {
    const v=view();mutate(v);assert.equal(validFileLineage(v,'new.py'),false);
    const {state,a,b}=pair();assert.equal(queryFeatureLineage('.',state,a,b,{command:'dw',run:()=>output(v)}).reason,'core-lineage-rejected');
  }
});

test('duplicate JSON, non-UTF8, oversize and failed processes are unavailable',()=>{
  const good=JSON.stringify(view());
  const responses=[{status:0,stdout:Buffer.from(good.replace('"matches":1','"matches":1,"matches":1'))},
    {status:0,stdout:Buffer.from([0xff])},{status:0,stdout:Buffer.alloc(512*1024+1)},
    {status:1,stdout:Buffer.from(good)},{status:null,error:new Error('timeout')},{status:0,stdout:good}];
  for(const response of responses) {
    const {state,a,b}=pair();assert.equal(queryFeatureLineage('.',state,a,b,{command:'dw',run:()=>response}).status,'unavailable');
  }
});

test('empty or incomplete imported views state coverage without claiming absence',()=>{
  const {state,a,b}=pair();const v=view();v.items=[];v.matches=0;
  const empty=queryFeatureLineage('.',state,a,b,{command:'dw',run:()=>output(v)});
  assert.equal(empty.status,'available');assert.equal(empty.links.length,0);
  assert.match(renderFeatureLineage(empty),/retained observations/);
  const partial=view();partial.items[0].coverage.excluded_before=1;partial.items[0].coverage.complete=false;
  const result=queryFeatureLineage('.',state,a,b,{command:'dw',run:()=>output(partial)});
  assert.equal(result.coverage.completeRetainedView,false);assert.match(renderFeatureLineage(result,'fr'),/limités/);
});

test('multiple retained snapshots are bounded without hiding omitted hypotheses',()=>{
  const {state,a,b}=pair();
  for(let i=1;i<8;i++) for(const file of ['old.py','new.py']) {
    const m=model(file);m.story.push({type:'file',role:'service',label:`related${i}.py`});
    rememberFeature(state,{id:'s'},m);
  }
  const result=queryFeatureLineage('.',state,a,b,{command:'dw',run:()=>output(view())});
  assert.equal(result.matches,64);assert.equal(result.links.length,32);assert.equal(result.omitted,32);
  assert.equal(result.coverage.completeRetainedView,false);
});

test('invalid and conflicting CLI options cannot trigger lineage work',()=>{
  for(const args of [[],['--from','x','--to','y'],['--list','--from','a'],['--list','--list'],
    ['--from','a','--from','b'],['--language','fr','--language','en'],['--language','zz'],['--unknown']])
    assert.throws(()=>featureLineageCli('.',{},args));
});
