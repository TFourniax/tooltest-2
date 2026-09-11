import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHookDelivery } from '../src/delivery.mjs';
import { freshState } from '../src/state.mjs';

test('IDE delivery uses exact project facts and is suppressed when nothing meaningful changed',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-delivery-'));
  try {
    fs.mkdirSync(path.join(cwd,'src','odd'),{recursive:true});
    fs.writeFileSync(path.join(cwd,'src','odd','receiver.go'),'package odd\nfunc ReceiveWidget() {}\n');
    const state=freshState(cwd);
    const session={id:'s1',status:'active',prompt:'Receive a widget safely',currentTool:'Edit',currentCapabilities:['code.modify'],touchedFiles:['src/odd/receiver.go'],concepts:{},events:[]};
    state.sessions.s1=session;
    const first=buildHookDelivery(cwd,state,session,'PostToolUse');
    assert.ok(first);
    assert.match(first.message,/src\/odd\/receiver\.go/);
    assert.match(first.message,/ReceiveWidget/);
    session.lastSurfacedExplanationKey=first.key;
    assert.equal(buildHookDelivery(cwd,state,session,'PostToolUse'),null);
  } finally { fs.rmSync(cwd,{recursive:true,force:true}); }
});

test('handoff gets a new explanation key and explicit proof boundary',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-delivery-stop-'));
  try {
    fs.mkdirSync(path.join(cwd,'src'),{recursive:true});
    fs.writeFileSync(path.join(cwd,'src','thing.ts'),'export function changeThing() { return true; }\n');
    const state=freshState(cwd);
    const session={id:'s1',status:'complete',prompt:'Change the thing',currentTool:null,currentCapabilities:[],touchedFiles:['src/thing.ts'],concepts:{},events:[],proof:{diffSha256:'a'.repeat(64)}};
    state.sessions.s1=session;
    const result=buildHookDelivery(cwd,state,session,'Stop');
    assert.ok(result);
    assert.equal(result.phase,'handoff');
    assert.match(result.message,/does not claim the code is correct/i);
    assert.match(result.message,/DiffWitness/);
  } finally { fs.rmSync(cwd,{recursive:true,force:true}); }
});
