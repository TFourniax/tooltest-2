import fs from 'node:fs';
import process from 'node:process';
import { processHookLifecycle } from './hook.mjs';
import { queueMatchingDiffWitnessAssurance } from './ide-assurance.mjs';
import { diffWitnessRequiredFailure, runDiffWitnessIdeHook } from './diffwitness-bridge.mjs';
import { projectPaths } from './paths.mjs';

const EVENT_MAP = {
  sessionStart:'SessionStart',
  beforeSubmitPrompt:'UserPromptSubmit',
  preToolUse:'PreToolUse',
  postToolUse:'PostToolUse',
  postToolUseFailure:'PostToolUseFailure',
  subagentStart:'SubagentStart',
  subagentStop:'SubagentStop',
  stop:'Stop',
  sessionEnd:'SessionEnd'
};

async function stdinJson() {
  let raw='';
  for await (const chunk of process.stdin) raw+=chunk;
  if (!raw.trim()) return {};
  try { const value=JSON.parse(raw); return value && typeof value==='object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}

function internalTool(name='') {
  const value=String(name||'');
  if (value==='Shell') return 'Bash';
  return value;
}

function additionalContext(output){
  const value=output?.hookSpecificOutput?.additionalContext;
  return typeof value==='string'&&value.trim()?value.trim():'';
}

function writeTaskContext(cwd,...outputs) {
  const additional=outputs.map(additionalContext).filter(Boolean).join('\n\n').slice(0,12000);
  if (!additional) return false;
  const paths=projectPaths(cwd);
  fs.mkdirSync(paths.dir,{recursive:true});
  const temp=`${paths.cursorTaskContext}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp,`${additional}\n`,{encoding:'utf8',mode:0o600});
    fs.renameSync(temp,paths.cursorTaskContext);
    return true;
  } finally { try { fs.rmSync(temp,{force:true}); } catch {} }
}

function sessionStartOutput(sessionId,warning='') {
  return {
    env:{ IDLEPROOF_CURSOR_SESSION_ID:sessionId },
    additional_context:[
      'Defitness is active as a local task-understanding, Proof, software-debt and Project Continuity layer for this workspace.',
      'Before planning or mutating code on each turn, follow the local IdleProof rule and read .idleproof/cursor-current-task.md when present.',
      'Treat DECLARED/INFERRED/OBSERVED/VERIFIED as distinct epistemic levels. Only executed DiffWitness evidence can establish VERIFIED correctness.',
      warning
    ].filter(Boolean).join(' ')
  };
}

function nativePolicyOutput(lifecycle) {
  const decision=lifecycle?.policyDecision;
  if (!decision) return null;
  if (decision.decision==='deny' || decision.decision==='ask') {
    return {
      permission:'deny',
      user_message:String(decision.reason||'IdleProof policy blocked this action.').slice(0,1200),
      agent_message:String(decision.reason||'IdleProof policy blocked this action.').slice(0,1200)
    };
  }
  return { permission:'allow' };
}

function cursorStopOutput(diffResult){
  if(!diffResult?.ok){
    if(!diffResult?.required)return null;
    const failure=diffWitnessRequiredFailure(diffResult);
    return {decision:'block',reason:failure.reason};
  }
  const value=diffResult.output;
  if(!value)return null;
  if(diffResult.required && /not armed|session state is invalid/i.test(String(value.systemMessage||value.reason||''))){
    const failure=diffWitnessRequiredFailure({message:String(value.systemMessage||value.reason)});
    return {decision:'block',reason:failure.reason};
  }
  if(value.decision==='block')return {decision:'block',reason:String(value.reason||value.systemMessage||'DiffWitness evidence did not pass.').slice(0,3000)};
  return null;
}

async function run() {
  const nativeName=process.argv[2];
  const eventName=EVENT_MAP[nativeName];
  if (!eventName) throw new Error(`Unknown Cursor hook event: ${String(nativeName)}`);
  const input=await stdinJson();
  const cwd=String(input.cwd || process.env.CURSOR_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const sessionId=String(
    input.session_id || input.conversation_id || input.parent_conversation_id ||
    process.env.IDLEPROOF_CURSOR_SESSION_ID || 'cursor-default'
  );
  const event={
    ...input,
    cwd,
    session_id:sessionId,
    source:'cursor',
    hook_event_name:eventName,
    tool_name:internalTool(input.tool_name)
  };
  const lifecycle=processHookLifecycle(event);
  let diffResult=null;
  if(['SessionStart','UserPromptSubmit','Stop'].includes(eventName)) diffResult=runDiffWitnessIdeHook({cwd,eventName,event});

  if (nativeName==='sessionStart') {
    const warning=diffResult?.required&&!diffResult.ok ? `Proof bridge degraded: ${String(diffResult.message||'DiffWitness unavailable').slice(0,500)}` : '';
    process.stdout.write(`${JSON.stringify(sessionStartOutput(sessionId,warning))}\n`);
    return;
  }
  if (nativeName==='beforeSubmitPrompt') {
    writeTaskContext(cwd,lifecycle?.hookOutput,diffResult?.ok?diffResult.output:null);
    process.stdout.write('{"continue":true}\n');
    return;
  }
  if (nativeName==='preToolUse' || nativeName==='subagentStart') {
    const value=nativePolicyOutput(lifecycle);
    if (value) process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (nativeName==='postToolUse') {
    const message=lifecycle?.hookOutput?.systemMessage;
    if (typeof message==='string' && message.trim()) process.stdout.write(`${JSON.stringify({additional_context:message.slice(0,2200)})}\n`);
    return;
  }
  if(nativeName==='stop'){
    queueMatchingDiffWitnessAssurance(cwd);
    const stopOutput=cursorStopOutput(diffResult);
    if(stopOutput)process.stdout.write(`${JSON.stringify(stopOutput)}\n`);
    return;
  }
  if (['sessionEnd','subagentStop'].includes(nativeName)) queueMatchingDiffWitnessAssurance(cwd);
}

run().catch((error)=>{
  process.stderr.write(`IdleProof Cursor hook degraded: ${String(error?.message||error).slice(0,500)}\n`);
  process.exitCode=1;
});
