import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './paths.mjs';

const EVENTS = [
  ['SessionStart', null],
  ['UserPromptSubmit', null],
  ['PreToolUse', '.*'],
  ['PermissionRequest', '.*'],
  ['PostToolUse', '.*'],
  ['PostToolUseFailure', '.*'],
  ['SubagentStart', null],
  ['SubagentStop', null],
  ['Stop', null],
  ['SessionEnd', null]
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

function isIdleProofHook(entry) {
  return (entry?.hooks || []).some((hook) => typeof hook.command === 'string' && hook.command.includes('idleproof.mjs') && hook.command.includes(' hook'));
}

export function installClaude({ cwd = process.cwd(), binPath }) {
  const paths = projectPaths(cwd);
  fs.mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
  const settings = readJson(paths.claudeSettings);
  settings.hooks ||= {};
  const resolvedBin = resolveBin(binPath);
  const command = `\"${process.execPath}\" \"${resolvedBin}\" hook`;

  for (const [event, matcher] of EVENTS) {
    settings.hooks[event] ||= [];
    settings.hooks[event] = settings.hooks[event].filter((entry) => !isIdleProofHook(entry));
    const entry = { hooks: [{ type: 'command', command, timeout: 5 }] };
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
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = (settings.hooks[event] || []).filter((entry) => !isIdleProofHook(entry));
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  writeJsonAtomic(paths.claudeSettings, settings);
  return true;
}

export function hasClaudeInstall(cwd = process.cwd()) {
  const { claudeSettings } = projectPaths(cwd);
  const settings = readJson(claudeSettings);
  return Object.values(settings.hooks || {}).some((entries) => entries.some(isIdleProofHook));
}
