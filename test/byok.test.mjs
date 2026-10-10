import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configureByok,byokStatus,removeByok,previewByok,interpretByok,testByokConnection} from '../src/byok.mjs';
import {loadCredential,byokDirectory,writeByok} from '../src/byok-storage.mjs';
import {createHash} from 'node:crypto';

const KEY='sk-or-v1-SYNTHETIC_DO_NOT_TRANSMIT_1234567890';
function fixture(t){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'byok-offline-fixture-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const dir=path.join(cwd,'.idleproof','project-scans');fs.mkdirSync(dir,{recursive:true});
  const sid='dwscan_'+'a'.repeat(64),model={schema:'idleproof.project-scan.v1',header:{snapshotId:sid,source:'HEAD',coverage:{inventoryEntries:1,read:1}},unknowns:['Execution UNKNOWN'],files:[{path:'logic.py',role:'production',sourceSha256:'b'.repeat(64),extraction:{parsed:true,symbols:[{qualified_name:'logic.compute',line:1,end_line:2}],description:{behaviors:[{symbol:'compute',line:1,clauses:[{kind:'return-expression',line:2,text:'value * 2'}]}],intent:[],dependencies:[]}}}]};
  fs.writeFileSync(path.join(dir,sid+'.json'),JSON.stringify(model));fs.writeFileSync(path.join(dir,'HEAD.json'),JSON.stringify({snapshotId:sid,root:fs.realpathSync(cwd),sha256:createHash('sha256').update(JSON.stringify(model)).digest('hex')}));
  configureByok(cwd,{model:'test/fixture',budgetUsd:1,maxRequestUsd:.1,maxTokens:100},KEY);
  return cwd;
}
const reply=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
function provider(log,{status=200,answer=null,cost=.0001}={}){
  return async(url,options)=>{
    log.push({url,method:options.method,body:options.body});
    assert.equal(options.headers.Authorization,'Bearer '+KEY);
    assert.equal(options.redirect,'error');
    if(url.endsWith('/models'))return reply({data:[{id:'test/fixture',supported_parameters:['structured_outputs'],pricing:{prompt:'0.000001',completion:'0.000002',request:'0'}}]});
    if(url.endsWith('/key'))return reply({data:{limit:1,limit_remaining:1}});
    if(status!==200)return new Response('credential must never be copied: '+KEY,{status});
    const payload=answer||{claims:[{text:'The supplied expression doubles its input.',citations:['S1']}],nextTests:[{text:'Test zero and negative inputs.',citations:['S1']}],unknowns:['Execution was not observed.']};
    return reply({model:'test/fixture',choices:[{message:{content:JSON.stringify(payload)}}],usage:{prompt_tokens:40,completion_tokens:30,cost}});
  };
}

test('credentials stay protected locally; status is secret-free and removal is local only',t=>{
  const cwd=fixture(t),dir=byokDirectory(cwd);
  assert.equal(loadCredential(cwd),KEY);
  assert.equal(JSON.stringify(byokStatus(cwd)).includes(KEY),false);
  if(process.platform==='win32')assert.equal(fs.readFileSync(path.join(dir,'credential.json'),'utf8').includes(KEY),false);
  else assert.equal(fs.statSync(path.join(dir,'credential.json')).mode&0o777,0o600);
  const result=removeByok(cwd);assert.equal(result.configured,false);assert.match(result.providerRevocation,/separately revoke/);
  assert.equal(fs.existsSync(path.join(dir,'credential.json')),false);
});
test('explicit scoped preview is required, successful interpretation is cached and non-normative',async t=>{
  const cwd=fixture(t),options={includeSource:true,paths:['logic.py']},preview=previewByok(cwd,options),log=[];
  assert.match(JSON.stringify(preview.packet),/value \* 2/);
  assert.equal(JSON.stringify(previewByok(cwd).packet).includes('value * 2'),false);
  await assert.rejects(interpretByok(cwd,options,{fetchImpl:provider(log)}),/CONSENT/);assert.equal(log.length,0);
  const accepted=await interpretByok(cwd,{...options,consentDigest:preview.digest},{fetchImpl:provider(log)});
  assert.equal(accepted.status,'INTERPRETATION');assert.equal(accepted.answer.proof,'UNKNOWN');assert.equal(accepted.answer.authority,'INFERRED');
  assert.equal(accepted.reportedCostUsd,.0001);
  assert.equal((await interpretByok(cwd,{...options,consentDigest:preview.digest},{fetchImpl:()=>{throw new Error('must not call');}})).cached,true);
  assert.equal(log.filter(x=>x.method==='POST').length,1);
  await assert.rejects(interpretByok(cwd,{...options,question:'Changed question',consentDigest:preview.digest},{fetchImpl:provider(log)}),/CONSENT/);
});
test('auth/rate failures and forged citations fail closed, retaining deterministic output and uncertainty reservation',async t=>{
  for(const status of [401,403,429]){
    const cwd=fixture(t),preview=previewByok(cwd);
    const result=await interpretByok(cwd,{consentDigest:preview.digest},{fetchImpl:provider([],{status})});
    assert.equal(result.status,'FALLBACK');assert.equal(result.code,`BYOK_HTTP_${status}`);assert.equal(result.deterministicAvailable,true);assert.equal(JSON.stringify(result).includes(KEY),false);
    assert.ok(byokStatus(cwd).reservedUsd>0);
  }
  const cwd=fixture(t),preview=previewByok(cwd);
  const result=await interpretByok(cwd,{consentDigest:preview.digest},{fetchImpl:provider([],{answer:{claims:[{text:'Invented',citations:['S999']}],nextTests:[],unknowns:[]}})});
  assert.equal(result.code,'BYOK_ANSWER_REJECTED');assert.equal(result.answer,null);
});
test('exhausted budget and offline requests make no paid attempt',async t=>{
  const cwd=fixture(t),preview=previewByok(cwd),log=[];
  writeByok(path.join(byokDirectory(cwd),'meter.json'),{schema:'idleproof.byok-meter.v1',reservedUsd:1});
  let result=await interpretByok(cwd,{consentDigest:preview.digest},{fetchImpl:provider(log)});
  assert.equal(result.code,'BYOK_BUDGET_EXHAUSTED');assert.equal(log.some(x=>x.method==='POST'),false);
  result=await interpretByok(cwd,{consentDigest:preview.digest},{fetchImpl:async()=>{throw new TypeError(KEY);}});
  assert.equal(result.code,'BYOK_UNAVAILABLE');assert.equal(JSON.stringify(result).includes(KEY),false);
});

test('provider cap, cancellation and explicit connection test never generate without consent',async t=>{
  const cwd=fixture(t),preview=previewByok(cwd),log=[];
  const controller=new AbortController();controller.abort();
  let result=await interpretByok(cwd,{consentDigest:preview.digest},{signal:controller.signal,fetchImpl:provider(log)});
  assert.equal(result.code,'BYOK_CANCELLED_OR_TIMEOUT');assert.equal(log.length,0);
  const original=provider(log);
  result=await interpretByok(cwd,{consentDigest:preview.digest},{fetchImpl:async(url,options)=>url.endsWith('/key')?reply({data:{limit:null,limit_remaining:100}}):original(url,options)});
  assert.equal(result.code,'BYOK_PROVIDER_CAP_REQUIRED');assert.equal(log.some(x=>x.method==='POST'),false);
  await assert.rejects(testByokConnection(cwd,{fetchImpl:provider(log)}),/CONSENT/);
  const connected=await testByokConnection(cwd,{allowNetwork:true,fetchImpl:provider(log)});
  assert.equal(connected.status,'CONNECTED');assert.equal(connected.paidGeneration,false);assert.equal(connected.contextTransmitted,false);
  assert.equal(log.some(x=>x.method==='POST'),false);
});

test('malformed and oversized paid responses fail closed and cannot silently be charged twice',async t=>{
  const cwd=fixture(t);
  for(const [question,body,expected] of [['invalid','not-json','BYOK_INVALID_JSON'],['oversized','x'.repeat(128*1024+1),'BYOK_RESPONSE_BUDGET']]) {
    const options={question},preview=previewByok(cwd,options),log=[],original=provider(log);
    const result=await interpretByok(cwd,{...options,consentDigest:preview.digest},{fetchImpl:async(url,request)=>url.endsWith('/chat/completions')?new Response(body):original(url,request)});
    assert.equal(result.code,expected);assert.equal(result.answer,null);assert.ok(result.reservedUsd>0);
    const cached=await interpretByok(cwd,{...options,consentDigest:preview.digest},{fetchImpl:()=>{throw new Error('No retry authorized');}});
    assert.equal(cached.cached,true);assert.equal(cached.code,expected);
  }
});
