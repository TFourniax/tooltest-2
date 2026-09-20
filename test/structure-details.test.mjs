import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validStructureExtractions,loadStructureExtractions} from '../src/structure-provider.mjs';
const source={relative:'pkg/__init__.py',text:'from .child import run\n'};
source.sha256=createHash('sha256').update(source.text).digest('hex');
const response=()=>({schema_version:'structure-response-2',files:[{schema_version:'structure-extraction-2',
 path:source.relative,language:'python',provider:'python-ast',source_sha256:source.sha256,module:'pkg',parsed:true,
 symbols:[],calls:[],imports:[{target:'pkg.child',epistemic_status:'OBSERVED',source_target:'.child',members:['run'],line:1,end_line:1}]}],
 coverage:{files:1,parsed:1,unparsed:0,unsupported:0}});
test('details are explicitly requested and strictly admitted without changing v1 defaults',()=>{
 assert.equal(validStructureExtractions(response(),[source],{details:true}),true);
 assert.equal(validStructureExtractions(response(),[source]),false);
 const value=loadStructureExtractions('.',[source],{command:'exact-dw',details:true,timeoutMs:123,run:(cmd,args,options)=>{
  assert.equal(JSON.parse(options.input).schema_version,'structure-request-2');assert.equal(options.timeout,123);
  return {status:0,stdout:Buffer.from(JSON.stringify(response()))};
 }});
 assert.equal(value.byPath.size,1);assert.deepEqual(value.byPath.get(source.relative).imports[0].members,['run']);
});
test('v2 rejects forged source detail, authority, schema and widened time budgets',()=>{
 for(const mutate of [i=>i.line=0,i=>i.line=true,i=>i.end_line=4,i=>i.members='run',i=>i.members=[4],
                     i=>i.source_target=[],i=>i.epistemic_status='VERIFIED',i=>i.extra='invented']){
  const value=response();mutate(value.files[0].imports[0]);
  assert.equal(validStructureExtractions(value,[source],{details:true}),false);
 }
 const unknown=response();Object.assign(unknown.files[0].imports[0],{source_target:null,members:null,line:null,end_line:null});
 assert.equal(validStructureExtractions(unknown,[source],{details:true}),true);
 for(const timeoutMs of [0,501,Infinity,NaN,'5']){
  let calls=0;const value=loadStructureExtractions('.',[source],{details:true,timeoutMs,run:()=>{calls++;}});
  assert.equal(value.byPath.size,0);assert.equal(calls,0);
 }
});
