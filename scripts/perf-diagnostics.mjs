// Diagnostic only: this instrumented run cannot qualify a latency gate.
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';

const calls = new Map();
const restore = [];
function observe(target, name, prefix) {
  const original = target[name];
  function wrapped(...args) {
    const start = performance.now();
    try { return Reflect.apply(original, this, args); }
    finally {
      const ms = performance.now() - start;
      const key = `${prefix}.${name}`;
      const entry = calls.get(key) || { count:0, totalMs:0, maxMs:0, over50ms:0 };
      entry.count++; entry.totalMs += ms; entry.maxMs = Math.max(entry.maxMs, ms);
      if(ms > 50) entry.over50ms++;
      calls.set(key, entry);
    }
  }
  Object.assign(wrapped, original);
  target[name] = wrapped;
  restore.push(() => { target[name] = original; });
}
for(const name of ['readFileSync','writeFileSync','appendFileSync','renameSync','rmSync',
  'mkdirSync','statSync','lstatSync','openSync','closeSync','readSync','writeSync','fsyncSync','realpathSync']) {
  observe(fs, name, 'fs');
}
for(const name of ['spawnSync','execFileSync']) observe(cp, name, 'child_process');
syncBuiltinESMExports();
const started = performance.now();
const cpu = process.cpuUsage();
try { await import('./perf-gate.mjs'); }
finally {
  const elapsedMs = performance.now() - started;
  const cpuMicroseconds = process.cpuUsage(cpu);
  for(const reset of restore) reset();
  syncBuiltinESMExports();
  console.log(JSON.stringify({schema:'idleproof-perf-diagnostic-1', qualification:false,
    note:'Instrumented timings are diagnostic only. Calls may nest; totals are inclusive. CPU excludes child processes.',
    elapsedMs, cpuMicroseconds, resourceUsage:process.resourceUsage(),
    calls:Object.fromEntries(calls)}));
}
