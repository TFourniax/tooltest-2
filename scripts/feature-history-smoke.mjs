import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-history-'));
const dw=process.env.DIFFWITNESS_BIN||'dw';
let tarball;
const exec=(command,args,cwd=root,extra={})=>execFileSync(command,args,{cwd,encoding:'utf8',timeout:60000,
  stdio:['ignore','pipe','pipe'],env:{...process.env,DIFFWITNESS_BIN:dw,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'},...extra});
const npm=(args,cwd=root)=>exec('npm',args,cwd,{shell:process.platform==='win32'});
try {
  const packed=JSON.parse(npm(['pack','--json']));tarball=path.resolve(root,packed[0].filename);
  const packageSha256=createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  const consumer=path.join(temp,'consumer');fs.mkdirSync(consumer);
  npm(['init','-y'],consumer);npm(['install','--ignore-scripts','--no-audit','--no-fund',tarball],consumer);
  const pkg=path.join(consumer,'node_modules','idleproof');
  const {cachedFeatureModel,rememberFeature}=await import(pathToFileURL(path.join(pkg,'src','feature-memory.mjs')));
  const {freshState,saveState}=await import(pathToFileURL(path.join(pkg,'src','state.mjs')));
  const repo=path.join(temp,'project');fs.mkdirSync(repo);
  const git=(...args)=>exec('git',args,repo);
  git('init','-q');git('config','user.name','Lineage fixture');git('config','user.email','lineage@example.invalid');git('config','core.autocrlf','false');
  fs.writeFileSync(path.join(repo,'old.py'),'def calculate(value):\n    return value + 1\n');
  git('add','old.py');git('commit','-qm','initial');
  const state=freshState(repo),old=cachedFeatureModel(repo,{id:'before',currentResource:'old.py'});
  rememberFeature(state,{id:'before'},old);assert.equal(state.features[old.featureKey].lineageObservations.items.length,1);
  const oldest=state.features[old.featureKey].lineageObservations.items[0];
  // Diagnostic only: an observation is recorded only after a canonical parsed extraction, so print the
  // fixed-field coverage of any call that had none. The assertions below are unchanged.
  const uncovered=[];
  const coverageOf=(model,call)=>{const item=(model.generatedFrom?.coverage||[]).find(entry=>entry.path==='old.py');
    if(!item?.canonical||!item?.parsed) uncovered.push({call,canonical:item?.canonical??null,parsed:item?.parsed??null,reason:item?.reason??null});};
  coverageOf(old,0);
  for(let i=0;i<12;i++) {
    fs.writeFileSync(path.join(repo,'old.py'),`def calculate(value):\n    return value + ${i+2}\n`);
    const observed=cachedFeatureModel(repo,{id:'before',currentResource:'old.py'});
    coverageOf(observed,i+1);
    assert.equal(observed.featureKey,old.featureKey);rememberFeature(state,{id:'before'},observed);
  }
  if(uncovered.length) console.error(JSON.stringify({schema:'idleproof-feature-history-coverage-diagnostic-1',classification:'MACHINE',qualification:false,uncovered}));
  assert.equal(state.features[old.featureKey].lineageObservations.items.length,8);
  assert.ok(!state.features[old.featureKey].lineageObservations.items.some(item=>item.id===oldest.id));
  fs.writeFileSync(path.join(repo,'old.py'),'def calculate(value):\n    return value + 1\n');
  state.features[old.featureKey].confidence=0.9;
  git('mv','old.py','new.py');git('commit','-qm','relocation');
  const moved=cachedFeatureModel(repo,{id:'after',currentResource:'new.py'});
  rememberFeature(state,{id:'after'},moved);assert.notEqual(old.featureKey,moved.featureKey);
  assert.equal(state.features[moved.featureKey].confidence,0);
  exec(dw,['state','bootstrap-git','--include-lineage','--all-branches','--json'],repo);
  saveState(repo,state);
  const bin=path.join(pkg,'bin','idleproof.mjs');
  const args=['feature-lineage','--from',old.featureKey,'--to',moved.featureKey,
    '--from-observation',oldest.id,'--to-observation',state.features[moved.featureKey].lineageObservations.items[0].id];
  const index=fs.readFileSync(path.join(repo,'.git','index'));
  const statePath=path.join(repo,'.idleproof','state.json'),stateBytes=fs.readFileSync(statePath);
  const journal=path.join(repo,'.git','diffwitness','events.jsonl'),journalBytes=fs.readFileSync(journal);
  const result=JSON.parse(exec(process.execPath,[bin,...args,'--json'],repo));
  const listed=JSON.parse(exec(process.execPath,[bin,'feature-lineage','--list','--json'],repo));
  assert.equal(listed.items.length,2);assert.ok(listed.items.every(item=>item.status==='available'));
  assert.equal(result.status,'available');assert.equal(result.links.length,1);
  assert.equal(result.links[0].fromObservation,oldest.id);
  assert.equal(result.coverage.selection,'explicit-observations');
  assert.equal(result.coverage.completeRetainedView,false);
  const history=JSON.parse(exec(process.execPath,[bin,'feature-history','--feature',old.featureKey,'--limit','100','--json'],repo));
  assert.equal(history.items.length,13);assert.equal(history.olderHistory,'unknown');
  assert.deepEqual(history.items.find(item=>item.id===oldest.id),oldest);
  assert.match(exec(process.execPath,[bin,'feature-history','--feature',old.featureKey,'--language','fr'],repo),/Observations locales/);
  assert.match(exec(process.execPath,[bin,'feature-history','--feature',old.featureKey,'--language','en'],repo),/Retained local/);
  assert.equal(result.transfersScores,false);assert.equal(result.transfersAssertionAuthority,false);
  const events=journalBytes.toString('utf8').trim().split('\n').map(JSON.parse);
  const cited=events.find(event=>event.event_id===result.links[0].source.event_id);
  assert.equal(result.links[0].source.event_hash,cited.event_hash);
  assert.equal(result.links[0].source.commit,cited.payload.commit);
  assert.match(exec(process.execPath,[bin,...args,'--language','fr'],repo),/Filiation de fonctionnalités/);
  assert.match(exec(process.execPath,[bin,...args,'--language','en'],repo),/Feature lineage/);
  assert.deepEqual(fs.readFileSync(statePath),stateBytes);assert.deepEqual(fs.readFileSync(path.join(repo,'.git','index')),index);
  assert.deepEqual(fs.readFileSync(journal),journalBytes);
  fs.writeFileSync(journal,Buffer.concat([journalBytes,Buffer.from('{"corrupt":true}\n')]));
  const rejected=spawnSync(process.execPath,[bin,...args,'--json'],{cwd:repo,encoding:'utf8',timeout:10000,
    env:{...process.env,DIFFWITNESS_BIN:dw}});
  assert.equal(rejected.status,2);assert.equal(JSON.parse(rejected.stdout).status,'unavailable');
  assert.deepEqual(fs.readFileSync(statePath),stateBytes);assert.deepEqual(fs.readFileSync(path.join(repo,'.git','index')),index);
  console.log(JSON.stringify({schema:'idleproof-feature-history-smoke-1',classification:'MACHINE',passed:true,
    actualCore:true,installedPackage:true,packageSha256,sourceEvent:cited.event_id,sourceHash:cited.event_hash,languages:['fr','en'],
    noScoreTransfer:true,readOnly:true,corruptJournalRejected:true,archivedObservations:13,oldestSelectedBeyondHotWindow:true}));
} finally {
  fs.rmSync(temp,{recursive:true,force:true});if(tarball) fs.rmSync(tarball,{force:true});
}
