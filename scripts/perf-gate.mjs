import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { processHookLifecycle } from '../src/hook.mjs';
import { loadState } from '../src/state.mjs';
import { extractTaskSignals } from '../src/context.mjs';

const P95_HOOK_BUDGET_MS = 150;
const MAX_HOOK_BUDGET_MS = 500;
const STOP_BUDGET_MS = 750;
const STATE_LOAD_BUDGET_MS = 100;
const pythonCore = process.argv.includes('--python-core');
const syntaxCore = process.argv.includes('--syntax-core');
const sourceFile = pythonCore ? 'worker.py' : 'worker.ts';

function percentile(values, fraction) {
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function timed(fn) {
  const start = performance.now();
  const value = fn();
  return { value, ms:performance.now() - start };
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-perf-'));
try {
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'perf@idleproof.local'], { cwd });
  execFileSync('git', ['config', 'user.name', 'IdleProof Perf'], { cwd });
  fs.mkdirSync(path.join(cwd, 'src'), { recursive:true });
  fs.writeFileSync(path.join(cwd, 'src', sourceFile), pythonCore ? 'def processThing(value):\n    return value\n'
    : `export async function processThing(value) { return value; }\n`);
  execFileSync('git', ['add', '.'], { cwd });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd });

  const session_id = 'perf-session';
  processHookLifecycle({ cwd, session_id, source:'claude', hook_event_name:'UserPromptSubmit', prompt:'Update processThing safely' });

  const samples = [];
  for (let index = 0; index < 80; index += 1) {
    const event = index % 2 === 0
      ? { cwd, session_id, source:'claude', hook_event_name:'PreToolUse', tool_name:'Read', tool_input:{ file_path:path.join(cwd,'src',sourceFile) } }
      : { cwd, session_id, source:'claude', hook_event_name:'PostToolUse', tool_name:'Read', tool_input:{ file_path:path.join(cwd,'src',sourceFile) } };
    samples.push(timed(()=>processHookLifecycle(event)).ms);
  }

  const p95 = percentile(samples, 0.95);
  const max = Math.max(...samples);
  assert.ok(p95 < P95_HOOK_BUDGET_MS, `hook p95 ${p95.toFixed(1)}ms exceeds ${P95_HOOK_BUDGET_MS}ms`);
  assert.ok(max < MAX_HOOK_BUDGET_MS, `hook max ${max.toFixed(1)}ms exceeds ${MAX_HOOK_BUDGET_MS}ms`);

  if(pythonCore||syntaxCore) {
    const coverage=extractTaskSignals(cwd,{currentResource:`src/${sourceFile}`}).structureCoverage;
    assert.equal(coverage?.canonical,true,'Performance qualification requires the actual Core provider');
    assert.equal(coverage?.parsed,true,'Unparsed coverage cannot qualify provider performance');
    assert.equal(coverage?.provider,pythonCore?'python-ast':'tree-sitter-typescript');
  }
  fs.writeFileSync(path.join(cwd, 'src', sourceFile), pythonCore ? 'def processThing(value):\n    return str(value).strip()\n'
    : `export async function processThing(value) { return String(value).trim(); }\n`);
  const stop = timed(()=>processHookLifecycle({ cwd, session_id, source:'claude', hook_event_name:'Stop' }));
  assert.ok(stop.ms < STOP_BUDGET_MS, `Stop/handoff ${stop.ms.toFixed(1)}ms exceeds ${STOP_BUDGET_MS}ms`);
  assert.ok(stop.value.state.sessions[session_id].proof?.diffSha256, 'Stop performance fixture did not produce its proof binding');

  const stateSamples = [];
  for (let index=0; index<30; index+=1) stateSamples.push(timed(()=>loadState(cwd)).ms);
  const stateP95 = percentile(stateSamples, 0.95);
  assert.ok(stateP95 < STATE_LOAD_BUDGET_MS, `warm state load p95 ${stateP95.toFixed(1)}ms exceeds ${STATE_LOAD_BUDGET_MS}ms`);

  console.log(`IdleProof PERF PASS${pythonCore?' (Python/Core)':syntaxCore?' (TypeScript/Core)':''} · hook p95 ${p95.toFixed(1)}ms · max ${max.toFixed(1)}ms · Stop ${stop.ms.toFixed(1)}ms · state p95 ${stateP95.toFixed(1)}ms`);
} finally {
  fs.rmSync(cwd, { recursive:true, force:true });
}
