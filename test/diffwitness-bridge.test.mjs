import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDiffWitnessIdeHook } from '../src/diffwitness-bridge.mjs';
import { projectPaths } from '../src/paths.mjs';

test('legacy standalone IdleProof project does not spawn or require DiffWitness',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-no-diffwitness-'));
  try{
    const result=runDiffWitnessIdeHook({cwd,eventName:'UserPromptSubmit',event:{prompt:'hello'}});
    assert.equal(result.enabled,false);
    assert.equal(result.ok,true);
    assert.equal(result.required,false);
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});

test('corrupt DiffWitness integration config fails closed instead of silently downgrading Proof',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'diffwitness-corrupt-'));
  try{
    const config=projectPaths(cwd).diffwitnessConfig;
    fs.mkdirSync(path.dirname(config),{recursive:true});
    fs.writeFileSync(config,'{"schema":"wrong"}\n');
    const result=runDiffWitnessIdeHook({cwd,eventName:'Stop',event:{}});
    assert.equal(result.enabled,true);
    assert.equal(result.ok,false);
    assert.equal(result.required,true);
    assert.equal(result.errorCode,'DIFFWITNESS_INTEGRATION_CONFIG_INVALID');
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
