import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './paths.mjs';

const TOOL_MATCHER = '^(?:Bash|apply_patch|Edit|Write|Read|WebSearch|WebFetch|mcp__.*|.+)$';
const EVENTS = [
  ['SessionStart', null, 3],
  ['UserPromptSubmit', null, 5],
  ['PreToolUse', TOOL_MATCHER, 5],
  ['PermissionRequest', TOOL_MATCHER, 5],
  ['PostToolUse', TOOL_MATCHER, 5],
  ['SubagentStart', null, 3],
  ['SubagentStop', null, 5],
  ['Stop', null, 5],
  ['SessionEnd', null, 3]
];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot parse ${file}: ${error.message}`);
  }
}

function isIdleProofHook(entry) {
  return (entry?.hooks || []).some((hook) =>
    hook?.type === 'command' &&
    typeof hook.command === 'string' &&
    hook.command.includes('idleproof.mjs') &&
    hook.command.includes('hook-codex')
  );
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
  config.description ||= 'Project-local Codex hooks. IdleProof entries can be removed with `idleproof uninstall codex`.';
  config.hooks ||= {};
  const command = `\"${process.execPath}\" \"${path.resolve(binPath)}\" hook-codex`;

  for (const [event, matcher, timeout] of EVENTS) {
    config.hooks[event] ||= [];
    config.hooks[event] = config.hooks[event].filter((entry) => !isIdleProofHook(entry));
    const entry = { hooks: [{ type: 'command', command, timeout, statusMessage: 'IdleProof · agentic control plane' }] };
    if (matcher) entry.matcher = matcher;
    config.hooks[event].push(entry);
  }

  fs.writeFileSync(paths.codexHooks, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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
  fs.writeFileSync(paths.codexHooks, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return true;
}

export function hasCodexInstall(cwd = process.cwd()) {
  const { codexHooks } = projectPaths(cwd);
  const config = readJson(codexHooks);
  return Object.values(config.hooks || {}).some((entries) => (entries || []).some(isIdleProofHook));
}
