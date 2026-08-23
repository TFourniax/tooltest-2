import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './paths.mjs';

const TOOL_MATCHER = '^(?:Bash|apply_patch|Edit|Write|Read|WebSearch|WebFetch|mcp__.*|.+)$';
const EVENTS = [
  ['SessionStart', null, 8],
  ['UserPromptSubmit', null, 8],
  ['PreToolUse', TOOL_MATCHER, 5],
  ['PermissionRequest', TOOL_MATCHER, 5],
  ['PostToolUse', TOOL_MATCHER, 5],
  ['SubagentStart', null, 5],
  ['SubagentStop', null, 8],
  ['Stop', null, 910],
  ['SessionEnd', null, 8]
];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot parse ${file}: ${error.message}`);
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

function resolveBin(binPath) {
  if (typeof binPath !== 'string' || !binPath.trim()) throw new Error('IdleProof hook installer requires its CLI path.');
  const resolved = path.resolve(binPath);
  let stat;
  try { stat = fs.statSync(resolved); }
  catch { throw new Error(`IdleProof CLI entrypoint does not exist: ${resolved}`); }
  if (!stat.isFile()) throw new Error(`IdleProof CLI entrypoint is not a file: ${resolved}`);
  return resolved;
}

function hookRunner(resolvedBin) {
  const candidate=path.join(path.dirname(resolvedBin),'idleproof-hook.mjs');
  try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  return null;
}

function isIdleProofHook(entry) {
  return (entry?.hooks || []).some((hook) => {
    if (hook?.type !== 'command' || typeof hook.command !== 'string') return false;
    return (hook.command.includes('idleproof-hook.mjs') && hook.command.includes(' codex')) ||
      (hook.command.includes('idleproof.mjs') && hook.command.includes('hook-codex'));
  });
}

function addLocalGitExclude(cwd, relativePath) {
  const exclude = path.join(cwd, '.git', 'info', 'exclude');
  try {
    if (!fs.existsSync(path.dirname(exclude))) return;
    const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (existing.split(/\r?\n/).some((line) => line.trim() === relativePath)) return;
    fs.appendFileSync(exclude, `${existing && !existing.endsWith('\n') ? '\n' : ''}${relativePath}\n`);
  } catch {}
}

export function installCodex({ cwd = process.cwd(), binPath }) {
  const paths = projectPaths(cwd);
  fs.mkdirSync(path.dirname(paths.codexHooks), { recursive: true });
  const config = readJson(paths.codexHooks);
  config.description ||= 'Project-local Codex hooks. Defitness entries can be removed with `defitness uninstall`.';
  config.hooks ||= {};
  const resolvedBin = resolveBin(binPath);
  const runner=hookRunner(resolvedBin);
  const command = runner
    ? `\"${process.execPath}\" \"${runner}\" codex`
    : `\"${process.execPath}\" \"${resolvedBin}\" hook-codex`;

  for (const [event, matcher, timeout] of EVENTS) {
    config.hooks[event] ||= [];
    config.hooks[event] = config.hooks[event].filter((entry) => !isIdleProofHook(entry));
    const entry = { hooks: [{ type: 'command', command, timeout, statusMessage: 'Defitness · understand · prove · owe' }] };
    if (matcher) entry.matcher = matcher;
    config.hooks[event].push(entry);
  }

  writeJsonAtomic(paths.codexHooks, config);
  addLocalGitExclude(cwd, '.codex/hooks.json');
  return paths.codexHooks;
}

export function uninstallCodex({ cwd = process.cwd() } = {}) {
  const paths = projectPaths(cwd);
  const config = readJson(paths.codexHooks);
  if (!config.hooks) return false;
  let changed = false;
  for (const event of Object.keys(config.hooks)) {
    const before = config.hooks[event]?.length || 0;
    config.hooks[event] = (config.hooks[event] || []).filter((entry) => !isIdleProofHook(entry));
    changed ||= config.hooks[event].length !== before;
    if (!config.hooks[event].length) delete config.hooks[event];
  }
  if (!changed) return false;
  writeJsonAtomic(paths.codexHooks, config);
  return true;
}

export function hasCodexInstall(cwd = process.cwd()) {
  const { codexHooks } = projectPaths(cwd);
  const config = readJson(codexHooks);
  return Object.values(config.hooks || {}).some((entries) => (entries || []).some(isIdleProofHook));
}

export const __codexInstallTest={EVENTS};
