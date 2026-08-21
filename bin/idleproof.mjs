#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../src/cli.mjs';
import { learningCliHelp, runLearningCli } from '../src/learning-cli.mjs';
import { runDemo } from '../src/demo.mjs';
import { repairLocalState } from '../src/recovery.mjs';

const args = process.argv.slice(2);

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isInteger(port) || port < 1) reject(new Error('Could not allocate a local IdleProof port.'));
        else resolve(port);
      });
    });
  });
}

function commandAvailable(command) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const found = spawnSync(finder, [command], {
    cwd:process.cwd(),
    stdio:'ignore',
    windowsHide:true,
    timeout:1000
  });
  return !found.error && found.status === 0;
}

function detectAgent(cwd = process.cwd()) {
  // Existing project conventions are stronger evidence than whatever happens to be globally on PATH.
  // This intentionally does not inspect or transmit user configuration content.
  const projectClaude = fs.existsSync(path.join(cwd, '.claude'));
  const projectCodex = fs.existsSync(path.join(cwd, '.codex'));
  if (projectClaude && projectCodex) return 'all';
  if (projectCodex) return 'codex';
  if (projectClaude) return 'claude';

  const hasClaude = commandAvailable('claude');
  const hasCodex = commandAvailable('codex');
  if (hasClaude && hasCodex) return 'all';
  if (hasCodex) return 'codex';
  if (hasClaude) return 'claude';

  // Preserve the historical default when no signal exists, while making the choice explicit in output.
  return 'claude';
}

async function runtimeArgs(cmd) {
  let resolved = [...args];
  if (cmd === 'on' && !resolved.includes('--agent')) {
    const agent = detectAgent();
    resolved.push('--agent', agent);
    console.log(`✓ Agent adapter auto-detected: ${agent}`);
  }
  if (['on', 'start'].includes(cmd) && !resolved.includes('--port')) {
    // Normal users should not have to understand ports. Pick a free loopback port for background
    // mode; an explicit --port remains strict and is never silently changed.
    resolved.push('--port', String(await freeLoopbackPort()));
  }
  return resolved;
}

function printRepair(result, repairArgs) {
  if (repairArgs.includes('--json')) {
    console.log(JSON.stringify(result,null,2));
    return;
  }
  if (repairArgs.includes('--dry-run')) {
    console.log(`IdleProof repair plan: ${result.action}`);
    console.log(`Primary state: ${result.primary.present ? (result.primary.valid ? 'healthy' : result.primary.reason) : 'not created'} · backup: ${result.backup.present ? (result.backup.valid ? 'healthy' : result.backup.reason) : 'not created'}`);
    console.log(result.recoverable ? 'No destructive fallback is required.' : 'Automatic repair is intentionally unavailable; preserve the files and inspect them manually.');
    return;
  }
  if (result.changed) {
    console.log('✓ IdleProof state restored from its last verified compatible backup.');
    if (result.archive) console.log(`  Corrupt primary archived at ${result.archive}`);
    console.log('  Hooks, policy, provenance and source files were not reset.');
    return;
  }
  if (!result.primary.present && !result.backup.present) {
    console.log('✓ IdleProof has no local learning state yet; nothing needs repair.');
    return;
  }
  console.log('✓ IdleProof local state is already readable; no repair was needed.');
}

async function run() {
  const cmd = args[0] || 'help';
  if (['help', '--help', '-h'].includes(cmd)) {
    await main(args);
    process.stdout.write(`${learningCliHelp()}\n`);
    process.stdout.write('\nRecovery & support:\n  idleproof support [--json|--out FILE]\n  idleproof repair [--dry-run] [--json]\n');
    return;
  }
  if (cmd === 'support') {
    await import('./idleproof-support.mjs');
    return;
  }
  if (cmd === 'repair') {
    const result=repairLocalState(process.cwd(),{dryRun:args.includes('--dry-run')});
    printRepair(result,args.slice(1));
    return;
  }
  if (cmd === 'demo') {
    await runDemo(args.slice(1));
    return;
  }
  if (await runLearningCli(args)) return;
  await main(await runtimeArgs(cmd));
}

run().catch((error) => {
  console.error(`[idleproof] ${error?.stack || error}`);
  process.exitCode = 1;
});
