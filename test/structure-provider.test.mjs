import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectPaths } from '../src/paths.mjs';
import { loadPythonExtractions, validPythonExtractions } from '../src/structure-provider.mjs';

const source={relative:'src/a.py',text:'def actual():\n    return 1\n'};
source.sha256=createHash('sha256').update(source.text).digest('hex');
const response=()=>({schema_version:'structure-response-1',files:[{
  schema_version:'structure-extraction-1',path:source.relative,language:'python',provider:'python-ast',
  source_sha256:source.sha256,module:'src.a',parsed:true,
  symbols:[{qualified_name:'src.a.actual',kind:'function',line:1,end_line:2,epistemic_status:'OBSERVED',local_call_name:'actual'}],
  imports:[],calls:[]}],coverage:{files:1,parsed:1,unsupported:0,unparsed:0}});
const load=(value,run)=>loadPythonExtractions('.', [source], {command:'exact-dw',
  run:run||(()=>({status:0,stdout:Buffer.from(JSON.stringify(value))}))});

test('consumer checks source binding, ordered coverage, provider and authority',()=>{
  assert.equal(validPythonExtractions(response(),[source]),true);
  for(const mutate of [
    v=>v.files[0].source_sha256='0'.repeat(64),v=>v.files[0].path='src/other.py',
    v=>v.files[0].provider='invented',v=>v.files[0].language='typescript',v=>v.files[0].module='outside',
    v=>v.files[0].symbols[0].epistemic_status='VERIFIED',v=>v.files[0].symbols[0].line=0,
    v=>v.files[0].symbols[0].end_line=400,v=>v.files[0].symbols[0].line=true,
    v=>v.files[0].imports=[{target:'a',epistemic_status:'VERIFIED'}],
    v=>v.files[0].calls=[{name:'actual',line:1,epistemic_status:'OBSERVED'}],
    v=>v.files[0].parsed=false,v=>v.coverage.parsed=0,v=>v.files.push(v.files[0]),
    v=>v.files[0].source='private content',v=>v.extra=true
  ]) {
    const value=response();mutate(value);
    assert.equal(validPythonExtractions(value,[source]),false);
    assert.equal(load(value).reason,'core-extraction-rejected');
  }
});

test('one bounded source-byte batch uses argv and never a shell',()=>{
  let calls=0;
  const result=load(response(),(command,args,options)=>{
    calls+=1;
    assert.equal(command,'exact-dw');
    assert.deepEqual(args,['state','extract','--json']);
    assert.equal(options.shell,undefined);
    assert.equal(options.timeout,500);
    const request=JSON.parse(options.input);
    assert.equal(Buffer.from(request.files[0].content_base64,'base64').toString(),source.text);
    return {status:0,stdout:Buffer.from(JSON.stringify(response()))};
  });
  assert.equal(calls,1);assert.equal(result.byPath.get(source.relative).symbols[0].qualified_name,'src.a.actual');
});

test('failure, timeout, malformed JSON, duplicate fields and invalid UTF-8 fail closed',()=>{
  for(const result of [
    {status:2,stdout:Buffer.from('{}')},{error:new Error('timeout'),status:null},
    {status:0,stdout:Buffer.from('{broken')},
    {status:0,stdout:Buffer.from(JSON.stringify(response()).replace('"parsed":true','"parsed":false,"parsed":true'))},
    {status:0,stdout:Buffer.concat([Buffer.from(JSON.stringify(response())),Buffer.from([0xff])])}
  ]) assert.equal(load(null,()=>result).byPath.size,0);
});

test('unparsed provider result stays empty and caller mutation cannot be reused',()=>{
  const value=response();value.files[0].parsed=false;value.files[0].symbols=[];
  value.coverage.parsed=0;value.coverage.unparsed=1;
  assert.equal(load(value).byPath.get(source.relative).parsed,false);
  const first=load(response());first.byPath.get(source.relative).symbols[0].qualified_name='invented';
  assert.equal(load(response()).byPath.get(source.relative).symbols[0].qualified_name,'src.a.actual');
});

test('invalid source input cannot invoke the provider',()=>{
  for(const sources of [[{...source,sha256:'invalid'}],[{...source,relative:'../escape.py'}],[source,source],
                       [{...source,text:'x'.repeat(128*1024+1)}],Array(65).fill(source)]) {
    let calls=0;
    const result=loadPythonExtractions('.',sources,{command:'exact-dw',run:()=>{calls+=1;throw new Error('must not run');}});
    assert.equal(calls,0);assert.equal(result.byPath.size,0);
  }
});

test('advisory extraction can read a legacy command without migrating configuration',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-extract-config-'));
  try {
    const paths=projectPaths(cwd);
    fs.mkdirSync(path.dirname(paths.defitnessConfigLegacy),{recursive:true});
    const before=JSON.stringify({schema:'defitness.project-config.v1',diffWitnessCommand:'legacy-dw',adapters:['codex'],requireDiffWitness:true});
    fs.writeFileSync(paths.defitnessConfigLegacy,before);
    const result=loadPythonExtractions(cwd,[source],{run:(command)=>{
      assert.equal(command,'legacy-dw');return {status:0,stdout:Buffer.from(JSON.stringify(response()))};
    }});
    assert.equal(result.byPath.size,1);
    assert.equal(fs.existsSync(paths.diffwitnessConfig),false);
    assert.equal(fs.readFileSync(paths.defitnessConfigLegacy,'utf8'),before);
  } finally { fs.rmSync(cwd,{recursive:true,force:true}); }
});
