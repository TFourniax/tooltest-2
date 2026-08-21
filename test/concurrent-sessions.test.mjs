import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processHookEvent } from '../src/hook.mjs';
import { loadState } from '../src/state.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/idleproof.mjs');

function hookProcess(cwd, event) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'hook'], { cwd, stdio:['pipe','pipe','pipe'], windowsHide:true });
    let stdout=''; let stderr='';
    child.stdout.on('data', (chunk)=>{ stdout += chunk; });
    child.stderr.on('data', (chunk)=>{ stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal)=>{
      if (code !== 0) reject(new Error(`hook child failed code=${code} signal=${signal}\nstdout=${stdout}\nstderr=${stderr}`));
      else resolve({stdout,stderr});
    });
    child.stdin.end(`${JSON.stringify(event)}\n`);
  });
}

test('parallel hook processes preserve every independent session without corrupting shared state', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-concurrent-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'concurrency@idleproof.local'], { cwd });
    execFileSync('git', ['config', 'user.name', 'IdleProof Concurrency'], { cwd });
    fs.writeFileSync(path.join(cwd, 'app.js'), 'export const value = 1;\n');
    execFileSync('git', ['add', 'app.js'], { cwd });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd });

    const sessions = Array.from({length:8}, (_, index)=>`parallel-${index}`);
    for (const session_id of sessions) {
      processHookEvent({ cwd, session_id, source:'claude', hook_event_name:'UserPromptSubmit', prompt:`Inspect session ${session_id}` });
    }

    const events=[];
    for (const session_id of sessions) {
      for (let turn=0; turn<3; turn+=1) {
        events.push({ cwd, session_id, source:turn % 2 ? 'codex' : 'claude', hook_event_name:'PreToolUse', tool_name:'Read', tool_input:{ file_path:path.join(cwd,'app.js') }, tool_use_id:`${session_id}-${turn}` });
      }
    }
    await Promise.all(events.map((event)=>hookProcess(cwd,event)));

    const state = loadState(cwd);
    for (const session_id of sessions) {
      const session = state.sessions[session_id];
      assert.ok(session, `lost session ${session_id}`);
      assert.ok((session.events || []).length >= 4, `${session_id} lost concurrent events`);
      assert.ok(session.touchedFiles.some((value)=>value.replaceAll('\\','/').endsWith('app.js')));
    }
    assert.equal(Object.keys(state.sessions).filter((id)=>id.startsWith('parallel-')).length, sessions.length);
  } finally {
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});
