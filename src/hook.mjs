import fs from 'node:fs';
import { mutateState, trimSessions, computeMetrics, loadState } from './state.mjs';
import { projectPaths } from './paths.mjs';
import {
  analyzeDiff,
  captureGitSnapshot,
  conceptsFromGitSnapshot,
  detectConcepts,
  estimateWindow,
  eventText,
  touchedFileFromEvent
} from './analyze.mjs';

function now() {
  return new Date().toISOString();
}

function ensureSession(state, event) {
  const id = event.session_id || `generic-${Date.now()}`;
  if (!state.sessions[id]) {
    state.sessions[id] = {
      id,
      source: event.source || 'agent',
      status: 'active',
      startedAt: now(),
      lastEventAt: now(),
      prompt: '',
      currentTool: null,
      estimatedWindow: 20,
      touchedFiles: [],
      changed: { added: 0, deleted: 0 },
      proof: null,
      findings: [],
      concepts: {},
      events: []
    };
  }
  return state.sessions[id];
}

function exposeConcept(state, session, id) {
  if (!session.concepts[id]) {
    session.concepts[id] = { firstSeenAt: now(), events: 0 };
    const ledger = state.ledger[id];
    if (ledger) {
      ledger.exposures += 1;
      ledger.lastSeenAt = now();
    }
  }
  session.concepts[id].events += 1;
}

function recordEvent(session, event) {
  session.events.push({
    at: now(),
    type: event.hook_event_name || event.type || 'event',
    tool: event.tool_name || null,
    failed: event.hook_event_name === 'PostToolUseFailure' || Boolean(event.error)
  });
  if (session.events.length > 100) session.events = session.events.slice(-100);
}

export function processHookEvent(event = {}) {
  const cwd = event.cwd || process.cwd();
  const eventNameForReceipt = event.hook_event_name || event.type || 'event';
  const state = mutateState(cwd, (state) => {
    const session = ensureSession(state, event);
    const eventName = event.hook_event_name || event.type || 'event';

    session.lastEventAt = now();
    recordEvent(session, event);

    if (eventName === 'SessionStart') {
      session.status = 'idle';
      session.estimatedWindow = 0;
    }

    if (eventName === 'UserPromptSubmit') {
      session.status = 'active';
      session.prompt = String(event.prompt || '').slice(0, 1200);
      session.currentTool = 'Thinking';
      session.estimatedWindow = estimateWindow(event);
    }

    if (eventName === 'PreToolUse') {
      session.status = 'active';
      session.currentTool = event.tool_name || 'Tool';
      session.estimatedWindow = estimateWindow(event);
    }

    if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
      session.status = 'active';
      session.currentTool = eventName === 'PostToolUseFailure' ? `${event.tool_name || 'Tool'} failed` : 'Thinking';
      session.estimatedWindow = eventName === 'PostToolUseFailure' ? 36 : 22;
    }

    for (const id of detectConcepts(eventText(event))) exposeConcept(state, session, id);

    const touched = touchedFileFromEvent(event);
    if (touched) {
      const relative = touched.startsWith(cwd) ? touched.slice(cwd.length + 1) : touched;
      if (!session.touchedFiles.includes(relative)) session.touchedFiles.push(relative);
      session.touchedFiles = session.touchedFiles.slice(-80);
    }

    if (eventName === 'Stop' || eventName === 'SessionEnd' || eventName === 'generic-stop') {
      const snapshot = captureGitSnapshot(cwd);
      for (const id of conceptsFromGitSnapshot(snapshot)) exposeConcept(state, session, id);
      session.touchedFiles = [...new Set([...session.touchedFiles, ...snapshot.files])].slice(0, 80);
      session.changed = { added: snapshot.added, deleted: snapshot.deleted };
      session.proof = {
        diffSha256: snapshot.diffHash,
        head: snapshot.head,
        capturedAt: now()
      };
      session.findings = analyzeDiff(snapshot.diff);
      session.status = 'complete';
      session.currentTool = null;
      session.estimatedWindow = 0;
      session.completedAt = now();
    }

    trimSessions(state);
    return state;
  });
  if (['Stop', 'SessionEnd', 'generic-stop'].includes(eventNameForReceipt)) writeReceipt(cwd, state);
  return state;
}

function receiptFromState(state) {
  const session = Object.values(state.sessions || {}).sort((a, b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))[0] || null;
  const metrics = computeMetrics(state);
  const concepts = Object.entries(session?.concepts || {}).map(([id, detail]) => ({
    id,
    events: detail.events,
    confidence: Math.round(((state.ledger[id]?.confidence) || 0) * 100),
    exposures: state.ledger[id]?.exposures || 0
  }));
  return {
    schema: 'idleproof.receipt.v1',
    project: state.project,
    generatedAt: now(),
    session: session ? {
      id: session.id,
      source: session.source,
      startedAt: session.startedAt,
      completedAt: session.completedAt || null,
      prompt: session.prompt,
      files: session.touchedFiles,
      changed: session.changed,
      proof: session.proof,
      findings: session.findings,
      concepts
    } : null,
    metrics
  };
}

function writeReceipt(cwd, state) {
  const receipt = receiptFromState(state);
  const paths = projectPaths(cwd);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return receipt;
}

export function buildReceipt(cwd = process.cwd()) {
  return writeReceipt(cwd, loadState(cwd));
}

export function seedDemo(cwd = process.cwd()) {
  const sessionId = `demo-${Date.now()}`;
  processHookEvent({
    cwd,
    session_id: sessionId,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Add Google OAuth login, persist sessions in Postgres, and add tests for protected routes.'
  });
  processHookEvent({
    cwd,
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: `${cwd}/src/auth/session.ts`, content: 'session cookie oauth' }
  });
  processHookEvent({
    cwd,
    session_id: sessionId,
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: `${cwd}/src/auth/session.ts` }
  });
  processHookEvent({
    cwd,
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' }
  });
  return sessionId;
}
