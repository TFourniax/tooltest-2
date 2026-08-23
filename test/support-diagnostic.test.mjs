import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSupportDiagnostic, assertSupportDiagnosticSafe } from '../src/diagnostic.mjs';

const SUPPORT_BIN=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../bin/idleproof-support.mjs');

function repo() {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-support-'));
  execFileSync('git',['init','-q'],{cwd});
  execFileSync('git',['config','user.email','support@idleproof.local'],{cwd});
  execFileSync('git',['config','user.name','IdleProof Support'],{cwd});
  fs.writeFileSync(path.join(cwd,'app.js'),'export const privateBusinessLogic = 42;\n');
  execFileSync('git',['add','app.js'],{cwd});
  execFileSync('git',['commit','-qm','base'],{cwd});
  return cwd;
}

function cleanup(cwd) {
  try { fs.rmSync(cwd,{recursive:true,force:true,maxRetries:10,retryDelay:100}); } catch {}
}

test('support diagnostic stays useful without leaking project source, prompts, secrets, or absolute path',()=>{
  const cwd=repo();
  const marker='SUPPORT_MUST_NOT_LEAK_5f2b';
  try {
    const dir=path.join(cwd,'.idleproof');
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({
      version:2,
      project:'secret-customer-project',
      createdAt:'2026-08-21T00:00:00Z',
      sessions:{s1:{prompt:`${marker} api_key=real-secret`,events:[{content:`${marker} source`}]}},
      features:{},ledger:{},preferences:{}
    }));
    fs.writeFileSync(path.join(dir,'events.jsonl'),JSON.stringify({sequence:1,previousHash:'0'.repeat(64),event:{payloadDigest:'a'.repeat(64)},hash:'b'.repeat(64)})+'\n');
    fs.writeFileSync(path.join(dir,'chain.json'),JSON.stringify({schema:'idleproof.chain.v1',length:1,headHash:'b'.repeat(64)}));

    const report=buildSupportDiagnostic(cwd);
    assert.equal(assertSupportDiagnosticSafe(report),true);
    assert.equal(report.schema,'idleproof.support-diagnostic.v1');
    assert.equal(report.git.repository,true);
    assert.equal(report.git.hasHead,true);
    assert.equal(report.state.primary.parseable,true);
    assert.equal(report.state.primary.version,2);
    assert.equal(report.provenance.valid,false,'tampered fixture provenance should be reported as invalid');
    const serialized=JSON.stringify(report);
    assert.ok(!serialized.includes(marker));
    assert.ok(!serialized.includes('real-secret'));
    assert.ok(!serialized.includes('privateBusinessLogic'));
    assert.ok(!serialized.includes(cwd));
    assert.ok(!serialized.includes('secret-customer-project'));
    assert.ok(Buffer.byteLength(serialized,'utf8')<32*1024);
  } finally { cleanup(cwd); }
});

test('support diagnostic remains available when primary state is corrupt but backup is readable',()=>{
  const cwd=repo();
  try {
    const dir=path.join(cwd,'.idleproof');
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'state.json'),'{broken-json');
    fs.writeFileSync(path.join(dir,'state.json.bak'),JSON.stringify({version:2,project:'x',sessions:{},features:{},ledger:{},preferences:{}}));
    const report=buildSupportDiagnostic(cwd);
    assert.equal(report.state.primary.parseable,false);
    assert.equal(report.state.backup.parseable,true);
    assert.equal(report.state.recoverable,true);
  } finally { cleanup(cwd); }
});

test('installed-style support CLI can write a bounded shareable report',()=>{
  const cwd=repo();
  try {
    const output='idleproof-support.json';
    const stdout=execFileSync(process.execPath,[SUPPORT_BIN,'--out',output],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    assert.match(stdout,/support report/i);
    const target=path.join(cwd,output);
    assert.ok(fs.existsSync(target));
    const report=JSON.parse(fs.readFileSync(target,'utf8'));
    assert.equal(assertSupportDiagnosticSafe(report),true);
    assert.equal(report.privacy.absoluteProjectPathIncluded,false);
    assert.ok(Buffer.byteLength(JSON.stringify(report),'utf8')<32*1024);
  } finally { cleanup(cwd); }
});
