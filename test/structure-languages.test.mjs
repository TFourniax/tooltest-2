import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as provider from '../src/structure-provider.mjs';

const specs=[['service.ts','typescript','tree-sitter-typescript'],['View.jsx','javascript','tree-sitter-javascript'],
             ['service.go','go','tree-sitter-go'],['service.rs','rust','tree-sitter-rust'],
             ['A.java','java','tree-sitter-java'],['A.kt','kotlin','tree-sitter-kotlin'],['A.cs','csharp','tree-sitter-c-sharp'],
             ['a.rb','ruby','tree-sitter-ruby'],['a.php','php','tree-sitter-php'],['a.sql','sql','tree-sitter-sql'],
             ['a.json','json','tree-sitter-json'],['a.toml','toml','tree-sitter-toml'],['a.yaml','yaml','tree-sitter-yaml']];
const sources=specs.map(([relative])=>({relative,text:'actual\n',sha256:createHash('sha256').update('actual\n').digest('hex')}));
function response(){return {schema_version:'structure-response-1',files:specs.map(([path,language,producer],i)=>({
  schema_version:'structure-extraction-1',path,language,provider:producer,module:path,source_sha256:sources[i].sha256,
  parsed:true,symbols:[{qualified_name:`${path}::actual`,kind:'function',line:1,end_line:1,
    epistemic_status:'OBSERVED',local_call_name:'actual'}],imports:[],calls:[]})),
  coverage:{files:specs.length,parsed:specs.length,unsupported:0,unparsed:0}};}

test('shared consumer admits mixed canonical languages in one bounded batch',()=>{
  const value=response();assert.equal(provider.validStructureExtractions(value,sources),true);
  let count=0;
  const result=provider.loadStructureExtractions('.',sources,{command:'exact-dw',run:(command,args,options)=>{
    count++;assert.equal(command,'exact-dw');assert.deepEqual(args,['state','extract','--json']);
    assert.equal(options.timeout,500);assert.equal(options.shell,undefined);
    assert.deepEqual(JSON.parse(options.input).files.map(file=>file.path),sources.map(source=>source.relative));
    return {status:0,stdout:Buffer.from(JSON.stringify(value))};
  }});
  assert.equal(count,1);assert.equal(result.byPath.size,specs.length);
});

test('mixed batch cannot change language, provider, module, path, hash or authority',()=>{
  for(const mutate of [v=>v.files.reverse(),v=>v.files[0].language='python',v=>v.files[0].provider='python-ast',
    v=>v.files[0].module='elsewhere',v=>v.files[0].source_sha256='0'.repeat(64),
    v=>v.files[0].symbols[0].qualified_name='elsewhere.ts::actual',
    v=>v.files[1].symbols[0].epistemic_status='VERIFIED',v=>v.files[2].parsed=false,
    v=>v.files[3].calls=[{name:'actual',line:1,epistemic_status:'OBSERVED'}]]) {
    const value=response();mutate(value);assert.equal(provider.validStructureExtractions(value,sources),false);
    const result=provider.loadStructureExtractions('.',sources,{command:'exact-dw',run:()=>({status:0,stdout:Buffer.from(JSON.stringify(value))})});
    assert.equal(result.byPath.size,0);
  }
});

test('optional unparsed syntax remains empty; unsupported source never invokes Core',()=>{
  const value=response();for(const file of value.files){file.parsed=false;file.symbols=[];}
  value.coverage.parsed=0;value.coverage.unparsed=specs.length;
  assert.equal(provider.validStructureExtractions(value,sources),true);
  let calls=0;const result=provider.loadStructureExtractions('.',[{...sources[0],relative:'notes.txt'}],
    {command:'exact-dw',run:()=>{calls++;throw Error('unexpected');}});
  assert.equal(calls,0);assert.equal(result.byPath.size,0);
  for(const extension of ['js','jsx','mjs','cjs','ts','tsx','mts','cts','go','rs','py','java','kt','kts','cs','rb','php','sql','json','toml','yaml','yml'])
    assert.equal(provider.supportsStructurePath(`a.${extension}`),true);
  assert.equal(provider.supportsStructurePath('a.txt'),false);
  for(const relative of ['.py','folder/.ts','a.TS',42,null])
    assert.equal(provider.supportsStructurePath(relative),false);
});
