import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installCursor, uninstallCursor, hasCursorInstall } from '../src/install-cursor.mjs';
import { projectPaths } from '../src/paths.mjs';
import { loadState } from '../src/state.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const BIN=path.join(ROOT,'bin','idleproof.mjs');
const CURSOR_HOOK=path.join(ROOT,'src','cursor-hook-cli.mjs');

function repo() {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-cursor-'));
  execFileSync('git',['init','-q'],{cwd});
  execFileSync('git',['config','user.email','cursor@example.test'],{cwd});
  execFileSync('git',['config','user.name','Cursor Test'],{cwd});
  fs.writeFileSync(path.join(cwd,'app.js'),'export const refund = (x) => x;\n');
  execFileSync('git',['add','.'],{cwd});
  execFileSync('git',['commit','-qm','base'],{cwd});
  return cwd;
}

function runCursorHook(cwd,event,payload,sessionId='cursor-session-1') {
  const env={...process.env,CURSOR_PROJECT_DIR:cwd,IDLEPROOF_CURSOR_SESSION_ID:sessionId};
  return spawnSync(process.execPath,[CURSOR_HOOK,event],{
    cwd,env,input:JSON.stringify(payload),encoding:'utf8',timeout:10000
  });
}

test('Cursor installer preserves unrelated hooks and uninstall removes only IdleProof',()=>{
  const cwd=repo();
  try {
    const paths=projectPaths(cwd);
    fs.mkdirSync(path.dirname(paths.cursorHooks),{recursive:true});
    fs.writeFileSync(paths.cursorHooks,JSON.stringify({version:1,hooks:{afterFileEdit:[{command:'echo keep-me'}]}},null,2));
    const installed=installCursor({cwd,binPath:BIN});
    assert.equal(installed.hooks,paths.cursorHooks);
    assert.equal(hasCursorInstall(cwd),true);
    const config=JSON.parse(fs.readFileSync(paths.cursorHooks,'utf8'));
    assert.equal(config.hooks.afterFileEdit[0].command,'echo keep-me');
    for (const event of ['sessionStart','beforeSubmitPrompt','preToolUse','postToolUse','stop','sessionEnd']) {
      assert.ok(config.hooks[event].some((entry)=>entry.command.includes('cursor-hook-cli.mjs') && entry.command.includes(event)));
    }
    assert.match(fs.readFileSync(paths.cursorRule,'utf8'),/idleproof-continuity-local-v1/);
    const exclude=fs.readFileSync(path.join(cwd,'.git','info','exclude'),'utf8');
    assert.match(exclude,/\.cursor\/hooks\.json/);
    assert.match(exclude,/\.cursor\/rules\/idleproof-continuity\.mdc/);
    assert.equal(uninstallCursor({cwd}),true);
    assert.equal(hasCursorInstall(cwd),false);
    const after=JSON.parse(fs.readFileSync(paths.cursorHooks,'utf8'));
    assert.equal(after.hooks.afterFileEdit[0].command,'echo keep-me');
    assert.equal(fs.existsSync(paths.cursorRule),false);
  } finally { fs.rmSync(cwd,{recursive:true,force:true}); }
});

test('Cursor hooks keep one active task across a weak follow-up and materialize local context',()=>{
  const cwd=repo();
  try {
    const start=runCursorHook(cwd,'sessionStart',{session_id:'cursor-session-1'});
    assert.equal(start.status,0,start.stderr);
    const startOut=JSON.parse(start.stdout);
    assert.equal(startOut.env.IDLEPROOF_CURSOR_SESSION_ID,'cursor-session-1');
    assert.match(startOut.additional_context,/IdleProof is active/);

    const first=runCursorHook(cwd,'beforeSubmitPrompt',{prompt:'Implement partial refunds safely'});
    assert.equal(first.status,0,first.stderr);
    assert.deepEqual(JSON.parse(first.stdout),{continue:true});
    let state=loadState(cwd);
    const session=state.sessions['cursor-session-1'];
    assert.ok(session);
    assert.match(session.task.id,/^dwtask_[a-f0-9]{24}$/);
    const taskId=session.task.id;
    assert.equal(session.task.anchor,'Implement partial refunds safely');
    const localContext=fs.readFileSync(projectPaths(cwd).cursorTaskContext,'utf8');
    assert.match(localContext,new RegExp(taskId));
    assert.match(localContext,/Primary objective: Implement partial refunds safely/);

    const follow=runCursorHook(cwd,'beforeSubmitPrompt',{prompt:'yes, continue'});
    assert.equal(follow.status,0,follow.stderr);
    state=loadState(cwd);
    assert.equal(state.sessions['cursor-session-1'].task.id,taskId);
    assert.equal(state.sessions['cursor-session-1'].task.anchor,'Implement partial refunds safely');
    assert.equal(state.sessions['cursor-session-1'].lastTaskBoundary,'continued');
  } finally { fs.rmSync(cwd,{recursive:true,force:true}); }
});
