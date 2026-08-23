#!/usr/bin/env node
import { processHookLifecycle } from '../src/hook.mjs';
import { queueMatchingDiffWitnessAssurance } from '../src/ide-assurance.mjs';

async function stdinJson() {
  let raw='';
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch { return {}; }
}

async function run() {
  const mode=String(process.argv[2] || 'claude').toLowerCase();
  if (!['claude','codex'].includes(mode)) throw new Error('IdleProof hook runner expects claude or codex.');
  const event=await stdinJson();
  const lifecycle=processHookLifecycle({ ...event, source:mode });
  const eventName=event.hook_event_name || event.type || '';

  if (['Stop','SessionEnd','SubagentStop'].includes(eventName)) {
    // This runs after the receipt has been materialized. If DiffWitness already completed its own
    // Stop hook, the exact envelope is now attached to the Portal queue. If DiffWitness has not run
    // yet, there is deliberately nothing to attach and its later assurance bridge handles the
    // opposite ordering.
    queueMatchingDiffWitnessAssurance(event.cwd || process.cwd());
  }

  if (lifecycle.hookOutput) process.stdout.write(`${JSON.stringify(lifecycle.hookOutput)}\n`);
  else if (mode === 'codex' && ['Stop','SubagentStop'].includes(eventName)) process.stdout.write('{}\n');
}

run().catch((error)=>{
  // Preserve the existing adapter's fail-open semantics for auxiliary understanding/cloud work.
  // Policy/recorder decisions are emitted by processHookLifecycle before this boundary.
  console.error(`[idleproof-hook] ${error?.message || error}`);
  process.exitCode=0;
});
