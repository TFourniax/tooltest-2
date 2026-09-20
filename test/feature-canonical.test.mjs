import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildFeatureModel} from '../src/feature-model.mjs';
import {cachedFeatureModel} from '../src/feature-memory.mjs';

function project(t,files){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-canonical-feature-'));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 for(const [name,text]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(cwd,name)),{recursive:true});fs.writeFileSync(path.join(cwd,name),text);}
 return cwd;
}
const ref=(target,source_target=null,members=null)=>({target,source_target,members,line:1,end_line:1,epistemic_status:'OBSERVED'});
function producer(values={},batches=[]){return {command:'fixture-core',run:(command,args,options)=>{
 const request=JSON.parse(options.input);assert.equal(request.schema_version,'structure-request-2');assert.ok(options.timeout>0&&options.timeout<=500);
 batches.push(request.files.map(f=>f.path));
 const files=request.files.map(f=>{
  const language=f.path.endsWith('.py')?'python':f.path.endsWith('.json')?'json':'javascript';
  const bytes=Buffer.from(f.content_base64,'base64');
  return {schema_version:'structure-extraction-2',path:f.path,language,provider:language==='python'?'python-ast':'tree-sitter-'+language,
   module:language==='python'?f.path.slice(0,-3).replace(/\/?__init__$/,'').replaceAll('/','.'):f.path,
   source_sha256:createHash('sha256').update(bytes).digest('hex'),parsed:true,symbols:[],imports:[],calls:[],...values[f.path]};
 });
 return {status:0,stdout:Buffer.from(JSON.stringify({schema_version:'structure-response-2',files,coverage:{files:files.length,parsed:files.filter(f=>f.parsed).length,unparsed:files.filter(f=>!f.parsed).length,unsupported:0}}))};
}};}

test('canonical feature imports ignore comment/string decoys and cite the exact bytes',t=>{
 const text="// import './invented.js';\nconst bait=\"import './invented.js'\";\nimport './actual.js';\n";
 const cwd=project(t,{'entry.js':text,'actual.js':'export const value=1;','invented.js':'export const wrong=1;'});
 const batches=[];const model=buildFeatureModel(cwd,{currentResource:'entry.js'},{structureOptions:producer({'entry.js':{imports:[{...ref('./actual.js'),line:3,end_line:3}]}},batches)});
 assert.ok(model.nodes.some(n=>n.label==='actual.js'));assert.ok(!model.nodes.some(n=>n.label==='invented.js'));
 const edge=model.edges.find(e=>e.kind==='imports');assert.equal(edge.epistemic_status,'INFERRED');assert.equal(edge.source.line,3);
 assert.equal(edge.source.source_sha256,createHash('sha256').update(text).digest('hex'));
 assert.deepEqual(batches,[['entry.js'],['actual.js']]);assert.equal(model.references[0].epistemic_status,'OBSERVED');
});

test('configuration values never create feature facts, including unavailable or rejected Core',t=>{
 const cwd=project(t,{'settings.json':JSON.stringify({value:"import './invented.js'; Stripe CREATE TABLE invented (id int); /api/private-value"}),'invented.js':''});
 for(const options of [producer(),{command:'missing',run:()=>({status:127})},{command:'broken',run:()=>({status:0,stdout:Buffer.from('{}')})}]){
  const model=buildFeatureModel(cwd,{currentResource:'settings.json'},{structureOptions:options});
  assert.deepEqual(model.surfaces,{routes:[],tables:[],technologies:[]});assert.equal(model.edges.length,0);
  assert.ok(!JSON.stringify(model).includes('private-value'));assert.ok(!JSON.stringify(model).includes('invented.js'));
  assert.equal(model.generatedFrom.coverage.length,1);
 }
});

test('Python package references preserve members without inventing member-module edges or resolving ambiguity',t=>{
 const cwd=project(t,{'pkg/__init__.py':'from .child import run\n','pkg/child.py':'def run(): pass\n','pkg/child/run.py':'',
  'entry.py':'import duplicate\n','duplicate.py':'','duplicate/__init__.py':'','escape.py':'from ..outside import secret\n'});
 const values={'pkg/__init__.py':{imports:[ref('pkg.child','.child',['run'])]},'entry.py':{imports:[ref('duplicate','duplicate',[])]},'escape.py':{imports:[ref('..outside','..outside',['secret'])]}};
 const model=buildFeatureModel(cwd,{currentResource:'pkg/__init__.py',touchedFiles:['entry.py','escape.py']},{structureOptions:producer(values)});
 assert.ok(model.nodes.some(n=>n.label==='pkg/child.py'));assert.ok(!model.nodes.some(n=>n.label==='pkg/child/run.py'));
 assert.ok(!model.edges.some(e=>e.to==='file:duplicate.py'||e.to==='file:duplicate/__init__.py'));
 const reference=model.references.find(r=>r.target==='pkg.child');assert.deepEqual(reference.members,['run']);assert.equal(reference.source_target,'.child');
 assert.equal(model.references.find(r=>r.target==='duplicate').resolution,'unresolved');
 assert.equal(model.references.find(r=>r.target==='..outside').resolution,'unresolved');
});

test('canonical unparsed/rejected source cannot resurrect legacy import guesses',t=>{
 const cwd=project(t,{'entry.js':"import './invented.js';",'invented.js':''});
 for(const options of [producer({'entry.js':{parsed:false}}),{command:'broken',run:()=>({status:0,stdout:Buffer.from('{}')})}]){
  const model=buildFeatureModel(cwd,{currentResource:'entry.js'},{structureOptions:options});
  assert.equal(model.edges.length,0);assert.equal(model.generatedFrom.coverage[0].parsed,false);
 }
});

test('relative Python imports beyond the lexical package stay unresolved even when a same-name file exists',t=>{
 const cwd=project(t,{'root.py':'from .outside import value\n','pkg/entry.py':'from ..outside import value\n',
  'outside.py':'value=1\n','pkg/sub/entry.py':'from ..valid import value\n','pkg/valid.py':'value=2\n'});
 const values={'root.py':{imports:[ref('.outside','.outside',['value'])]},
  'pkg/entry.py':{imports:[ref('..outside','..outside',['value'])]},
  'pkg/sub/entry.py':{imports:[ref('pkg.valid','..valid',['value'])]}};
 const model=buildFeatureModel(cwd,{currentResource:'root.py',touchedFiles:['pkg/entry.py','pkg/sub/entry.py']},{structureOptions:producer(values)});
 for(const target of ['.outside','..outside']) assert.equal(model.references.find(r=>r.target===target).resolution,'unresolved');
 assert.ok(!model.edges.some(e=>e.to==='file:outside.py'));
 assert.ok(model.edges.some(e=>e.to==='file:pkg/valid.py'));
});

test('JavaScript local candidates include CTS and MTS ambiguity without guessing Python extensions',t=>{
 const cwd=project(t,{'entry.js':'import "./worker"; import "./python"; import "./only";\n',
  'worker.js':'','worker.mts':'','python.py':'','only.cts':''});
 const values={'entry.js':{imports:[ref('./worker'),ref('./python'),ref('./only')]},
  'only.cts':{language:'typescript',provider:'tree-sitter-typescript'}};
 const model=buildFeatureModel(cwd,{currentResource:'entry.js'},{structureOptions:producer(values)});
 assert.equal(model.references.find(r=>r.target==='./worker').resolution,'unresolved');
 assert.equal(model.references.find(r=>r.target==='./python').resolution,'unresolved');
 assert.equal(model.references.find(r=>r.target==='./only').localPath,'only.cts');
});

test('fresh feature models see same-size timestamp-preserved edits and cannot share caller mutation',t=>{
 const cwd=project(t,{'entry.js':'export const value=1;'});const session={id:'same-event',lastEventAt:'unchanged',currentResource:'entry.js'};
 const before=cachedFeatureModel(cwd,session);const file=path.join(cwd,'entry.js'),stamp=fs.statSync(file);
 before.nodes[0].label='caller corruption';before.surfaces.routes.push('/caller');
 const detached=cachedFeatureModel(cwd,session);assert.ok(!JSON.stringify(detached).includes('caller'));
 fs.writeFileSync(file,'export const value=2;');fs.utimesSync(file,stamp.atime,stamp.mtime);assert.equal(fs.statSync(file).size,stamp.size);
 const after=cachedFeatureModel(cwd,session);assert.notEqual(after.fingerprint,detached.fingerprint);
});

test('canonical breadth and depth remain bounded and source exclusions still apply',t=>{
 const files={};const values={};
 for(let i=0;i<30;i++){files[`f${i}.js`]='export const x=1;';values[`f${i}.js`]={imports:[ref(`./f${i+1}.js`)]};}
 files['node_modules/secret.js']='';files['entry.js']="import './node_modules/secret.js';";values['entry.js']={imports:[ref('./node_modules/secret.js')]};
 const cwd=project(t,files);const batches=[];
 const model=buildFeatureModel(cwd,{currentResource:'f0.js',touchedFiles:['entry.js']},{structureOptions:producer(values,batches)});
 assert.equal(batches.length,3);assert.ok(model.generatedFrom.filesInspected<=24);assert.ok(model.generatedFrom.bytesInspected<=640*1024);
 assert.ok(model.nodes.some(n=>n.label==='f2.js'));assert.ok(!model.nodes.some(n=>n.label==='f3.js'||n.label.includes('node_modules')));
});

test('a changed canonical symbol projection changes the model fingerprint on identical bytes',t=>{
 const cwd=project(t,{'settings.json':'{"actual":1}'});const session={currentResource:'settings.json'};
 const missing=buildFeatureModel(cwd,session,{structureOptions:producer()});
 const complete=buildFeatureModel(cwd,session,{structureOptions:producer({'settings.json':{symbols:[{
  qualified_name:'settings.json::/actual',kind:'config-key',line:1,end_line:1,epistemic_status:'OBSERVED',local_call_name:null
 }]}})});
 assert.notEqual(complete.fingerprint,missing.fingerprint);
});
