import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  diffWitnessRequiredFailure,
  runDiffWitnessIdeHook,
  stopAllowsCompletion,
  validateDiffWitnessStopOutput
} from '../src/diffwitness-bridge.mjs';
import { projectPaths } from '../src/paths.mjs';

test('native Stop accepts only bounded Core decisions and preserves unverified terminal failure', () => {
  const accepted = {systemMessage:'DiffWitness: no repository change to prove.'};
  const blocked = {decision:'block',reason:'Insufficient executable evidence.',systemMessage:'Insufficient executable evidence.'};
  const terminal = {continue:false,stopReason:'SessionStart was not observed.',systemMessage:'SessionStart was not observed.'};
  for (const payload of [accepted,blocked,terminal]) {
    const result=validateDiffWitnessStopOutput(JSON.stringify(payload));
    assert.equal(result.ok,true,JSON.stringify(payload));
    assert.deepEqual(result.output,payload);
  }
  assert.equal(stopAllowsCompletion(accepted),true);
  assert.equal(stopAllowsCompletion(blocked),false);
  assert.equal(stopAllowsCompletion(terminal),false,'Unverified terminal Stop must not queue auto-debt');
  assert.equal(stopAllowsCompletion({decision:'approve',systemMessage:'legacy'}),false);
});

test('legacy approve and malformed Stop outputs never pass through as an accepted verdict', () => {
  const bad = [
    {decision:'approve',systemMessage:'Old Core claims acceptance'},
    {decision:'deny',systemMessage:'Unsupported decision'},
    {decision:'block',systemMessage:'No block reason'},
    {continue:false,systemMessage:'No stopReason'},
    {continue:'false',systemMessage:'Wrong type'},
    {hookSpecificOutput:{hookEventName:'Stop'},systemMessage:'Unsupported fields'},
    {}
  ];
  for (const payload of bad) {
    const result=validateDiffWitnessStopOutput(JSON.stringify(payload));
    assert.equal(result.ok,false,JSON.stringify(payload));
  }
  for (const raw of ['', 'not JSON', '{"systemMessage":"ok"}\n{"systemMessage":"ok"}', 'null', '[]']) {
    assert.equal(validateDiffWitnessStopOutput(raw).ok,false,JSON.stringify(raw));
  }
});

test('required native Core Stop rejects the legacy pipx approve protocol before Codex sees it', () => {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-stop-contract-'));
  try {
    const config=projectPaths(cwd).diffwitnessConfig;
    fs.mkdirSync(path.dirname(config),{recursive:true});
    fs.writeFileSync(config,JSON.stringify({
      schema:'diffwitness.integration-config.v1',
      requireDiffWitness:true,
      diffWitnessCommand:'/qualified/core/dw',
      adapters:['codex']
    }));
    const privateMarker='ipd_PRIVATE_DO_NOT_REPORT';
    let invoked=0;
    const result=runDiffWitnessIdeHook({
      cwd,eventName:'Stop',event:{cwd,session_id:'acceptance'},
      spawnCommand:(command,args,options)=>{
        invoked++;
        assert.equal(command,'/qualified/core/dw');
        assert.deepEqual(args,['ide-hook','session-stop']);
        assert.equal(options.cwd,cwd);
        return {status:0,stdout:JSON.stringify({decision:'approve',systemMessage:privateMarker}),stderr:''};
      }
    });
    assert.equal(invoked,1);
    assert.equal(result.ok,false);
    assert.equal(result.required,true);
    assert.equal(result.errorCode,'DIFFWITNESS_STOP_PROTOCOL_INVALID');
    assert.equal(JSON.stringify(result).includes(privateMarker),false,'Untrusted provider stdout must not leak');
    const terminal=diffWitnessRequiredFailure(result);
    assert.equal(terminal.decision,undefined,'No unsupported approval or retry-loop decision');
    assert.equal(terminal.continue,false);
    assert.match(terminal.stopReason,/cannot establish Proof\/Debt evidence/);
    assert.equal(terminal.stopReason,terminal.systemMessage);
    assert.equal(stopAllowsCompletion(terminal),false);
  } finally {fs.rmSync(cwd,{recursive:true,force:true});}
});

test('required native Core Stop accepts the current qualified success/block/terminal responses', () => {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-stop-qualified-'));
  try {
    const config=projectPaths(cwd).diffwitnessConfig;
    fs.mkdirSync(path.dirname(config),{recursive:true});
    fs.writeFileSync(config,JSON.stringify({
      schema:'diffwitness.integration-config.v1',
      requireDiffWitness:true,
      diffWitnessCommand:'/qualified/core/dw',
      adapters:['codex']
    }));
    for (const output of [
      {systemMessage:'DiffWitness: no production-code mutation to prove.'},
      {decision:'block',reason:'Proof inconclusive',systemMessage:'Proof inconclusive'},
      {continue:false,stopReason:'SessionStart not armed',systemMessage:'SessionStart not armed'}
    ]) {
      const result=runDiffWitnessIdeHook({
        cwd,eventName:'Stop',event:{cwd,session_id:'acceptance'},
        spawnCommand:()=>({status:0,stdout:JSON.stringify(output)+'\n',stderr:''})
      });
      assert.equal(result.ok,true,JSON.stringify(output));
      assert.deepEqual(result.output,output);
      assert.equal(stopAllowsCompletion(result.output),!output.decision&&!('continue' in output));
    }
  } finally {fs.rmSync(cwd,{recursive:true,force:true});}
});
