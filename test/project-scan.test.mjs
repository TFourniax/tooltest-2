import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanProject, loadProjectScan, projectScanView, cancelProjectScan, projectSource, validateScanPage, collectProjectScan, decodeScanResponse, refreshCommittedBaseline, projectHandoff } from '../src/project-scan.mjs';
import { readContinuityEvent, readContinuityQuestion } from '../src/continuity.mjs';

const enabled=Boolean(process.env.IDLEPROOF_TEST_CORE);
const cli=fileURLToPath(new URL('../bin/idleproof.mjs',import.meta.url));
function fixture(t) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-project-scan-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q','-b','main');git('config','user.name','Synthetic Scan');git('config','user.email','scan@example.invalid');git('config','core.autocrlf','false');git('config','gc.auto','0');
  fs.mkdirSync(path.join(cwd,'tests'));
  fs.writeFileSync(path.join(cwd,'compute.py'),'def compute(value):\n    return value * 0.9 if value >= 100 else value\n');
  fs.writeFileSync(path.join(cwd,'tests/check.py'),'from compute import compute\ndef test_threshold():\n    assert compute(100) == 90\n');
  fs.writeFileSync(path.join(cwd,'README.md'),'# Intended behavior\nSupport independent calculations.\n');
  fs.writeFileSync(path.join(cwd,'.env'),'NEVER_ADMIT_PRIVATE_SENTINEL');
  git('add','.');git('commit','-qm','synthetic baseline');
  return {cwd,git};
}

test('untrusted structural authority and mixed snapshot scopes are rejected',()=>{
  const page={schemaVersion:'structure-snapshot-1',pageSchema:'structure-page-1',snapshotId:'dwscan_'+'1'.repeat(64),resultSha256:'2'.repeat(64),source:'HEAD',state:'complete',authority:'OBSERVED',proof:'UNKNOWN',runtimeGraph:false,capturedAt:'2026-10-10T00:00:00Z',consistency:'immutable-git-tree',position:0,tree:'a'.repeat(40),baseTree:'a'.repeat(40),coverage:{inventoryEntries:0,inventoryComplete:true,eligible:0,read:0,capturedSources:0,bytesRead:0,reused:0,statuses:{},reasons:{},complete:true},profile:{inventory:'project-inventory-4',providers:{schema:'structure-providers-9a'},python:[3,11,9],limits:[20000,1048576,33554432]},selection:{documents:[],ci:false,maxFiles:2000},offset:0,files:[],nextCursor:null};
  assert.equal(validateScanPage(page),true);
  assert.equal(validateScanPage({...page,proof:'VERIFIED'}),false);
  assert.equal(validateScanPage({...page,profile:{v:2}},page),false);
  assert.equal(validateScanPage({...page,selection:{documents:['different.md']}},page),false);
  assert.equal(validateScanPage({...page,nextCursor:page.snapshotId+':1'}),false);
});

test('real Core initial scan, task-free Local projection, unchanged reuse and immutable source', {skip:!enabled}, async t=>{
  const {cwd,git}=fixture(t);
  const model=await scanProject(cwd,{documents:['README.md']});
  assert.equal(projectScanView(cwd).task,null);
  const production=model.files.find(f=>f.path==='compute.py');
  assert.match(JSON.stringify(production.extraction.description),/value >= 100/);
  assert.equal(model.edges.find(e=>e.from==='tests/check.py').to,'compute.py');
  assert.equal(model.edges[0].authority,'INFERRED');
  assert.equal(JSON.stringify(model).includes('NEVER_ADMIT_PRIVATE_SENTINEL'),false);
  assert.equal(model.header.proof,'UNKNOWN');
  assert.equal(projectScanView(cwd,'HEAD',{knownSnapshot:model.header.snapshotId}).model,null);
  git('commit','--allow-empty','-qm','metadata only');
  const again=await scanProject(cwd,{documents:['README.md']});
  assert.deepEqual(again,model);
  fs.writeFileSync(path.join(cwd,'compute.py'),'def compute(value):\n    return 7\n');
  const source=await projectSource(cwd,model.header.snapshotId,'compute.py');
  assert.match(JSON.stringify(source.lines),/value >= 100/);
  const overlay=await scanProject(cwd,{source:'WORKTREE',documents:['README.md']});
  assert.notEqual(overlay.header.snapshotId,model.header.snapshotId);
  assert.equal(loadProjectScan(cwd,'HEAD').header.snapshotId,model.header.snapshotId);
  assert.equal(overlay.header.tree,null);
  const changedPage={...model.header,pageSchema:'structure-page-1',offset:0,files:model.files,nextCursor:null,snapshotId:'dwscan_'+'2'.repeat(64)};
  await assert.rejects(collectProjectScan(cwd,model.header.snapshotId,{run:async()=>changedPage}),/rejected|identity/);
});

test('paused captured scan survives process exit and resumes through the public CLI', {skip:!enabled}, async t=>{
  const {cwd}=fixture(t);
  const paused=await scanProject(cwd,{source:'WORKTREE',onProgress:()=>cancelProjectScan(cwd)});
  assert.equal(paused,null);
  const job=projectScanView(cwd).job;
  assert.equal(job.state,'cancelled');
  const raw=execFileSync(process.execPath,[cli,'project','scan','--resume',job.snapshotId,'--json'],{cwd,encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024,env:process.env});
  const resumed=JSON.parse(raw);
  assert.equal(resumed.model.header.snapshotId,job.snapshotId);
  assert.equal(resumed.job.state,'complete');
  assert.equal(resumed.model.header.proof,'UNKNOWN');
  assert.equal(resumed.model.header.source,'WORKTREE');
});

test('commit refresh preserves the source history and opens actual Core declarations without promoting them', {skip:!enabled}, async t=>{
  const {cwd,git}=fixture(t);
  fs.writeFileSync(path.join(cwd,'README.md'),'# Owner goal\ncompute.py must retain its boundary.\n');git('add','.');git('commit','-qm','owner declaration');
  const first=await scanProject(cwd,{documents:['README.md']});
  assert.equal(first.intentMap.statements.find(s=>s.components.length).components[0].path,'compute.py');
  fs.writeFileSync(path.join(cwd,'compute.py'),'def compute(value):\n    return value * 0.8 if value >= 120 else value\n');git('add','.');git('commit','-qm','changed boundary');
  const refreshed=await refreshCommittedBaseline(cwd);
  assert.notEqual(refreshed.header.snapshotId,first.header.snapshotId);
  assert.deepEqual(refreshed.changes.modified,['compute.py']);
  assert.match(JSON.stringify((await projectSource(cwd,first.header.snapshotId,'compute.py')).lines),/value >= 100/);
  execFileSync(process.env.DIFFWITNESS_BIN||'dw',['decision','record','Keep compute boundaries explicit','--id','DEC-SCAN','--why','Source review before changing compute'],{cwd,env:process.env});
  const handoff=projectHandoff(cwd,'HEAD','DEC-SCAN');
  const declaration=handoff.navigation.recordedItems.find(i=>i.id==='DEC-SCAN');
  assert.equal(declaration.authority,'DECLARED');
  const original=readContinuityEvent(cwd,declaration.source.eventId,declaration.source.eventHash);
  assert.equal(original.event.subject.id,'DEC-SCAN');assert.equal(original.event.epistemic_status,'DECLARED');
  assert.throws(()=>readContinuityEvent(cwd,declaration.source.eventId,'0'.repeat(64)),/could not open/);
  const answer=readContinuityQuestion(cwd,'Why compute?');
  assert.equal(answer.status,'cited-records');assert.equal(answer.assurance,'none');
  assert.ok(answer.context.facts.some(f=>f.source.eventId===declaration.source.eventId&&f.epistemicStatus==='DECLARED'));
  assert.equal(readContinuityQuestion(cwd,'Why nonexistent-in-this-corpus?').status,'abstained');
});


test('Core numeric JSON spellings are accepted without permitting duplicate object members',()=>{
  assert.deepEqual(decodeScanResponse('{"score":1.0,"note":"keep 1.0 as text"}'),{score:1,note:'keep 1.0 as text'});
  assert.throws(()=>decodeScanResponse('{"score":0.1,"score":1.0}'),/ambiguous/);
  assert.throws(()=>decodeScanResponse('{"nested":{"proof":"UNKNOWN","proof":"VERIFIED"}}'),/ambiguous/);
});
