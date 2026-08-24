import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  diffWitnessIntegrationStatus,
  installDiffWitnessIntegration,
  uninstallDiffWitnessIntegration
} from '../src/diffwitness-integration-install.mjs';
import { projectPaths } from '../src/paths.mjs';

function repo(){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'diffwitness-integration-'));
  execFileSync('git',['init','-q'],{cwd});
  execFileSync('git',['config','user.email','diffwitness@example.test'],{cwd});
  execFileSync('git',['config','user.name','DiffWitness Test'],{cwd});
  fs.writeFileSync(path.join(cwd,'app.js'),'export const ready = true;\n');
  execFileSync('git',['add','-A'],{cwd});
  execFileSync('git',['commit','-qm','base'],{cwd});
  return cwd;
}

const proofOk=(_cwd,command)=>({ok:true,command:command||'dw-test'});

test('one DiffWitness integration arms Claude, Codex and Cursor without collapsing their native configs',()=>{
  const cwd=repo();
  try{
    const result=installDiffWitnessIntegration({cwd,agent:'all',diffWitnessCommand:'dw-test',probe:proofOk});
    assert.deepEqual(result.adapters,['claude','codex','cursor']);
    const paths=projectPaths(cwd);
    const product=JSON.parse(fs.readFileSync(paths.diffwitnessConfig,'utf8'));
    assert.equal(product.schema,'diffwitness.integration-config.v1');
    assert.equal(product.requireDiffWitness,true);
    assert.equal(product.diffWitnessCommand,'dw-test');
    assert.deepEqual(product.adapters,['claude','codex','cursor']);
    assert.equal(fs.existsSync(paths.defitnessConfigLegacy),false);

    const claude=JSON.parse(fs.readFileSync(paths.claudeSettings,'utf8'));
    const claudeStop=claude.hooks.Stop.find((entry)=>entry.hooks?.some((hook)=>hook.command?.includes('idleproof-hook.mjs')));
    assert.ok(claudeStop);
    assert.equal(claudeStop.hooks[0].timeout,910);

    const codex=JSON.parse(fs.readFileSync(paths.codexHooks,'utf8'));
    const codexStop=codex.hooks.Stop.find((entry)=>entry.hooks?.some((hook)=>hook.command?.includes('idleproof-hook.mjs')));
    assert.ok(codexStop);
    assert.equal(codexStop.hooks[0].timeout,910);

    const cursor=JSON.parse(fs.readFileSync(paths.cursorHooks,'utf8'));
    assert.equal(cursor.loop_limit,3);
    const cursorStop=cursor.hooks.stop.find((entry)=>entry.command?.includes('cursor-hook-cli.mjs'));
    assert.ok(cursorStop);
    assert.equal(cursorStop.timeout,910);

    const status=diffWitnessIntegrationStatus(cwd,{probe:proofOk});
    assert.equal(status.healthy,true);
    assert.deepEqual(status.expectedAdapters,['claude','codex','cursor']);

    const removed=uninstallDiffWitnessIntegration({cwd});
    assert.equal(removed.installed,false);
    assert.equal(fs.existsSync(paths.diffwitnessConfig),false);
    assert.equal(diffWitnessIntegrationStatus(cwd,{probe:proofOk}).configured,false);
  }finally{fs.rmSync(cwd,{recursive:true,force:true,maxRetries:12,retryDelay:50});}
});

test('DiffWitness integration is project-local transactional when a later adapter refuses unsafe overwrite',()=>{
  const cwd=repo();
  try{
    const paths=projectPaths(cwd);
    fs.mkdirSync(path.dirname(paths.claudeSettings),{recursive:true});
    fs.writeFileSync(paths.claudeSettings,JSON.stringify({permissions:{allow:['Bash(git status:*)']}},null,2));
    fs.mkdirSync(path.dirname(paths.cursorRule),{recursive:true});
    fs.writeFileSync(paths.cursorRule,'unrelated human Cursor rule\n');
    const exclude=path.join(cwd,'.git','info','exclude');
    const beforeClaude=fs.readFileSync(paths.claudeSettings);
    const beforeRule=fs.readFileSync(paths.cursorRule);
    const beforeExclude=fs.existsSync(exclude)?fs.readFileSync(exclude):null;

    assert.throws(
      ()=>installDiffWitnessIntegration({cwd,agent:'all',diffWitnessCommand:'dw-test',probe:proofOk}),
      /Refusing to overwrite an unrelated Cursor rule/
    );
    assert.deepEqual(fs.readFileSync(paths.claudeSettings),beforeClaude);
    assert.deepEqual(fs.readFileSync(paths.cursorRule),beforeRule);
    if(beforeExclude)assert.deepEqual(fs.readFileSync(exclude),beforeExclude);
    else assert.equal(fs.existsSync(exclude),false);
    assert.equal(fs.existsSync(paths.diffwitnessConfig),false);
    assert.equal(fs.existsSync(paths.codexHooks),false);
    assert.equal(fs.existsSync(paths.cursorHooks),false);
  }finally{fs.rmSync(cwd,{recursive:true,force:true,maxRetries:12,retryDelay:50});}
});

test('DiffWitness integration never arms a project when the compatibility probe fails',()=>{
  const cwd=repo();
  try{
    const paths=projectPaths(cwd);
    assert.throws(
      ()=>installDiffWitnessIntegration({cwd,agent:'claude',diffWitnessCommand:'dw',probe:()=>({ok:false,errorCode:'UNSUPPORTED_DIFFWITNESS',message:'missing ide-hook'})}),
      /DiffWitness is required/
    );
    assert.equal(fs.existsSync(paths.diffwitnessConfig),false);
    assert.equal(fs.existsSync(paths.claudeSettings),false);
  }finally{fs.rmSync(cwd,{recursive:true,force:true,maxRetries:12,retryDelay:50});}
});
