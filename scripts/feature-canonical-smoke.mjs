import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildFeatureModel} from '../src/feature-model.mjs';
import {cachedFeatureModel} from '../src/feature-memory.mjs';

const optional=!process.argv.includes('--without-grammars');
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-feature-canonical-'));
const put=(name,text)=>{fs.mkdirSync(path.dirname(path.join(cwd,name)),{recursive:true});fs.writeFileSync(path.join(cwd,name),text);};
try{
 const entry="// import './invented.js';\nconst text=\"import './invented.js'\";\nimport './actual.js';\n";
 put('entry.js',entry);put('actual.js','export const run=()=>1;');put('invented.js','export const fake=1;');
 const js=buildFeatureModel(cwd,{currentResource:'entry.js'});
 assert.equal(js.generatedFrom.coverage[0].canonical,true);
 assert.equal(js.generatedFrom.coverage[0].parsed,optional);
 assert.ok(!js.nodes.some(n=>n.label==='invented.js'));
 if(optional){
  const edge=js.edges.find(e=>e.kind==='imports');assert.equal(edge.to,'file:actual.js');assert.equal(edge.epistemic_status,'INFERRED');
  assert.equal(edge.source.line,3);assert.equal(edge.source.source_sha256,createHash('sha256').update(entry).digest('hex'));
 }else assert.equal(js.edges.length,0);
 put('loader.cjs',"const first=require('./worker.cjs');\nconst second=import('./later.mjs');\n");
 put('worker.cjs','module.exports = 1;');put('later.mjs','export default 1;');put('ignored.cjs','module.exports = 2;');
 const loader=buildFeatureModel(cwd,{currentResource:'loader.cjs'});
 assert.equal(loader.generatedFrom.coverage[0].canonical,true);assert.equal(loader.generatedFrom.coverage[0].parsed,optional);
 assert.deepEqual(loader.references.map(r=>r.target),optional?['./worker.cjs','./later.mjs']:[]);
 if(optional){assert.ok(loader.edges.filter(e=>e.kind==='imports').every(e=>e.epistemic_status==='INFERRED'));assert.ok(loader.nodes.some(n=>n.label==='worker.cjs'));}
 put('shadowed.cjs',"function require(x) {return x;} require('./ignored.cjs'); import('./later.mjs');");
 const shadowed=buildFeatureModel(cwd,{currentResource:'shadowed.cjs'});
 assert.ok(!shadowed.nodes.some(n=>n.label==='ignored.cjs'));
 assert.deepEqual(shadowed.references.map(r=>r.target),optional?['./later.mjs']:[]);
 put('escaped.cjs',String.raw`\u0065val("var require = custom"); require('./ignored.cjs'); import('./later.mjs');`);
 const escaped=buildFeatureModel(cwd,{currentResource:'escaped.cjs'});
 assert.deepEqual(escaped.references.map(r=>r.target),optional?['./later.mjs']:[]);
 assert.ok(!escaped.nodes.some(n=>n.label==='ignored.cjs'));
 put('pkg/__init__.py','from .child import run as local\n');put('pkg/child.py','def run(): return 1\n');put('pkg/child/run.py','raise RuntimeError("must not execute")\n');
 put('duplicate.py','');put('duplicate/__init__.py','');put('entry.py','import duplicate\nfrom ..outside import secret\n');
 const py=buildFeatureModel(cwd,{currentResource:'pkg/__init__.py',touchedFiles:['entry.py']});
 assert.ok(py.generatedFrom.coverage.every(c=>c.canonical&&c.parsed));
 assert.ok(py.nodes.some(n=>n.label==='pkg/child.py'));assert.ok(!py.nodes.some(n=>n.label==='pkg/child/run.py'));
 const ref=py.references.find(r=>r.target==='pkg.child');assert.equal(ref.source_target,'.child');assert.deepEqual(ref.members,['run']);
 assert.equal(ref.epistemic_status,'OBSERVED');assert.equal(ref.source.line,1);
 assert.equal(py.references.find(r=>r.target==='duplicate').resolution,'unresolved');
 assert.equal(py.references.find(r=>r.target==='..outside').resolution,'unresolved');
 put('outside.py','value=1\n');put('root.py','from .outside import value\n');put('pkg/escape.py','from ..outside import value\n');
 const relative=buildFeatureModel(cwd,{currentResource:'root.py',touchedFiles:['pkg/escape.py']});
 assert.ok(relative.references.every(r=>r.resolution==='unresolved'));
 assert.ok(!relative.edges.some(e=>e.to==='file:outside.py'));
 const fixtures=[['settings.json',JSON.stringify({'a.b':'Stripe CREATE TABLE invented (id int); /api/private-value'}),'/a.b'],
  ['settings.toml','"a.b" = "Stripe CREATE TABLE invented (id int); /api/private-value"\n','/a.b'],
  ['settings.yaml','a.b: "Stripe CREATE TABLE invented (id int); /api/private-value"\n','/@0/a.b'],
  ['schema.sql',"CREATE TABLE public.actual (id int); SELECT 'CREATE TABLE invented (id int)';",'public.actual']];
 for(const [name,text,symbol]of fixtures){
  put(name,text);const model=buildFeatureModel(cwd,{currentResource:name});
  assert.equal(model.generatedFrom.coverage[0].canonical,true,name);assert.equal(model.generatedFrom.coverage[0].parsed,optional,name);
  assert.deepEqual(model.surfaces.routes,[]);assert.deepEqual(model.surfaces.technologies,[]);
  assert.deepEqual(model.surfaces.tables,optional&&name==='schema.sql'?['public.actual']:[]);
  assert.ok(!JSON.stringify(model).includes('private-value'));
  assert.equal(model.symbols.some(s=>s.qualified_name===name+'::'+symbol),optional,name);
 }
 const session={id:'same',lastEventAt:'same',currentResource:'settings.json'};
 const before=cachedFeatureModel(cwd,session),file=path.join(cwd,'settings.json'),stamp=fs.statSync(file);
 before.nodes[0].label='caller pollution';assert.ok(!JSON.stringify(cachedFeatureModel(cwd,session)).includes('caller pollution'));
 put('settings.json',fs.readFileSync(file,'utf8').replace('a.b','c.d'));fs.utimesSync(file,stamp.atime,stamp.mtime);
 const after=cachedFeatureModel(cwd,session);assert.notEqual(after.fingerprint,before.fingerprint);
 put('settings.json','{"nested":[{"overflow":1e999}]}');const overflow=buildFeatureModel(cwd,session);
 assert.equal(overflow.generatedFrom.coverage[0].canonical,true);assert.equal(overflow.generatedFrom.coverage[0].parsed,false);assert.deepEqual(overflow.symbols,[]);
 const missing=buildFeatureModel(cwd,{currentResource:'settings.yaml'},{structureOptions:{command:path.join(cwd,'missing-dw')}});
 assert.equal(missing.generatedFrom.coverage[0].canonical,false);assert.deepEqual(missing.surfaces,{routes:[],tables:[],technologies:[]});assert.deepEqual(missing.symbols,[]);
 assert.ok(!fs.existsSync(path.join(cwd,'.diffwitness'))&&!fs.existsSync(path.join(cwd,'.idleproof')),'no source persistence');
 console.log(JSON.stringify({schema:'idleproof-feature-canonical-smoke-1',passed:true,actual_optional_grammars:optional,classification:'MACHINE'}));
}finally{fs.rmSync(cwd,{recursive:true,force:true});}
