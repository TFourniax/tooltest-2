import { spawnSync } from 'node:child_process';
import { readDefitnessConfig } from './defitness-config.mjs';

const EVENT_MAP=new Map([
  ['SessionStart','session-start'],
  ['UserPromptSubmit','user-prompt-submit'],
  ['Stop','session-stop']
]);

function commandFor(cwd){
  let config=null;
  try{config=readDefitnessConfig(cwd);}catch(error){return {config:{requireDiffWitness:true},command:null,error};}
  const command=config?.diffWitnessCommand || process.env.DEFITNESS_DIFFWITNESS_BIN || process.env.DIFFWITNESS_BIN || 'dw';
  return {config,command,error:null};
}

function parseLastJson(stdout=''){
  const lines=String(stdout||'').split(/\r?\n/).map((line)=>line.trim()).filter(Boolean);
  for(let i=lines.length-1;i>=0;i-=1){
    try{return JSON.parse(lines[i]);}catch{}
  }
  return null;
}

function timeoutFor(eventName){
  if(eventName==='Stop'){
    const configured=Number(process.env.DEFITNESS_DIFFWITNESS_STOP_TIMEOUT_MS || 905000);
    return Number.isFinite(configured)&&configured>=1000?Math.min(configured,1_800_000):905000;
  }
  return 8000;
}

export function probeDiffWitness(cwd=process.cwd(),commandOverride=null){
  let selected=commandOverride;
  if(!selected){
    const resolved=commandFor(cwd);
    if(resolved.error)return {ok:false,command:null,errorCode:resolved.error.code||'DEFITNESS_CONFIG_INVALID',message:String(resolved.error.message||resolved.error)};
    selected=resolved.command;
  }
  selected=selected || 'dw';
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

export function runDiffWitnessIdeHook({cwd=process.cwd(),eventName,event={}}={}){
  const mapped=EVENT_MAP.get(String(eventName||''));
  if(!mapped)return {supported:false,available:null,ok:true,output:null,required:false};
  const resolved=commandFor(cwd);
  const required=resolved.config?.requireDiffWitness===true;
  if(resolved.error)return {supported:true,available:null,ok:false,required:true,errorCode:resolved.error.code||'DEFITNESS_CONFIG_INVALID',message:String(resolved.error.message||resolved.error)};
  const result=spawnSync(resolved.command,[ 'ide-hook', mapped ],{
    cwd,
    input:JSON.stringify({...event,cwd}),
    encoding:'utf8',
    windowsHide:true,
    timeout:timeoutFor(eventName),
    maxBuffer:4*1024*1024,
    env:{...process.env}
  });
  if(result.error){
    return {supported:true,available:false,ok:false,required,errorCode:result.error.code||'SPAWN_FAILED',message:String(result.error.message||result.error).slice(0,800)};
  }
  if(result.status!==0){
    return {supported:true,available:true,ok:false,required,errorCode:'DIFFWITNESS_HOOK_FAILED',message:String(result.stderr||result.stdout||`DiffWitness exited ${result.status}`).trim().slice(0,1200)};
  }
  return {supported:true,available:true,ok:true,required,output:parseLastJson(result.stdout),stderr:String(result.stderr||'').trim().slice(0,800)};
}

export function diffWitnessRequiredFailure(result){
  const reason=String(result?.message||'DiffWitness is unavailable for this Defitness project.').slice(0,1200);
  return {
    decision:'block',
    reason:`Defitness cannot establish Proof/Debt evidence: ${reason}`,
    systemMessage:`Defitness cannot establish Proof/Debt evidence: ${reason}`
  };
}

export const __diffWitnessBridgeTest={EVENT_MAP,parseLastJson,timeoutFor,commandFor};
