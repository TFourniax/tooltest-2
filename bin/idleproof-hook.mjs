#!/usr/bin/env node
import { processHookLifecycle } from '../src/hook.mjs';
import { queueMatchingDiffWitnessAssurance } from '../src/ide-assurance.mjs';
import { diffWitnessRequiredFailure, runDiffWitnessIdeHook } from '../src/diffwitness-bridge.mjs';
import { readHookPayload } from '../src/hook-input.mjs';

function combinePromptOutput(idleOutput,diffOutput){
  if(!diffOutput)return idleOutput;
  if(!idleOutput)return diffOutput;
  const idleContext=idleOutput?.hookSpecificOutput?.additionalContext;
  const diffContext=diffOutput?.hookSpecificOutput?.additionalContext;
  if(typeof idleContext!=='string'||!idleContext.trim()||typeof diffContext!=='string'||!diffContext.trim()) return idleOutput;
  return {
    ...idleOutput,
    hookSpecificOutput:{
      ...idleOutput.hookSpecificOutput,
      hookEventName:'UserPromptSubmit',
      additionalContext:`${idleContext.trim()}\n\n${diffContext.trim()}`.slice(0,12000)
    }
  };
}

function combineStopOutput(idleOutput,diffResult){
  if(!diffResult?.ok){
    if(diffResult?.required)return diffWitnessRequiredFailure(diffResult);
    return idleOutput;
  }
  const diffOutput=diffResult.output;
  if(!diffOutput)return idleOutput;
  if(diffResult.required && /not armed|session state is invalid/i.test(String(diffOutput.systemMessage||diffOutput.reason||''))){
    return diffWitnessRequiredFailure({message:String(diffOutput.systemMessage||diffOutput.reason)});
  }
  const idleMessage=idleOutput?.systemMessage || idleOutput?.hookSpecificOutput?.additionalContext;
  if(typeof idleMessage==='string'&&idleMessage.trim()){
    return {...diffOutput,systemMessage:`${String(diffOutput.systemMessage||diffOutput.reason||'').trim()}\n${idleMessage.trim()}`.trim()};
  }
  return diffOutput;
}

function queueAssurance(cwd) {
  try { queueMatchingDiffWitnessAssurance(cwd); }
  catch { console.error('[idleproof-hook] Portal assurance queue unavailable; native assurance result preserved.'); }
}

async function run() {
  const mode=String(process.argv[2] || 'claude').toLowerCase();
  if (!['claude','codex'].includes(mode)) throw new Error('IdleProof hook runner expects claude or codex.');
  const event=await readHookPayload();
  const cwd=event.cwd || process.cwd();
  const eventName=event.hook_event_name || event.type || '';
  let output=null;
  let advisoryWarning='';
  try { output=processHookLifecycle({ ...event, source:mode }).hookOutput || null; }
  catch {
    advisoryWarning='IdleProof context is unavailable; inspect idleproof repair. DiffWitness assurance is evaluated separately.';
    console.error(`[idleproof-hook] ${advisoryWarning}`);
  }

  if(['SessionStart','UserPromptSubmit','Stop'].includes(eventName)){
    let diffResult;
    try { diffResult=runDiffWitnessIdeHook({cwd,eventName,event:{...event,source:mode}}); }
    catch { diffResult={ok:false,required:true,message:'Native DiffWitness assurance could not be evaluated.'}; }
    if(eventName==='UserPromptSubmit'){
      if(diffResult.ok) output=combinePromptOutput(output,diffResult.output);
      else if(diffResult.required){
        const warning=`DIFFWITNESS PROOF DEGRADED: ${String(diffResult.message||'DiffWitness unavailable').slice(0,700)}`;
        output=combinePromptOutput(output,{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:warning}});
      }
    }
    if(eventName==='Stop'){
      output=combineStopOutput(output,diffResult);
      queueAssurance(cwd);
    }
  } else if(['SessionEnd','SubagentStop'].includes(eventName)) {
    queueAssurance(cwd);
  }

  if(advisoryWarning) output={...(output||{}),systemMessage:[output?.systemMessage,advisoryWarning].filter(Boolean).join('\n')};

  if(output) process.stdout.write(`${JSON.stringify(output)}\n`);
  else if(mode==='codex' && ['Stop','SubagentStop'].includes(eventName)) process.stdout.write('{}\n');
}

run().catch((error)=>{
  // Standalone IdleProof remains fail-open. Once DiffWitness integration is configured, the core
  // Proof/Debt Stop decision remains the authoritative correctness boundary and cannot be upgraded
  // to VERIFIED by this sidecar.
  console.error(`[idleproof-hook] ${error?.message || error}`);
  process.exitCode=0;
});
