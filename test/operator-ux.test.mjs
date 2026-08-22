import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../bin/idleproof.mjs');

function cwd() { return fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-operator-')); }
function run(project,...args) { return execFileSync(process.execPath,[BIN,...args],{cwd:project,encoding:'utf8',stdio:['ignore','pipe','pipe']}); }
function cleanup(project) { try { fs.rmSync(project,{recursive:true,force:true,maxRetries:10,retryDelay:100}); } catch {} }
function healthyState(project='operator-project') { return JSON.stringify({version:2,project,createdAt:'2026-08-21T00:00:00Z',preferences:{},sessions:{},features:{},ledger:{}}); }

test('main help exposes support and repair without requiring users to know internal files',()=>{
  const project=cwd();
  try {
    const help=run(project,'--help');
    assert.match(help,/idleproof support/i);
    assert.match(help,/idleproof repair/i);
  } finally { cleanup(project); }
});

test('repair is a safe no-op before IdleProof has created local state',()=>{
  const project=cwd();
  try {
    const output=run(project,'repair');
    assert.match(output,/nothing needs repair/i);
    assert.equal(fs.existsSync(path.join(project,'.idleproof')),false,'repair unexpectedly created local state');
  } finally { cleanup(project); }
});

test('repair dry-run explains recovery and real repair preserves corrupt primary in archive',()=>{
  const project=cwd();
  try {
    execFileSync('git',['init','-q'],{cwd:project});
    const dir=path.join(project,'.idleproof');
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'state.json'),'{broken-primary');
    fs.writeFileSync(path.join(dir,'state.json.bak'),healthyState('restored-project'));

    const plan=JSON.parse(run(project,'repair','--dry-run','--json'));
    assert.equal(plan.action,'archive-and-restore-backup');
    assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8'),'{broken-primary');

    const output=run(project,'repair');
    assert.match(output,/restored from its last verified compatible backup/i);
    assert.match(output,/corrupt primary archived/i);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')).project,'restored-project');
    const recoveryRoot=path.join(project,'.git','idleproof-recovery');
    assert.ok(fs.readdirSync(recoveryRoot).some((name)=>name.endsWith('-corrupt-state.json')));
  } finally { cleanup(project); }
});

test('idleproof support aliases the privacy-safe support command',()=>{
  const project=cwd();
  try {
    const report=JSON.parse(run(project,'support','--json'));
    assert.equal(report.schema,'idleproof.support-diagnostic.v1');
    assert.equal(report.privacy.rawPromptIncluded,false);
    assert.ok(!JSON.stringify(report).includes(project));
  } finally { cleanup(project); }
});
