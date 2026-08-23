import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadState } from './state.mjs';
import { processHookLifecycle } from './hook.mjs';

const SANDBOXES = new Set(['read-only', 'workspace-write']);

function bridgeSessionExists(cwd, sessionId) {
  const session = loadState(cwd).sessions?.[sessionId];
  return session || null;
}

function nativeCodexActive(cwd, sessionId) {
  return bridgeSessionExists(cwd, sessionId)?.source === 'codex';
}

function lifecycle(cwd, sessionId, event) {
  return processHookLifecycle({ cwd, session_id: sessionId, source: 'codex-json-bridge', ...event });
}

function safePath(value) {
  const text = String(value || '').trim();
  return text && text.length <= 4096 ? text : null;
}

export function parseCodexBridgeArgs(args = []) {
  let model = null;
  let sandbox = 'workspace-write';
  let promptParts = [];
  let literal = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (literal) { promptParts.push(arg); continue; }
    if (arg === '--') { literal = true; continue; }
    if (arg === '--model') {
      if (!args[i + 1]) throw new Error('Missing value for --model.');
      model = String(args[++i]);
      continue;
    }
    if (arg === '--sandbox') {
      if (!args[i + 1]) throw new Error('Missing value for --sandbox.');
      sandbox = String(args[++i]);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unsupported idleproof codex option: ${arg}`);
    promptParts.push(arg);
  }
  if (!SANDBOXES.has(sandbox)) throw new Error('IdleProof Codex bridge only permits read-only or workspace-write sandboxes.');
  const prompt = promptParts.join(' ').trim();
  if (!prompt) throw new Error('Usage: idleproof codex [--model MODEL] [--sandbox read-only|workspace-write] -- <task>');
  return { model, sandbox, prompt };
}

export function mapCodexExecItem(item = {}) {
  const type = String(item?.type || '');
  if (type === 'command_execution') {
    if (item.status === 'in_progress') {
      return [{
        hook_event_name: 'AgentTelemetry',
        tool_name: 'Bash',
        tool_input: { telemetry: 'command-started' },
      }];
    }
    return [{
      hook_event_name: item.status === 'failed' || Number(item.exit_code) !== 0 ? 'PostToolUseFailure' : 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { telemetry: 'command-completed' },
      tool_response: { exit_code: Number.isInteger(item.exit_code) ? item.exit_code : null },
    }];
  }
  if (type === 'file_change') {
    const failed = item.status === 'failed';
    return (Array.isArray(item.changes) ? item.changes : [])
      .map((change) => safePath(change?.path))
      .filter(Boolean)
      .map((filePath) => ({
        hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse',
        tool_name: 'CodexFileChange',
        tool_input: { file_path: filePath },
      }));
  }
  if (type === 'web_search') {
    return [{ hook_event_name: 'PostToolUse', tool_name: 'WebSearch', tool_input: { telemetry: 'search-completed' } }];
  }
  if (type === 'mcp_tool_call') {
    const server = String(item.server || item.server_name || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
    const tool = String(item.tool || item.tool_name || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
    return [{
      hook_event_name: item.status === 'failed' ? 'PostToolUseFailure' : 'PostToolUse',
      tool_name: server || tool ? `mcp__${server || 'server'}__${tool || 'tool'}` : 'MCP',
      tool_input: { telemetry: 'mcp-completed' },
    }];
  }
  return [];
}

function buildCodexArgs({ prompt, model, sandbox }) {
  const args = ['exec', '--json', '--ephemeral', '--sandbox', sandbox];
  if (model) args.push('--model', model);
  args.push(prompt);
  return args;
}

export async function runCodexBridge({
  cwd = process.cwd(),
  prompt,
  model = null,
  sandbox = 'workspace-write',
  codexCommand = [process.env.IDLEPROOF_CODEX_BIN || 'codex'],
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (!SANDBOXES.has(sandbox)) throw new Error('Unsafe Codex sandbox requested.');
  if (!String(prompt || '').trim()) throw new Error('Codex task is required.');
  if (!Array.isArray(codexCommand) || !codexCommand.length) throw new Error('Codex command is required.');

  const args = [...codexCommand.slice(1), ...buildCodexArgs({ prompt: String(prompt), model, sandbox })];
  const command = codexCommand[0];
  let sessionId = null;
  const fallbackSessionId = `codex-bridge-${randomUUID()}`;
  let bridgeStarted = false;
  let turnFailed = false;
  let finalMessage = '';
  let parseErrors = 0;
  const counts = { commands: 0, fileChanges: 0, webSearches: 0, mcpCalls: 0 };

  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Register process completion immediately. Attaching the `exit` listener only after stdout EOF
  // creates a race for short-lived Codex processes: the process can already be gone by then and the
  // bridge would wait forever on an event that has passed.
  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: signal ? 130 : (code ?? 1), signal }));
  });
  child.stderr.on('data', (chunk) => stderr.write(chunk));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

  const ensureBridgeStarted = (id) => {
    const actual = id || fallbackSessionId;
    if (bridgeStarted) return actual;
    sessionId = actual;
    const existing = bridgeSessionExists(cwd, actual);
    if (!existing) lifecycle(cwd, actual, { hook_event_name: 'SessionStart', source: 'codex-json-bridge' });
    if (!nativeCodexActive(cwd, actual)) {
      lifecycle(cwd, actual, { hook_event_name: 'UserPromptSubmit', prompt: String(prompt) });
    }
    bridgeStarted = true;
    return actual;
  };

  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); }
    catch {
      parseErrors += 1;
      if (parseErrors <= 3) stderr.write(`[idleproof] Codex emitted a non-JSON telemetry line; ignored.\n`);
      continue;
    }

    if (event.type === 'thread.started') {
      sessionId = String(event.thread_id || '') || fallbackSessionId;
      ensureBridgeStarted(sessionId);
      continue;
    }
    const activeId = ensureBridgeStarted(sessionId || fallbackSessionId);
    const native = nativeCodexActive(cwd, activeId);

    if (event.type === 'item.started' || event.type === 'item.completed') {
      const item = event.item || {};
      if (event.type === 'item.completed' && item.type === 'agent_message') finalMessage = String(item.text || '');
      if (event.type === 'item.completed') {
        if (item.type === 'command_execution') counts.commands += 1;
        else if (item.type === 'file_change') counts.fileChanges += Array.isArray(item.changes) ? item.changes.length : 0;
        else if (item.type === 'web_search') counts.webSearches += 1;
        else if (item.type === 'mcp_tool_call') counts.mcpCalls += 1;
      }
      if (!native) {
        for (const mapped of mapCodexExecItem(item)) lifecycle(cwd, activeId, mapped);
      }
      continue;
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      turnFailed = true;
      if (!native) lifecycle(cwd, activeId, {
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'CodexTurn',
        tool_input: { telemetry: 'turn-failed' },
      });
    }
  }

  const exit = await exitPromise;

  const activeId = ensureBridgeStarted(sessionId || fallbackSessionId);
  const native = nativeCodexActive(cwd, activeId);
  if (!native) lifecycle(cwd, activeId, { hook_event_name: 'Stop' });

  if (finalMessage) stdout.write(`${finalMessage.trim()}\n`);
  stdout.write(`[idleproof] Codex telemetry: ${native ? 'native hooks' : 'JSON fallback'} · ${counts.fileChanges} file change${counts.fileChanges === 1 ? '' : 's'} · ${counts.commands} command${counts.commands === 1 ? '' : 's'}${counts.webSearches ? ` · ${counts.webSearches} web search` : ''}${counts.mcpCalls ? ` · ${counts.mcpCalls} MCP call` : ''}.\n`);
  if (parseErrors) stderr.write(`[idleproof] Codex telemetry ignored ${parseErrors} malformed line${parseErrors === 1 ? '' : 's'}.\n`);

  return { code: exit.code, signal: exit.signal, sessionId: activeId, nativeHooks: native, turnFailed, parseErrors, counts, finalMessage };
}

export async function runCodexBridgeCli(args = []) {
  const parsed = parseCodexBridgeArgs(args);
  const result = await runCodexBridge(parsed);
  if (result.code !== 0 || result.turnFailed) process.exitCode = result.code || 1;
  return result;
}
