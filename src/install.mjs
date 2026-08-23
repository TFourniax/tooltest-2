import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './paths.mjs';

const EVENTS = [
  ['SessionStart', null, 8],
  ['UserPromptSubmit', null, 8],
  ['PreToolUse', '.*', 5],
  ['PermissionRequest', '.*', 5],
  ['PostToolUse', '.*', 5],
  ['PostToolUseFailure', '.*', 5],
  ['SubagentStart', null, 5],
  ['SubagentStop', null, 8],
  // Defitness executes deterministic DiffWitness Proof/Debt finalization in this Stop hook. Keep
  // the same bounded 15-minute ceiling as the proof engine instead of terminating it after 5s.
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
  catch (error) { throw new Error(`IdleProof CLI entrypoint does not exist: ${resolved}`); }
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
    if (typeof hook.command !== 'string') return false;
    return (hook.command.includes('idleproof-hook.mjs') && hook.command.includes(' claude')) ||
      (hook.command.includes('idleproof.mjs') && hook.command.includes(' hook'));
  });
}

export function installClaude({ cwd = process.cwd(), binPath }) {
  const paths = projectPaths(cwd);
  fs.mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
  const settings = readJson(paths.claudeSettings);
  settings.hooks ||= {};
  const resolvedBin = resolveBin(binPath);
  const runner=hookRunner(resolvedBin);
  const command = runner
    ? `\"${process.execPath}\" \"${runner}\" claude`
    : `\"${process.execPath}\" \"${resolvedBin}\" hook`;

  for (const [event, matcher, timeout] of EVENTS) {
    settings.hooks[event] ||= [];
    settings.hooks[event] = settings.hooks[event].filter((entry) => !isIdleProofHook(entry));
    const entry = { hooks: [{ type: 'command', command, timeout }] };
    if (matcher) entry.matcher = matcher;
    settings.hooks[event].push(entry);
  }

  writeJsonAtomic(paths.claudeSettings, settings);
  return paths.claudeSettings;
}

export function uninstallClaude({ cwd = process.cwd() }) {
  const paths = projectPaths(cwd);
  const settings = readJson(paths.claudeSettings);
  if (!settings.hooks) return false;
  let changed=false;
  for (const event of Object.keys(settings.hooks)) {
    const before=settings.hooks[event]?.length || 0;
    settings.hooks[event] = (settings.hooks[event] || []).filter((entry) => !isIdleProofHook(entry));
    changed ||= settings.hooks[event].length !== before;
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (changed) writeJsonAtomic(paths.claudeSettings, settings);
  return changed;
}

export function hasClaudeInstall(cwd = process.cwd()) {
  const { claudeSettings } = projectPaths(cwd);
  const settings = readJson(claudeSettings);
  return Object.values(settings.hooks || {}).some((entries) => entries.some(isIdleProofHook));
}

export const __claudeInstallTest={EVENTS};
