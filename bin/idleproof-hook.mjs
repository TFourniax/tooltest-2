#!/usr/bin/env node
import { processHookLifecycle } from '../src/hook.mjs';
import { queueMatchingDiffWitnessAssurance } from '../src/ide-assurance.mjs';
import { diffWitnessRequiredFailure, runDiffWitnessIdeHook } from '../src/diffwitness-bridge.mjs';

async function stdinJson() {
  let raw='';
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch { return {}; }
}

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

async function run() {
  const mode=String(process.argv[2] || 'claude').toLowerCase();
  if (!['claude','codex'].includes(mode)) throw new Error('IdleProof hook runner expects claude or codex.');
  const event=await stdinJson();
  const cwd=event.cwd || process.cwd();
  const lifecycle=processHookLifecycle({ ...event, source:mode });
  const eventName=event.hook_event_name || event.type || '';
  let output=lifecycle.hookOutput || null;

  if(['SessionStart','UserPromptSubmit','Stop'].includes(eventName)){
    const diffResult=runDiffWitnessIdeHook({cwd,eventName,event:{...event,source:mode}});
    if(eventName==='UserPromptSubmit'){
      if(diffResult.ok) output=combinePromptOutput(output,diffResult.output);
      else if(diffResult.required){
        const warning=`DEFINESS PROOF DEGRADED: ${String(diffResult.message||'DiffWitness unavailable').slice(0,700)}`;
        output=combinePromptOutput(output,{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:warning}});
      }
    }
    if(eventName==='Stop'){
      output=combineStopOutput(output,diffResult);
      // IdleProof has already materialized the exact receipt. DiffWitness has now produced the
      // matching change envelope, so the assurance join is deterministic and ordering-free.
      queueMatchingDiffWitnessAssurance(cwd);
    }
  } else if(['SessionEnd','SubagentStop'].includes(eventName)) {
    // Compatibility fallback for projects that still have an external DiffWitness hook installed.
    queueMatchingDiffWitnessAssurance(cwd);
  }

  if(output) process.stdout.write(`${JSON.stringify(output)}\n`);
  else if(mode==='codex' && ['Stop','SubagentStop'].includes(eventName)) process.stdout.write('{}\n');
}

run().catch((error)=>{
  // IdleProof-only installations remain fail-open. A Defitness installation is fail-closed at the
  // DiffWitness Stop boundary through combineStopOutput, so no VERIFIED claim can be fabricated.
  console.error(`[idleproof-hook] ${error?.message || error}`);
  process.exitCode=0;
});
