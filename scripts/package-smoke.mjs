import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();

function exec(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 30000,
    env: { ...process.env, ...(options.env || {}) },
    shell: Boolean(options.shell)
  });
}

function npm(args, options = {}) {
  // Recent Node versions no longer reliably execute npm.cmd directly through execFileSync on
  // Windows hosted runners (EINVAL). The normal npm command is a shell shim there, so use the
  // platform shell only for this trusted test invocation. POSIX keeps direct exec semantics.
  return exec('npm', args, { ...options, shell: process.platform === 'win32' });
}

function git(cwd, ...args) {
  return exec('git', args, { cwd });
}

function runIdleProof(bin, cwd, ...args) {
  return exec(process.execPath, [bin, ...args], { cwd });
}

function containsIdleProofHook(value, marker) {
  return JSON.stringify(value).includes('idleproof.mjs') && JSON.stringify(value).includes(marker);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-package-smoke-'));
let tarball = null;
try {
  const packed = JSON.parse(npm(['pack', '--json'], { cwd: ROOT }));
  if (!Array.isArray(packed) || !packed[0]?.filename) throw new Error('npm pack did not return an artifact filename');
  tarball = path.resolve(ROOT, packed[0].filename);
  if (!fs.existsSync(tarball)) throw new Error(`npm pack artifact missing: ${tarball}`);

  const consumer = path.join(temp, 'consumer');
  fs.mkdirSync(consumer, { recursive: true });
  npm(['init', '-y'], { cwd: consumer });
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: consumer, timeout: 60000 });

  const bin = path.join(consumer, 'node_modules', 'idleproof', 'bin', 'idleproof.mjs');
  if (!fs.existsSync(bin)) throw new Error('installed IdleProof package does not contain its CLI entrypoint');
  const help = runIdleProof(bin, consumer, '--help');
  if (!/learn what your coding agent is building/i.test(help)) throw new Error(`unexpected installed CLI help:\n${help}`);

  const project = path.join(temp, 'project');
  fs.mkdirSync(project, { recursive: true });
  git(project, 'init', '-q');

  // Claude Code: preserve unrelated permissions/hooks and remove only IdleProof on uninstall.
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const settingsPath = path.join(project, '.claude', 'settings.local.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    permissions: { allow: ['Bash(git status:*)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] }
  }, null, 2));

  runIdleProof(bin, project, 'install', 'claude');
  const installedClaude = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (installedClaude.permissions?.allow?.[0] !== 'Bash(git status:*)') throw new Error('packaged installer changed existing Claude permissions');
  if (!containsIdleProofHook(installedClaude, ' hook')) throw new Error('packaged installer did not register IdleProof Claude hooks');
  if (!installedClaude.hooks.Stop.some((entry) => entry.hooks?.[0]?.command === 'echo existing')) throw new Error('packaged installer removed an existing Claude hook');

  runIdleProof(bin, project, 'uninstall', 'claude');
  const uninstalledClaude = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (!uninstalledClaude.hooks?.Stop?.some((entry) => entry.hooks?.[0]?.command === 'echo existing')) throw new Error('packaged uninstall removed a pre-existing Claude hook');
  if (JSON.stringify(uninstalledClaude).includes('idleproof.mjs')) throw new Error('packaged uninstall left IdleProof Claude hooks behind');

  // Codex: preserve an unrelated project hook and keep project-local hook config excluded from Git.
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  const codexPath = path.join(project, '.codex', 'hooks.json');
  fs.writeFileSync(codexPath, JSON.stringify({
    description: 'existing project hooks',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo codex-existing', timeout: 1 }] }] }
  }, null, 2));

  runIdleProof(bin, project, 'install', 'codex');
  const installedCodex = JSON.parse(fs.readFileSync(codexPath, 'utf8'));
  if (!containsIdleProofHook(installedCodex, 'hook-codex')) throw new Error('packaged installer did not register IdleProof Codex hooks');
  if (!installedCodex.hooks.Stop.some((entry) => entry.hooks?.[0]?.command === 'echo codex-existing')) throw new Error('packaged installer removed an existing Codex hook');
  const exclude = fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8');
  if (!exclude.split(/\r?\n/).some((line) => line.trim() === '.codex/hooks.json')) throw new Error('packaged Codex install did not exclude local hook config from Git');

  runIdleProof(bin, project, 'uninstall', 'codex');
  const uninstalledCodex = JSON.parse(fs.readFileSync(codexPath, 'utf8'));
  if (!uninstalledCodex.hooks?.Stop?.some((entry) => entry.hooks?.[0]?.command === 'echo codex-existing')) throw new Error('packaged uninstall removed a pre-existing Codex hook');
  if (JSON.stringify(uninstalledCodex).includes('idleproof.mjs')) throw new Error('packaged uninstall left IdleProof Codex hooks behind');

  console.log(`IdleProof package smoke passed on ${process.platform}/${process.version} · Claude + Codex adapters`);
} finally {
  if (tarball) {
    try { fs.rmSync(tarball, { force: true }); } catch {}
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
