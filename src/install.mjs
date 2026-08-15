import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './paths.mjs';

const EVENTS = [
  ['SessionStart', null],
  ['UserPromptSubmit', null],
  ['PreToolUse', 'Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob|WebFetch|WebSearch|mcp__.*'],
  ['PostToolUse', 'Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob|WebFetch|WebSearch|mcp__.*'],
  ['PostToolUseFailure', 'Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob|WebFetch|WebSearch|mcp__.*'],
  ['Stop', null],
  ['SessionEnd', null]
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot parse ${file}: ${error.message}`);
  }
}

function isIdleProofHook(entry) {
  return (entry?.hooks || []).some((hook) => typeof hook.command === 'string' && hook.command.includes('idleproof.mjs') && hook.command.includes(' hook'));
}

export function installClaude({ cwd = process.cwd(), binPath }) {
  const paths = projectPaths(cwd);
  fs.mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });
  const settings = readJson(paths.claudeSettings);
  settings.hooks ||= {};
  const command = `\"${process.execPath}\" \"${path.resolve(binPath)}\" hook`;

  for (const [event, matcher] of EVENTS) {
    settings.hooks[event] ||= [];
    settings.hooks[event] = settings.hooks[event].filter((entry) => !isIdleProofHook(entry));
    const entry = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (matcher) entry.matcher = matcher;
    settings.hooks[event].push(entry);
  }

  fs.writeFileSync(paths.claudeSettings, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
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
  fs.writeFileSync(paths.claudeSettings, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return true;
}

export function hasClaudeInstall(cwd = process.cwd()) {
  const { claudeSettings } = projectPaths(cwd);
  const settings = readJson(claudeSettings);
  return Object.values(settings.hooks || {}).some((entries) => entries.some(isIdleProofHook));
}
