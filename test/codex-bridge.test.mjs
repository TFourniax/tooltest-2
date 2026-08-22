import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { mapCodexExecItem, parseCodexBridgeArgs, runCodexBridge } from '../src/codex-bridge.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim();
}

function sink() {
  let value = '';
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { value += String(chunk); callback(); } }),
    text: () => value,
  };
}

test('Codex bridge CLI parser refuses unsafe sandbox modes', () => {
  assert.deepEqual(parseCodexBridgeArgs(['--model','gpt-test','--sandbox','workspace-write','--','fix','the','bug']), {
    model:'gpt-test', sandbox:'workspace-write', prompt:'fix the bug',
  });
  assert.throws(() => parseCodexBridgeArgs(['--sandbox','danger-full-access','--','fix it']), /only permits/);
  assert.throws(() => parseCodexBridgeArgs(['--yolo','fix it']), /Unsupported/);
  assert.throws(() => parseCodexBridgeArgs([]), /Usage/);
});

test('Codex JSON items map to bounded lifecycle metadata without command output', () => {
  const command = mapCodexExecItem({
    type:'command_execution', status:'completed', command:'curl https://secret.invalid/?token=raw-secret', aggregated_output:'raw-secret', exit_code:0,
  });
  assert.equal(command.length,1);
  assert.equal(command[0].hook_event_name,'PostToolUse');
  assert.equal(command[0].tool_name,'Bash');
  assert.equal(JSON.stringify(command).includes('raw-secret'),false);

  const files = mapCodexExecItem({
    type:'file_change', status:'completed', changes:[{path:'src/a.ts',kind:'update'},{path:'test/a.test.ts',kind:'add'}],
  });
  assert.deepEqual(files.map((item)=>item.tool_input.file_path),['src/a.ts','test/a.test.ts']);
});

test('hook-independent Codex exec bridge records a real git change and receipt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-codex-bridge-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  git(root,'init','-q');
  git(root,'config','user.email','codex-bridge@idleproof.local');
  git(root,'config','user.name','Codex Bridge Test');
  fs.writeFileSync(path.join(root,'app.js'),'export const answer = 1;\n');
  git(root,'add','app.js');
  git(root,'commit','-qm','baseline');

  const fake = path.join(root,'fake-codex.mjs');
  fs.writeFileSync(fake, `
import fs from 'node:fs';
const cwd=process.cwd();
const emit=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
emit({type:'thread.started',thread_id:'019f-test-codex-bridge'});
await new Promise((resolve)=>setTimeout(resolve,120));
emit({type:'turn.started'});
emit({type:'item.started',item:{id:'cmd1',type:'command_execution',command:'node -v',status:'in_progress'}});
emit({type:'item.completed',item:{id:'cmd1',type:'command_execution',command:'node -v',aggregated_output:'v99.0.0',exit_code:0,status:'completed'}});
fs.writeFileSync(cwd+'/app.js','export const answer = 42;\\n');
emit({type:'item.completed',item:{id:'patch1',type:'file_change',changes:[{path:cwd+'/app.js',kind:'update'}],status:'completed'}});
emit({type:'item.completed',item:{id:'msg1',type:'agent_message',text:'Fixed the value.'}});
emit({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:1,reasoning_output_tokens:0}});
`,{mode:0o700});

  const out=sink();
  const err=sink();
  const prompt='Fix the private customer token bug without exposing raw-token-123.';
  const result=await runCodexBridge({
    cwd:root,
    prompt,
    codexCommand:[process.execPath,fake],
    stdout:out.stream,
    stderr:err.stream,
  });

  assert.equal(result.code,0);
  assert.equal(result.turnFailed,false);
  assert.equal(result.nativeHooks,false);
  assert.equal(result.counts.commands,1);
  assert.equal(result.counts.fileChanges,1);
  assert.match(out.text(),/JSON fallback/);
  assert.match(out.text(),/Fixed the value/);

  const receiptPath=path.join(root,'.idleproof','receipt.json');
  assert.equal(fs.existsSync(receiptPath),true);
  const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
  assert.equal(receipt.session.source,'codex-json-bridge');
  assert.equal(receipt.session.files.includes('app.js'),true);
  assert.match(receipt.session.change.changeId,/^dwchg_[a-f0-9]{24}$/);
  assert.equal(receipt.session.proof.changeId,receipt.session.change.changeId);
  assert.equal(receipt.session.intent.chars,prompt.length);
  assert.match(receipt.session.intent.sha256,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(receipt).includes('raw-token-123'),false);
  assert.equal(JSON.stringify(receipt).includes('v99.0.0'),false);
  assert.equal(git(root,'diff','--','app.js').includes('42'),true);
});
