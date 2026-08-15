import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, openBrowser } from './server.mjs';
import { installClaude, uninstallClaude, hasClaudeInstall } from './install.mjs';
import { installCodex, uninstallCodex, hasCodexInstall } from './install-codex.mjs';
import { processHookEvent, seedDemo, buildReceipt } from './hook.mjs';
import { computeMetrics, loadState } from './state.mjs';
import { DEFAULT_PORT, projectPaths } from './paths.mjs';

const BIN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/idleproof.mjs');

function argValue(args, key, fallback) {
  const index = args.indexOf(key);
  if (index === -1 || args[index + 1] == null) return fallback;
  return args[index + 1];
}

function printHelp() {
  console.log(`
IdleProof — human CI for agentic coding

Usage:
  idleproof on [--agent NAME]  Install agent hooks + open live dashboard (claude|codex|all)
  idleproof install claude     Install project-local Claude Code hooks
  idleproof install codex      Install project-local Codex hooks
  idleproof install all        Install Claude Code + Codex hooks
  idleproof uninstall claude   Remove only IdleProof Claude hooks
  idleproof uninstall codex    Remove only IdleProof Codex hooks
  idleproof uninstall all      Remove IdleProof hooks from both
  idleproof serve [--port N]   Start the local dashboard
  idleproof demo               Start dashboard with a live demo session
  idleproof run -- <command>   Wrap any coding agent/command generically
  idleproof status             Show current knowledge-debt status
  idleproof check [--max N]    Human-CI gate for debt and risky findings
  idleproof receipt [--json]   Export proof tied to the observed Git diff
  idleproof doctor             Verify local prerequisites/integration
  idleproof reset              Delete local IdleProof learning state

Internal:
  idleproof hook               Receive a Claude Code hook event on stdin
  idleproof hook-codex         Receive a Codex hook event on stdin
`);
}

async function stdinJson() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function gitAvailable(cwd) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore', timeout: 1000 });
    return true;
  } catch { return false; }
}

function stateSummary(cwd) {
  const state = loadState(cwd);
  const metrics = computeMetrics(state);
  const session = Object.values(state.sessions || {}).sort((a, b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))[0];
  return { state, metrics, session };
}

async function serve(args, { demo = false, install = false } = {}) {
  const cwd = process.cwd();
  const port = Number(argValue(args, '--port', DEFAULT_PORT));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port');
  if (install) {
    const agent = String(argValue(args, '--agent', 'claude')).toLowerCase();
    if (!['claude', 'codex', 'all'].includes(agent)) throw new Error('Invalid --agent (use claude, codex, or all)');
    if (agent === 'claude' || agent === 'all') {
      const settings = installClaude({ cwd, binPath: BIN_PATH });
      console.log(`✓ Claude Code hooks installed in ${path.relative(cwd, settings)}`);
    }
    if (agent === 'codex' || agent === 'all') {
      const hooks = installCodex({ cwd, binPath: BIN_PATH });
      console.log(`✓ Codex hooks installed in ${path.relative(cwd, hooks)}`);
      console.log('  In Codex, run `/hooks` once to review and trust the project-local IdleProof hook.');
    }
  }
  if (demo) seedDemo(cwd);
  const { url } = await createServer({ cwd, port });
  console.log(`✓ IdleProof dashboard: ${url}`);
  console.log('  Keep this process running while your agent works. Ctrl+C stops the dashboard.');
  openBrowser(url);
}

async function runGeneric(args) {
  const divider = args.indexOf('--');
  const command = divider >= 0 ? args.slice(divider + 1) : args;
  if (!command.length) throw new Error('Usage: idleproof run -- <command> [args...]');
  const cwd = process.cwd();
  const sessionId = `generic-${Date.now()}-${process.pid}`;
  processHookEvent({ cwd, session_id: sessionId, hook_event_name: 'UserPromptSubmit', prompt: command.join(' '), source: 'generic-wrapper' });
  processHookEvent({ cwd, session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Process', tool_input: { command: command.join(' ') } });

  const child = spawn(command[0], command.slice(1), { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve(signal ? 130 : (exitCode ?? 1)));
  });

  processHookEvent({ cwd, session_id: sessionId, hook_event_name: 'generic-stop', tool_name: 'Process', tool_input: { command: command.join(' ') } });
  process.exitCode = code;
}

function doctor(cwd) {
  const checks = [
    ['Node >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.version],
    ['Git repository', gitAvailable(cwd), cwd],
    ['Claude hooks', hasClaudeInstall(cwd), path.relative(cwd, projectPaths(cwd).claudeSettings)],
    ['Codex hooks', hasCodexInstall(cwd), path.relative(cwd, projectPaths(cwd).codexHooks)],
    ['State directory writable', (() => {
      try {
        const paths = projectPaths(cwd); fs.mkdirSync(paths.dir, { recursive: true });
        const probe = path.join(paths.dir, '.probe'); fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); return true;
      } catch { return false; }
    })(), '.idleproof/']
  ];
  for (const [name, ok, detail] of checks) console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  const required = checks.filter(([name]) => !['Claude hooks', 'Codex hooks'].includes(name));
  if (required.some(([, ok]) => !ok)) process.exitCode = 1;
}

const SEVERITY = { low: 1, medium: 2, high: 3, critical: 4 };

function latestSession(state) {
  return Object.values(state.sessions || {}).sort((a, b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))[0] || null;
}

function findingAtOrAbove(session, threshold) {
  const floor = SEVERITY[threshold] || SEVERITY.critical;
  return (session?.findings || []).filter((finding) => (SEVERITY[finding.severity] || 0) >= floor);
}

export async function main(args) {
  const [command = 'help', subcommand] = args;
  const cwd = process.cwd();

  if (['help', '--help', '-h'].includes(command)) return printHelp();
  if (command === 'on') return serve(args.slice(1), { install: true });
  if (command === 'serve') return serve(args.slice(1));
  if (command === 'demo') return serve(args.slice(1), { demo: true });

  if (command === 'install' && ['claude', 'codex', 'all'].includes(subcommand)) {
    if (subcommand === 'claude' || subcommand === 'all') {
      const file = installClaude({ cwd, binPath: BIN_PATH });
      console.log(`✓ Installed Claude Code hooks in ${file}`);
    }
    if (subcommand === 'codex' || subcommand === 'all') {
      const file = installCodex({ cwd, binPath: BIN_PATH });
      console.log(`✓ Installed Codex hooks in ${file}`);
      console.log('  In Codex, run `/hooks` once to review and trust the project-local IdleProof hook.');
    }
    console.log('Run `idleproof serve` to open the live learning surface.');
    return;
  }

  if (command === 'uninstall' && ['claude', 'codex', 'all'].includes(subcommand)) {
    if (subcommand === 'claude' || subcommand === 'all') {
      const changed = uninstallClaude({ cwd });
      console.log(changed ? '✓ IdleProof Claude hooks removed; other Claude settings were preserved.' : 'No IdleProof Claude hooks found.');
    }
    if (subcommand === 'codex' || subcommand === 'all') {
      const changed = uninstallCodex({ cwd });
      console.log(changed ? '✓ IdleProof Codex hooks removed; other Codex hooks were preserved.' : 'No IdleProof Codex hooks found.');
    }
    return;
  }

  if (command === 'hook') {
    const event = await stdinJson();
    processHookEvent({ ...event, source: 'claude' });
    return;
  }

  if (command === 'hook-codex') {
    const event = await stdinJson();
    processHookEvent({ ...event, source: 'codex' });
    if (event.hook_event_name === 'Stop') process.stdout.write('{}\n');
    return;
  }

  if (command === 'run') return runGeneric(args.slice(1));

  if (command === 'status') {
    const { metrics, session } = stateSummary(cwd);
    console.log(`Knowledge debt: ${metrics.debt}`);
    console.log(`Cognitive coverage: ${metrics.coverage}%`);
    console.log(`Concepts encountered: ${metrics.conceptsSeen}`);
    console.log(`Latest agent state: ${session?.status || 'none'}`);
    if (session?.touchedFiles?.length) console.log(`Touched files: ${session.touchedFiles.length}`);
    return;
  }

  if (command === 'check') {
    const max = Number(argValue(args, '--max', 25));
    const failOn = String(argValue(args, '--fail-on', 'critical')).toLowerCase();
    if (!Number.isFinite(max) || max < 0) throw new Error('Invalid --max');
    if (!SEVERITY[failOn]) throw new Error('Invalid --fail-on (use low, medium, high, or critical)');
    const { state, metrics } = stateSummary(cwd);
    const session = latestSession(state);
    const risky = findingAtOrAbove(session, failOn);
    const ok = metrics.debt <= max && risky.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'} knowledge debt ${metrics.debt} (max ${max}); coverage ${metrics.coverage}%`);
    if (risky.length) console.log(`${risky.length} finding(s) at or above ${failOn}: ${risky.map((item) => item.title).join('; ')}`);
    if (!ok) process.exitCode = 2;
    return;
  }

  if (command === 'receipt') {
    const receipt = buildReceipt(cwd);
    if (args.includes('--json')) console.log(JSON.stringify(receipt, null, 2));
    else {
      console.log(`✓ Proof receipt written to ${path.relative(cwd, projectPaths(cwd).receipt)}`);
      console.log(`  Diff SHA-256: ${receipt.session?.proof?.diffSha256 || 'no completed diff yet'}`);
      console.log(`  Knowledge debt: ${receipt.metrics.debt}; coverage: ${receipt.metrics.coverage}%`);
    }
    return;
  }

  if (command === 'doctor') return doctor(cwd);

  if (command === 'reset') {
    const { dir } = projectPaths(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('✓ Local IdleProof state reset. Agent hook configuration was left untouched.');
    return;
  }

  throw new Error(`Unknown command: ${args.join(' ')}\nRun idleproof --help.`);
}
