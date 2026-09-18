import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readHookPayload } from '../src/hook-input.mjs';

test('native UTF-8 decoder preserves every multibyte split boundary', async () => {
  const event={prompt:'Créer 🧪 𐐀 日本語',session_id:'unicode'};
  const bytes=Buffer.from(JSON.stringify(event));
  for (let split=1;split<bytes.length;split+=1) {
    const chunks=(async function*(){yield bytes.subarray(0,split);yield bytes.subarray(split);})();
    assert.deepEqual(await readHookPayload(chunks),event,`split byte ${split}`);
  }
});

test('native reader rejects invalid UTF-8 without replacement', async () => {
  for (const bytes of [Buffer.from([123,34,120,34,58,34,255,34,125]),Buffer.from('\ufeff{"prompt":"unaccepted BOM"}')]) {
    const chunks=(async function*(){yield bytes;})();
    assert.deepEqual(await readHookPayload(chunks),{});
  }
});

test('corrupt sidecar state cannot skip required Stop assurance in either native runner', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-failure-'));
  try {
    const dir=path.join(root,'.idleproof');fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir,'state.json'),'{corrupt');
    fs.writeFileSync(path.join(dir,'state.json.bak'),'{also-corrupt');
    for (const config of [{schema:'wrong'}, ...[path.join(root,'missing-engine'),'invalid\0command'].map(command=>({schema:'diffwitness.integration-config.v1',requireDiffWitness:true,diffWitnessCommand:command,adapters:['claude','codex']}))]) {
      fs.writeFileSync(path.join(dir,'diffwitness.json'),JSON.stringify(config));
      for (const provider of ['claude','codex']) {
        const result=spawnSync(process.execPath,[fileURLToPath(new URL('../bin/idleproof-hook.mjs',import.meta.url)),provider],{
          cwd:root,input:JSON.stringify({cwd:root,session_id:'broken-state',hook_event_name:'Stop'}),encoding:'utf8',windowsHide:true,timeout:10000
        });
        assert.equal(result.status,0,result.stderr);
        assert.ok(result.stdout.trim(),`${provider} silently skipped required assurance: ${result.stderr}`);
        const output=JSON.parse(result.stdout.trim());
        assert.equal(output.decision,'block');
        assert.match(output.reason,/cannot establish Proof\/Debt evidence/);
        assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8'),'{corrupt');
      }
    }
    fs.unlinkSync(path.join(dir,'diffwitness.json'));
    const standalone=spawnSync(process.execPath,[fileURLToPath(new URL('../bin/idleproof-hook.mjs',import.meta.url)),'codex'],{
      cwd:root,input:JSON.stringify({cwd:root,session_id:'standalone',hook_event_name:'Stop'}),encoding:'utf8',windowsHide:true,timeout:10000
    });
    assert.equal(standalone.status,0,standalone.stderr);
    const output=JSON.parse(standalone.stdout.trim());
    assert.equal(output.decision,undefined);
    assert.match(output.systemMessage,/context is unavailable/);
  } finally {fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});}
});
