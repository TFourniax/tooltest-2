import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defitnessStatus, installDefitness, uninstallDefitness } from '../src/defitness-install.mjs';
import { projectPaths } from '../src/paths.mjs';

function repo(){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'defitness-install-'));
  execFileSync('git',['init','-q'],{cwd});
  execFileSync('git',['config','user.email','defitness@example.test'],{cwd});
  execFileSync('git',['config','user.name','Defitness Test'],{cwd});
  fs.writeFileSync(path.join(cwd,'app.js'),'export const ready = true;\n');
  execFileSync('git',['add','-A'],{cwd});
  execFileSync('git',['commit','-qm','base'],{cwd});
  return cwd;
}

const proofOk=(_cwd,command)=>({ok:true,command:command||'dw-test'});

test('one Defitness install arms Claude, Codex and Cursor without collapsing their native configs',()=>{
  const cwd=repo();
  try{
    const result=installDefitness({cwd,agent:'all',diffWitnessCommand:'dw-test',probe:proofOk});
    assert.deepEqual(result.adapters,['claude','codex','cursor']);
    const paths=projectPaths(cwd);
    const product=JSON.parse(fs.readFileSync(paths.defitnessConfig,'utf8'));
    assert.equal(product.requireDiffWitness,true);
    assert.equal(product.diffWitnessCommand,'dw-test');
    assert.deepEqual(product.adapters,['claude','codex','cursor']);

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

    const status=defitnessStatus(cwd,{probe:proofOk});
    assert.equal(status.healthy,true);
    assert.deepEqual(status.expectedAdapters,['claude','codex','cursor']);

    const removed=uninstallDefitness({cwd});
    assert.equal(removed.installed,false);
    assert.equal(fs.existsSync(paths.defitnessConfig),false);
    assert.equal(defitnessStatus(cwd,{probe:proofOk}).configured,false);
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});

test('Defitness install is project-local transactional when a later adapter refuses unsafe overwrite',()=>{
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
      ()=>installDefitness({cwd,agent:'all',diffWitnessCommand:'dw-test',probe:proofOk}),
      /Refusing to overwrite an unrelated Cursor rule/
    );
    assert.deepEqual(fs.readFileSync(paths.claudeSettings),beforeClaude);
    assert.deepEqual(fs.readFileSync(paths.cursorRule),beforeRule);
    if(beforeExclude)assert.deepEqual(fs.readFileSync(exclude),beforeExclude);
    else assert.equal(fs.existsSync(exclude),false);
    assert.equal(fs.existsSync(paths.defitnessConfig),false);
    assert.equal(fs.existsSync(paths.codexHooks),false);
    assert.equal(fs.existsSync(paths.cursorHooks),false);
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});

test('Defitness never arms a project when DiffWitness compatibility probe fails',()=>{
  const cwd=repo();
  try{
    const paths=projectPaths(cwd);
    assert.throws(
      ()=>installDefitness({cwd,agent:'claude',diffWitnessCommand:'dw',probe:()=>({ok:false,errorCode:'UNSUPPORTED_DIFFWITNESS',message:'missing ide-hook'})}),
      /DiffWitness is required/
    );
    assert.equal(fs.existsSync(paths.defitnessConfig),false);
    assert.equal(fs.existsSync(paths.claudeSettings),false);
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
