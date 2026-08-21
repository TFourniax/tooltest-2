import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { processHookLifecycle } from '../src/hook.mjs';
import { loadState, computeMetrics } from '../src/state.mjs';
import { buildPortalSnapshot, assertPortalSnapshotSafe, __portalTest } from '../src/portal-snapshot.mjs';
import { extractTaskSignals } from '../src/context.mjs';
import { buildPlainExplanation } from '../src/explain.mjs';

function repo() {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-large-input-'));
  execFileSync('git',['init','-q'],{cwd});
  execFileSync('git',['config','user.email','large@idleproof.local'],{cwd});
  execFileSync('git',['config','user.name','IdleProof Large Input'],{cwd});
  fs.mkdirSync(path.join(cwd,'src'),{recursive:true});
  fs.writeFileSync(path.join(cwd,'src','opaque.ts'),'export function processOpaque(value) { return value; }\n');
  execFileSync('git',['add','.'],{cwd});
  execFileSync('git',['commit','-qm','baseline'],{cwd});
  return cwd;
}

test('multi-megabyte prompt and tool payload remain bounded and never enter provenance or Portal raw',()=>{
  const cwd=repo();
  const marker='SHOULD_NEVER_ENTER_RECORDER_OR_PORTAL_7f4e';
  const hugePrompt=`Change processOpaque safely. ${marker} `+'p'.repeat(2_000_000);
  const hugeToolContent=`${marker}\n`+'x'.repeat(2_000_000);
  const session_id='huge-input-session';
  try {
    processHookLifecycle({cwd,session_id,source:'claude',hook_event_name:'UserPromptSubmit',prompt:hugePrompt});
    processHookLifecycle({
      cwd,session_id,source:'claude',hook_event_name:'PreToolUse',tool_name:'Edit',
      tool_input:{file_path:path.join(cwd,'src','opaque.ts'),content:hugeToolContent}
    });

    const state=loadState(cwd);
    const session=state.sessions[session_id];
    assert.ok(session);
    assert.ok(session.prompt.length<=1200,`durable prompt retention grew to ${session.prompt.length}`);
    assert.ok((session.events||[]).every((event)=>!JSON.stringify(event).includes(marker)),'raw marker leaked into durable session events');

    const eventsPath=path.join(cwd,'.idleproof','events.jsonl');
    const eventsRaw=fs.readFileSync(eventsPath,'utf8');
    assert.ok(!eventsRaw.includes(marker),'raw prompt/tool payload leaked into provenance JSONL');
    assert.ok(Buffer.byteLength(eventsRaw,'utf8')<64*1024,`two huge hook events inflated provenance log to ${Buffer.byteLength(eventsRaw,'utf8')} bytes`);
    const records=eventsRaw.trim().split(/\r?\n/).map((line)=>JSON.parse(line));
    assert.equal(records.length,2);
    assert.ok(records.every((record)=>/^([a-f0-9]{64})$/.test(record.event.payloadDigest)),'payload digest missing');
    assert.ok(records.some((record)=>record.event.inputBytes>2_000_000),'provenance lost the fact that a huge payload was observed');

    const taskSignals=extractTaskSignals(cwd,session);
    const explanation=buildPlainExplanation({session:{...session,taskSignals},phase:'implement'});
    const snapshot=buildPortalSnapshot({
      state:{...state,metrics:computeMetrics(state)},
      session:{...session,taskSignals},
      explanation
    });
    assert.equal(assertPortalSnapshotSafe(snapshot),true);
    const serialized=JSON.stringify(snapshot);
    assert.ok(!serialized.includes(marker),'raw marker leaked into Portal snapshot');
    assert.ok(Buffer.byteLength(serialized,'utf8')<__portalTest.MAX_SNAPSHOT_BYTES);
    assert.equal(snapshot.task.promptChars,session.prompt.length,'Portal reports bounded local task context rather than pretending to retain raw prompt size');
    assert.match(snapshot.task.promptDigest,/^sha256:[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(cwd,{recursive:true,force:true,maxRetries:12,retryDelay:100});
  }
});
