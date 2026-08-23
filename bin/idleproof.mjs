#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.mjs';
import { runCodexBridgeCli } from '../src/codex-bridge.mjs';
import { learningCliHelp, runLearningCli } from '../src/learning-cli.mjs';
import { portalCliHelp, runPortalCli } from '../src/portal-cli.mjs';
import { runDemo } from '../src/demo.mjs';
import { repairLocalState } from '../src/recovery.mjs';
import { installCursor, uninstallCursor } from '../src/install-cursor.mjs';

const args = process.argv.slice(2);
const BIN_PATH = fileURLToPath(import.meta.url);

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
  const projectSignals = [
    ['claude', fs.existsSync(path.join(cwd,'.claude'))],
    ['codex', fs.existsSync(path.join(cwd,'.codex'))],
    ['cursor', fs.existsSync(path.join(cwd,'.cursor'))]
  ].filter(([,present])=>present).map(([name])=>name);
  if (projectSignals.length > 1) return 'all';
  if (projectSignals.length === 1) return projectSignals[0];

  const available = [
    ['claude', commandAvailable('claude')],
    ['codex', commandAvailable('codex')],
    ['cursor', commandAvailable('cursor')]
  ].filter(([,present])=>present).map(([name])=>name);
  if (available.length > 1) return 'all';
  if (available.length === 1) return available[0];
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
    resolved.push('--port', String(await freeLoopbackPort()));
  }
  return resolved;
}

function optionValue(values,key) {
  const index=values.indexOf(key);
  return index>=0 && values[index+1] != null ? values[index+1] : null;
}

function withoutAgentOption(values) {
  const result=[];
  for (let i=0;i<values.length;i+=1) {
    if (values[i]==='--agent') { i+=1; continue; }
    result.push(values[i]);
  }
  return result;
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
    process.stdout.write(`\n${portalCliHelp()}\n`);
    process.stdout.write('\nIDE adapters:\n  idleproof on --agent claude|codex|cursor|all\n  Cursor local mode uses native hooks plus a local always-on continuity rule; source/project identity stays unchanged.\n');
    process.stdout.write('\nCodex resilient mode:\n  idleproof codex [--model MODEL] [--sandbox read-only|workspace-write] -- <task>\n  Uses Codex exec JSON telemetry when native project hooks are unavailable; never enables danger-full-access.\n');
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
  if (cmd === 'codex') {
    await runCodexBridgeCli(args.slice(1));
    return;
  }
  if (cmd === 'install' && args[1] === 'cursor') {
    const installed=installCursor({cwd:process.cwd(),binPath:BIN_PATH});
    console.log(`✓ Cursor adapter: ${path.relative(process.cwd(),installed.hooks)}`);
    console.log(`✓ Cursor continuity rule: ${path.relative(process.cwd(),installed.rule)}`);
    return;
  }
  if (cmd === 'uninstall' && args[1] === 'cursor') {
    console.log(uninstallCursor({cwd:process.cwd()}) ? '✓ Cursor IdleProof adapter removed.' : 'No Cursor IdleProof adapter found.');
    return;
  }
  if (cmd === 'install' && args[1] === 'all') installCursor({cwd:process.cwd(),binPath:BIN_PATH});
  if (cmd === 'uninstall' && args[1] === 'all') uninstallCursor({cwd:process.cwd()});
  if (await runPortalCli(args)) return;
  if (await runLearningCli(args)) return;

  const resolved=await runtimeArgs(cmd);
  if (cmd === 'on') {
    const agent=String(optionValue(resolved,'--agent')||'').toLowerCase();
    if (agent === 'cursor') {
      const installed=installCursor({cwd:process.cwd(),binPath:BIN_PATH});
      console.log(`✓ Cursor adapter: ${path.relative(process.cwd(),installed.hooks)}`);
      console.log('✓ Cursor task continuity runs locally; dynamic per-prompt context is read from the hidden IdleProof task file.');
      const startArgs=withoutAgentOption(resolved);
      startArgs[0]='start';
      await main(startArgs);
      console.log('✓ Terminal is free — use Cursor normally; IdleProof runs in the background.');
      return;
    }
    if (agent === 'all') {
      const installed=installCursor({cwd:process.cwd(),binPath:BIN_PATH});
      console.log(`✓ Cursor adapter: ${path.relative(process.cwd(),installed.hooks)}`);
    }
  }
  await main(resolved);
}

run().catch((error) => {
  console.error(`[idleproof] ${error?.stack || error}`);
  process.exitCode = 1;
});
