import { spawnSync } from 'node:child_process';
import { readIntegrationConfig } from './diffwitness-integration-config.mjs';

const EVENT_MAP=new Map([
  ['SessionStart','session-start'],
  ['UserPromptSubmit','user-prompt-submit'],
  ['Stop','session-stop']
]);

function configuredCommand(config){
  return config?.diffWitnessCommand || process.env.DIFFWITNESS_BIN || process.env.DEFITNESS_DIFFWITNESS_BIN || 'dw';
}

function commandFor(cwd){
  let config=null;
  try{config=readIntegrationConfig(cwd);}catch(error){return {enabled:true,config:{requireDiffWitness:true},command:null,error};}
  if(!config)return {enabled:false,config:null,command:null,error:null};
  return {enabled:true,config,command:configuredCommand(config),error:null};
}

function parseLastJson(stdout=''){
  const lines=String(stdout||'').split(/\r?\n/).map((line)=>line.trim()).filter(Boolean);
  for(let i=lines.length-1;i>=0;i-=1){
    try{return JSON.parse(lines[i]);}catch{}
  }
  return null;
}

// Codex/Claude Stop is a strict provider protocol, not a free-form review result.
// Legacy Core builds can still report the same public version while returning
// {decision:"approve"}; that is not a valid Stop decision and must never reach the IDE.
const STOP_FIELDS = new Set(['continue','stopReason','systemMessage','suppressOutput','decision','reason']);

export function validateDiffWitnessStopOutput(stdout=''){
  let output;
  try { output=JSON.parse(String(stdout||'').trim()); }
  catch { return {ok:false,reason:'missing or mixed JSON output'}; }
  if(!output||typeof output!=='object'||Array.isArray(output))
    return {ok:false,reason:'expected a JSON object'};
  if(!Object.keys(output).length||Object.keys(output).some(key=>!STOP_FIELDS.has(key)))
    return {ok:false,reason:'missing or unsupported fields'};
  // The authoritative Core always explains its result. An empty object is not evidence.
  if(typeof output.systemMessage!=='string'||!output.systemMessage.trim())
    return {ok:false,reason:'missing systemMessage'};
  if(Object.hasOwn(output,'decision')&&output.decision!=='block')
    return {ok:false,reason:'decision must be block or omitted'};
  if(Object.hasOwn(output,'continue')&&typeof output.continue!=='boolean')
    return {ok:false,reason:'continue must be boolean'};
  if(Object.hasOwn(output,'suppressOutput')&&typeof output.suppressOutput!=='boolean')
    return {ok:false,reason:'suppressOutput must be boolean'};
  if(Object.hasOwn(output,'stopReason')&&typeof output.stopReason!=='string')
    return {ok:false,reason:'stopReason must be a string'};
  if(Object.hasOwn(output,'reason')&&typeof output.reason!=='string')
    return {ok:false,reason:'reason must be a string'};
  if(output.decision==='block'&&(!output.reason||!output.reason.trim()))
    return {ok:false,reason:'blocked Stop requires a reason'};
  if(output.continue===false&&(!output.stopReason||!output.stopReason.trim()))
    return {ok:false,reason:'terminal Stop requires stopReason'};
  return {ok:true,output};
}

// A terminally unverified Stop must not queue accepted assurance or automatic debt.
export function stopAllowsCompletion(output){
  return output?.decision===undefined&&output?.continue!==false;
}

function timeoutFor(eventName){
  if(eventName==='Stop'){
    const configured=Number(process.env.DIFFWITNESS_STOP_TIMEOUT_MS || process.env.DEFITNESS_DIFFWITNESS_STOP_TIMEOUT_MS || 905000);
    return Number.isFinite(configured)&&configured>=1000?Math.min(configured,1_800_000):905000;
  }
  return 8000;
}

export function probeDiffWitness(cwd=process.cwd(),commandOverride=null){
  let selected=commandOverride;
  if(!selected){
    const resolved=commandFor(cwd);
    if(resolved.error)return {ok:false,command:null,errorCode:resolved.error.code||'DIFFWITNESS_INTEGRATION_CONFIG_INVALID',message:String(resolved.error.message||resolved.error)};
    selected=resolved.command || process.env.DIFFWITNESS_BIN || process.env.DEFITNESS_DIFFWITNESS_BIN || 'dw';
  }
  const result=spawnSync(selected,['ide-hook','user-prompt-submit'],{
    cwd,
    input:'{}',
    encoding:'utf8',
    windowsHide:true,
    timeout:5000,
    maxBuffer:1024*1024
  });
  if(result.error){return {ok:false,command:selected,errorCode:result.error.code||'SPAWN_FAILED',message:String(result.error.message||result.error)}}
  if(result.status!==0){return {ok:false,command:selected,errorCode:'UNSUPPORTED_DIFFWITNESS',message:String(result.stderr||result.stdout||'DiffWitness IDE hook probe failed').trim().slice(0,500)}}
  return {ok:true,command:selected};
}

export function runDiffWitnessIdeHook({cwd=process.cwd(),eventName,event={},spawnCommand=spawnSync}={}){
  const mapped=EVENT_MAP.get(String(eventName||''));
  if(!mapped)return {supported:false,enabled:false,available:null,ok:true,output:null,required:false};
  const resolved=commandFor(cwd);
  if(!resolved.enabled)return {supported:true,enabled:false,available:null,ok:true,output:null,required:false};
  const required=resolved.config?.requireDiffWitness===true;
  if(resolved.error)return {supported:true,enabled:true,available:null,ok:false,required:true,errorCode:resolved.error.code||'DIFFWITNESS_INTEGRATION_CONFIG_INVALID',message:String(resolved.error.message||resolved.error)};
  const result=spawnCommand(resolved.command,['ide-hook',mapped],{
    cwd,
    input:JSON.stringify({...event,cwd}),
    encoding:'utf8',
    windowsHide:true,
    timeout:timeoutFor(eventName),
    maxBuffer:4*1024*1024,
    env:{...process.env}
  });
  if(result.error){
    return {supported:true,enabled:true,available:false,ok:false,required,errorCode:result.error.code||'SPAWN_FAILED',message:String(result.error.message||result.error).slice(0,800)};
  }
  if(result.status!==0){
    return {supported:true,enabled:true,available:true,ok:false,required,errorCode:'DIFFWITNESS_HOOK_FAILED',message:String(result.stderr||result.stdout||`DiffWitness exited ${result.status}`).trim().slice(0,1200)};
  }
  const parsed=eventName==='Stop'
    ? validateDiffWitnessStopOutput(result.stdout)
    : {ok:true,output:parseLastJson(result.stdout)};
  if(!parsed.ok){
    return {
      supported:true,enabled:true,available:true,ok:false,required,
      errorCode:'DIFFWITNESS_STOP_PROTOCOL_INVALID',
      // Do not echo stdout: it is untrusted and could contain sensitive data.
      message:`DiffWitness returned an incompatible Stop protocol (${parsed.reason}). The task is unverified. Use the qualified Core executable and reinstall the project integration.`
    };
  }
  return {supported:true,enabled:true,available:true,ok:true,required,output:parsed.output,stderr:String(result.stderr||'').trim().slice(0,800)};
}

// Whether a native DiffWitness Stop judges this project's completions (an unreadable configuration counts).
export function diffWitnessGateConfigured(cwd=process.cwd()){
  return commandFor(cwd).enabled;
}

export function diffWitnessRequiredFailure(result){
  const reason=String(result?.message||'DiffWitness is unavailable for this project.').slice(0,1200);
  return {
    decision:'block',
    reason:`DiffWitness cannot establish Proof/Debt evidence: ${reason}`,
    systemMessage:`DiffWitness cannot establish Proof/Debt evidence: ${reason}`
  };
}

export const __diffWitnessBridgeTest={EVENT_MAP,parseLastJson,timeoutFor,commandFor};
