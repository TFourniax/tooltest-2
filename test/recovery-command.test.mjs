import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectRecovery, repairLocalState } from '../src/recovery.mjs';
import { loadState } from '../src/state.mjs';

function repo() {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-repair-'));
  execFileSync('git',['init','-q'],{cwd});
  return cwd;
}

function cleanup(cwd) { try { fs.rmSync(cwd,{recursive:true,force:true,maxRetries:10,retryDelay:100}); } catch {} }
function state(version=2,project='repair-project') { return JSON.stringify({version,project,createdAt:'2026-08-21T00:00:00Z',preferences:{},sessions:{},features:{},ledger:{}}); }

test('repair archives corrupt primary and restores only from a compatible readable backup',()=>{
  const cwd=repo();
  try {
    const dir=path.join(cwd,'.idleproof');
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'state.json'),'{definitely-corrupt');
    fs.writeFileSync(path.join(dir,'state.json.bak'),state(2,'healthy-backup'));

    const plan=inspectRecovery(cwd);
    assert.equal(plan.action,'archive-and-restore-backup');
    assert.equal(plan.recoverable,true);

    const result=repairLocalState(cwd);
    assert.equal(result.changed,true);
    assert.equal(result.restoredFromBackup,true);
    assert.ok(result.archive);
    assert.ok(fs.existsSync(path.join(cwd,result.archive)),'corrupt primary was not archived');
    assert.equal(loadState(cwd).project,'healthy-backup');
  } finally { cleanup(cwd); }
});

test('repair materializes a healthy backup when primary state is missing',()=>{
  const cwd=repo();
  try {
    const dir=path.join(cwd,'.idleproof');
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'state.json.bak'),state(2,'backup-only'));
    const result=repairLocalState(cwd);
    assert.equal(result.changed,true);
    assert.equal(result.archive,null);
    assert.equal(loadState(cwd).project,'backup-only');
  } finally { cleanup(cwd); }
});

test('repair never downgrades a newer state version',()=>{
  const cwd=repo();
  try {
    const dir=path.join(cwd,'.idleproof');
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'state.json'),state(999,'future'));
    fs.writeFileSync(path.join(dir,'state.json.bak'),state(2,'old-backup'));
    const plan=inspectRecovery(cwd);
    assert.equal(plan.action,'upgrade-required');
    assert.throws(()=>repairLocalState(cwd),/Upgrade IdleProof/i);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')).version,999);
  } finally { cleanup(cwd); }
});

test('repair refuses destructive fallback when both state and backup are unusable',()=>{
  const cwd=repo();
  try {
    const dir=path.join(cwd,'.idleproof');
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'state.json'),'{bad');
    fs.writeFileSync(path.join(dir,'state.json.bak'),'{also-bad');
    assert.equal(inspectRecovery(cwd).action,'manual-recovery-required');
    assert.throws(()=>repairLocalState(cwd),/Refusing to reset or overwrite learning history/i);
    assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8'),'{bad');
  } finally { cleanup(cwd); }
});

test('dry-run reports the exact recovery action without changing files',()=>{
  const cwd=repo();
  try {
    const dir=path.join(cwd,'.idleproof');
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'state.json'),'{bad');
    fs.writeFileSync(path.join(dir,'state.json.bak'),state());
    const before=fs.readFileSync(path.join(dir,'state.json'),'utf8');
    const result=repairLocalState(cwd,{dryRun:true});
    assert.equal(result.action,'archive-and-restore-backup');
    assert.equal(result.changed,false);
    assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8'),before);
  } finally { cleanup(cwd); }
});
