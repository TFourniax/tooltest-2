import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {featureKey,rememberFeature} from '../src/feature-memory.mjs';
import {freshState,saveState,loadState,mutateState} from '../src/state.mjs';
import {readFeatureHistory,readFeatureObservation,featureHistoryCli} from '../src/feature-history.mjs';

const bin=path.resolve('bin/idleproof.mjs');
function model(index) {
  const source=createHash('sha256').update(String(index)).digest('hex'), file='service.py';
  const result={fingerprint:source.slice(0,24),generatedFrom:{filesInspected:1,coverage:[{path:file,source_sha256:source,canonical:true,parsed:true}]},
    nodes:[{type:'file',label:file,source:{path:file,source_sha256:source}}],story:[{type:'file',label:file,role:'core'}],
    surfaces:{routes:[],tables:[],technologies:[]},tests:[]};
  result.featureKey=featureKey(result);return result;
}
function cli(cwd,args){const r=spawnSync(process.execPath,[bin,'feature-history',...args,'--json'],{cwd,encoding:'utf8',timeout:10000});return r;}

test('saved history beyond eight observations survives restart and cursor traversal',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-history-'));
  try {
    const state=freshState(cwd),key=model(0).featureKey, expected=[];
    // Multiple observations before one save must not silently disappear either.
    for(let i=0;i<12;i++){rememberFeature(state,{id:'fixture'},model(i));expected.push(state.features[key].lineageObservations.items.at(-1));}
    state.features[key].confidence=0.91;saveState(cwd,state);
    const bytes=fs.readFileSync(path.join(cwd,'.idleproof','state.json'));
    assert.equal(loadState(cwd).features[key].lineageObservations.items.length,8);
    const found=[];let after=null;
    do {
      const r=cli(cwd,['--feature',key,'--limit','5',...(after?['--after',after]:[])]);
      assert.equal(r.status,0,r.stderr);const value=JSON.parse(r.stdout);
      assert.equal(value.order,'observation-id');assert.equal(value.olderHistory,'unknown');
      found.push(...value.items);after=value.next;
    } while(after);
    assert.deepEqual(found.sort((a,b)=>a.id.localeCompare(b.id)),expected.sort((a,b)=>a.id.localeCompare(b.id)));
    assert.deepEqual(fs.readFileSync(path.join(cwd,'.idleproof','state.json')),bytes);
    assert.equal(loadState(cwd).features[key].confidence,0.91);
  } finally {fs.rmSync(cwd,{recursive:true,force:true});}
});


test('legacy migration preserves retained IDs, original backup and missing-history counters',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-history-legacy-'));
  try {
    const state=freshState(cwd),key=model(0).featureKey;
    for(let i=0;i<12;i++)rememberFeature(state,{id:'fixture'},model(i));
    fs.mkdirSync(path.join(cwd,'.idleproof'));
    const original=JSON.stringify(state,null,2)+'\n';fs.writeFileSync(path.join(cwd,'.idleproof','state.json'),original);
    const loaded=loadState(cwd), retained=structuredClone(loaded.features[key].lineageObservations);
    saveState(cwd,loaded);
    assert.equal(fs.readFileSync(path.join(cwd,'.idleproof','state.json.bak'),'utf8'),original);
    assert.deepEqual(loadState(cwd).features[key].lineageObservations,retained);
    const history=readFeatureHistory(cwd,key);
    assert.equal(history.items.length,8);assert.equal(history.olderHistory,'unknown');
    const files=history.items.map(item=>path.join(cwd,'.idleproof','feature-observations',key,item.id+'.json'));
    const stamps=files.map(file=>fs.statSync(file).mtimeMs);
    saveState(cwd,loadState(cwd));
    assert.deepEqual(files.map(file=>fs.statSync(file).mtimeMs),stamps);
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});

test('conflicting archive bytes are retained and stop writes without overwriting state',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-history-corrupt-'));
  try {
    const state=freshState(cwd),key=model(0).featureKey;rememberFeature(state,{id:'fixture'},model(0));saveState(cwd,state);
    const item=state.features[key].lineageObservations.items[0],file=path.join(cwd,'.idleproof','feature-observations',key,item.id+'.json');
    const bytes=fs.readFileSync(path.join(cwd,'.idleproof','state.json'));
    fs.writeFileSync(file,'{"corrupt":true}\n');
    assert.throws(()=>readFeatureHistory(cwd,key),/Corrupt/);
    rememberFeature(state,{id:'new'},model(1));
    assert.throws(()=>saveState(cwd,state),/Corrupt/);
    assert.equal(fs.readFileSync(file,'utf8'),'{"corrupt":true}\n');
    assert.deepEqual(fs.readFileSync(path.join(cwd,'.idleproof','state.json')),bytes);
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});

test('first upgraded mutation archives retained legacy rows before hot-window eviction',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-history-upgrade-'));
  try {
    const state=freshState(cwd),key=model(0).featureKey;
    for(let i=0;i<12;i++)rememberFeature(state,{id:'legacy'},model(i));
    fs.mkdirSync(path.join(cwd,'.idleproof'));
    const original=JSON.stringify(state,null,2)+'\n';fs.writeFileSync(path.join(cwd,'.idleproof','state.json'),original);
    const retained=structuredClone(loadState(cwd).features[key].lineageObservations);
    assert.equal(retained.items.length,8);assert.equal(retained.discarded,4);
    mutateState(cwd,loaded=>{rememberFeature(loaded,{id:'upgraded'},model(12));});
    const current=loadState(cwd).features[key].lineageObservations;
    assert.equal(current.items.length,8);assert.equal(current.discarded,5);
    assert.equal(fs.readFileSync(path.join(cwd,'.idleproof','state.json.bak'),'utf8'),original);
    const archived=readFeatureHistory(cwd,key);
    assert.equal(archived.items.length,9);
    for(const item of retained.items)assert.deepEqual(readFeatureObservation(cwd,key,item.id),item);
    assert.deepEqual(readFeatureObservation(cwd,key,current.items.at(-1).id),current.items.at(-1));
    assert.equal(archived.olderHistory,'unknown');
  } finally {fs.rmSync(cwd,{recursive:true,force:true});}
});

test('unsafe keys, cursors, duplicate JSON and symlink archives are rejected',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-history-adversarial-'));
  try {
    const state=freshState(cwd),key=model(0).featureKey;rememberFeature(state,{id:'fixture'},model(0));saveState(cwd,state);
    const item=state.features[key].lineageObservations.items[0],file=path.join(cwd,'.idleproof','feature-observations',key,item.id+'.json');
    for(const options of [{limit:0},{limit:101},{after:'../outside'}])assert.throws(()=>readFeatureHistory(cwd,key,options));
    assert.throws(()=>readFeatureHistory(cwd,'../outside'));assert.throws(()=>readFeatureObservation(cwd,key,'../outside'));
    for(const args of [[],['--feature',key,'--feature',key],['--feature',key,'--limit','0'],['--feature',key,'--language','zz']])assert.throws(()=>featureHistoryCli(cwd,args));
    const original=fs.readFileSync(file,'utf8');fs.writeFileSync(file,original.replace('"schema":','"id":"forged","schema":'));
    assert.throws(()=>readFeatureObservation(cwd,key,item.id),/Corrupt/);
    if(process.platform!=='win32'){
      const outside=path.join(cwd,'outside.json');fs.writeFileSync(outside,original);fs.unlinkSync(file);fs.symlinkSync(outside,file);
      assert.throws(()=>readFeatureObservation(cwd,key,item.id),/Invalid/);
      const dir=path.dirname(file);fs.rmSync(dir,{recursive:true});fs.symlinkSync(cwd,dir,'dir');
      assert.throws(()=>readFeatureHistory(cwd,key),/real local directories/);
    }
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});

test('archive write failure preserves primary state and retry keeps the pending observation',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-history-fault-')), original=fs.linkSync;
  try {
    const state=freshState(cwd),key=model(0).featureKey;rememberFeature(state,{id:'fixture'},model(0));saveState(cwd,state);
    const bytes=fs.readFileSync(path.join(cwd,'.idleproof','state.json'));
    rememberFeature(state,{id:'fixture'},model(1));
    fs.linkSync=()=>{const error=new Error('synthetic full disk');error.code='ENOSPC';throw error;};
    assert.throws(()=>saveState(cwd,state),{code:'ENOSPC'});
    assert.deepEqual(fs.readFileSync(path.join(cwd,'.idleproof','state.json')),bytes);
    const dir=path.join(cwd,'.idleproof','feature-observations',key);
    assert.ok(fs.readdirSync(dir).every(name=>!name.endsWith('.tmp')));
    fs.linkSync=original;saveState(cwd,state);
    assert.equal(readFeatureHistory(cwd,key).items.length,2);
  } finally {fs.linkSync=original;fs.rmSync(cwd,{recursive:true,force:true});}
});

test('ordinary state saves do not reread or rewrite the archive',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-history-hot-')), original=fs.openSync;
  try {
    const state=freshState(cwd);rememberFeature(state,{id:'fixture'},model(0));saveState(cwd,state);
    const loaded=loadState(cwd);let archiveOpens=0;
    fs.openSync=(file,...args)=>{if(String(file).includes('feature-observations'))archiveOpens++;return original(file,...args);};
    saveState(cwd,loaded);assert.equal(archiveOpens,0);
  } finally {fs.openSync=original;fs.rmSync(cwd,{recursive:true,force:true});}
});

test('failed mutateState retains captured observations for a later project save',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-history-mutation-')), original=fs.linkSync;
  try {
    const key=model(0).featureKey;
    mutateState(cwd,state=>{rememberFeature(state,{id:'first'},model(0));});
    fs.linkSync=()=>{const error=new Error('synthetic full disk');error.code='ENOSPC';throw error;};
    assert.throws(()=>mutateState(cwd,state=>{rememberFeature(state,{id:'captured'},model(1));}),{code:'ENOSPC'});
    fs.linkSync=original;
    // The failed mutator's state object is unavailable; only a new load is used.
    mutateState(cwd,state=>{state.preferences.mode='learn';});
    assert.equal(readFeatureHistory(cwd,key).items.length,2);
    assert.equal(loadState(cwd).features[key].lineageObservations.items.length,1);
  } finally {fs.linkSync=original;fs.rmSync(cwd,{recursive:true,force:true});}
});

test('nonmatching archive names count toward the enumeration bound',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-history-bound-')), original=fs.opendirSync;
  try {
    const state=freshState(cwd),key=model(0).featureKey;rememberFeature(state,{id:'fixture'},model(0));saveState(cwd,state);
    let calls=0,closed=false;
    fs.opendirSync=()=>({readSync(){calls++;return calls<=100002?{name:`unexpected-${calls}`} : null;},closeSync(){closed=true;}});
    assert.throws(()=>readFeatureHistory(cwd,key),/bounded reader/);
    assert.equal(calls,100001);assert.equal(closed,true);
  } finally {fs.opendirSync=original;fs.rmSync(cwd,{recursive:true,force:true});}
});
