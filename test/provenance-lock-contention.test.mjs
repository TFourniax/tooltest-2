import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendProvenanceEvent,verifyProvenanceChain} from '../src/provenance.mjs';
import {projectPaths} from '../src/paths.mjs';

function fixture(t) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-provenance-lock-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  return {cwd,paths:projectPaths(cwd)};
}

test('provenance acquisition tolerates released-lock access errors without dropping or duplicating the event',t=>{
  const {cwd,paths}=fixture(t);
  const original=fs.mkdirSync,codes=['EPERM','EACCES','EBUSY'];let attempts=0;
  t.mock.method(fs,'mkdirSync',function(file,...args){
    if(file===paths.provenanceLock&&attempts++<codes.length){
      assert.equal(fs.existsSync(file),false);
      throw Object.assign(new Error('synthetic released-lock race'),{code:codes[attempts-1]});
    }
    return original.call(this,file,...args);
  });
  const record=appendProvenanceEvent({cwd,session_id:'preserved',hook_event_name:'PreToolUse',tool_name:'Read'});
  assert.equal(attempts,4);assert.equal(record.sequence,1);
  const chain=verifyProvenanceChain(cwd);
  assert.equal(chain.ok,true);assert.equal(chain.length,1);
  assert.equal(fs.existsSync(paths.provenanceLock),false);
});

test('permanent provenance lock denial stops at the existing 30s deadline without appending',t=>{
  const {cwd,paths}=fixture(t);const original=fs.mkdirSync;let now=100000,attempts=0;
  t.mock.method(Date,'now',()=>now+=1000);
  t.mock.method(fs,'mkdirSync',function(file,...args){
    if(file===paths.provenanceLock){attempts++;throw Object.assign(new Error('synthetic denial'),{code:'EACCES'});}
    return original.call(this,file,...args);
  });
  assert.throws(()=>appendProvenanceEvent({cwd}),/stayed busy for 30s/);
  assert.ok(attempts>1);assert.equal(fs.existsSync(paths.events),false);assert.equal(fs.existsSync(paths.chain),false);
});

test('permanent storage failures are not retried or recorded as a successful append',t=>{
  const {cwd,paths}=fixture(t);const original=fs.mkdirSync;let attempts=0;
  t.mock.method(fs,'mkdirSync',function(file,...args){
    if(file===paths.provenanceLock){attempts++;throw Object.assign(new Error('synthetic full disk'),{code:'ENOSPC'});}
    return original.call(this,file,...args);
  });
  assert.throws(()=>appendProvenanceEvent({cwd}),{code:'ENOSPC'});
  assert.equal(attempts,1);assert.equal(fs.existsSync(paths.events),false);
});
