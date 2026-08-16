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
import { evaluatePolicy, loadPolicy, policyDecisionOutput } from './policy.mjs';
import { appendProvenanceEvent, buildAgentBom, sha256, verifyProvenanceChain } from './provenance.mjs';
import { createAttestation } from './attest.mjs';

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

function recordEvent(session, event, policyDecision, provenanceRecord, provenanceError) {
  session.events.push({
    at: now(),
    type: event.hook_event_name || event.type || 'event',
    tool: event.tool_name || null,
    failed: event.hook_event_name === 'PostToolUseFailure' || Boolean(event.error),
    policyDecision: policyDecision?.decision || null,
    policyOriginalDecision: policyDecision?.originalDecision || null,
    policyRisk: policyDecision?.risk || 0,
    approvalFingerprint: policyDecision?.approvalFingerprint || null,
    provenanceHash: provenanceRecord?.hash || null,
    provenanceError: provenanceError || null
  });
  if (session.events.length > 160) session.events = session.events.slice(-160);
}

function strictRecorderFailClosed(event, policyDecision, provenanceError, cwd) {
  if (!provenanceError || (event.hook_event_name || event.type) !== 'PreToolUse') return policyDecision;
  if (loadPolicy(cwd).profile !== 'strict') return policyDecision;
  const tool = String(event.tool_name || '');
  const mutating = /Bash|Write|Edit|MultiEdit|NotebookEdit|apply_patch|mcp__/i.test(tool);
  if (!mutating) return policyDecision;
  return {
    ...(policyDecision || {}),
    schema: 'idleproof.policy-decision.v1',
    profile: 'strict',
    decision: 'deny',
    originalDecision: policyDecision?.originalDecision || 'allow',
    risk: Math.max(90, policyDecision?.risk || 0),
    reason: `Strict policy requires an auditable execution trace, but the Flight Recorder failed: ${provenanceError}`,
    approvalFingerprint: policyDecision?.approvalFingerprint || 'recorder-failure',
    matches: policyDecision?.matches || []
  };
}

export function processHookLifecycle(event = {}) {
  const cwd = event.cwd || process.cwd();
  const eventName = event.hook_event_name || event.type || 'event';
  let policyDecision = eventName === 'PreToolUse'
    ? evaluatePolicy(event, { cwd, consumeApproval: true })
    : null;

  let provenanceRecord = null;
  let provenanceError = null;
  try {
    provenanceRecord = appendProvenanceEvent(event, policyDecision, cwd);
  } catch (error) {
    provenanceError = error.message;
  }

  policyDecision = strictRecorderFailClosed(event, policyDecision, provenanceError, cwd);

  const state = mutateState(cwd, (state) => {
    const session = ensureSession(state, event);
    session.source = event.source || session.source || 'agent';
    session.lastEventAt = now();
    recordEvent(session, event, policyDecision, provenanceRecord, provenanceError);

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
      session.lastPolicyDecision = policyDecision ? {
        decision: policyDecision.decision,
        originalDecision: policyDecision.originalDecision,
        risk: policyDecision.risk,
        reason: policyDecision.reason,
        approvalFingerprint: policyDecision.approvalFingerprint,
        matches: policyDecision.matches
      } : null;
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

  let attestation = null;
  let attestationError = null;
  if (['Stop', 'SessionEnd', 'generic-stop'].includes(eventName)) {
    writeReceipt(cwd, state);
    try { attestation = createAttestation(cwd); }
    catch (error) { attestationError = error.message; }
  }

  return {
    state,
    policyDecision,
    provenance: provenanceRecord,
    provenanceError,
    attestation,
    attestationError,
    hookOutput: policyDecision ? policyDecisionOutput(event, policyDecision) : null
  };
}

export function processHookEvent(event = {}) {
  return processHookLifecycle(event).state;
}

function receiptFromState(state, cwd) {
  const session = Object.values(state.sessions || {}).sort((a, b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))[0] || null;
  const metrics = computeMetrics(state);
  const concepts = Object.entries(session?.concepts || {}).map(([id, detail]) => ({
    id,
    events: detail.events,
    confidence: Math.round(((state.ledger[id]?.confidence) || 0) * 100),
    exposures: state.ledger[id]?.exposures || 0
  }));
  const chain = verifyProvenanceChain(cwd);
  const policy = loadPolicy(cwd);
  const bom = buildAgentBom(cwd, { write: false });
  return {
    schema: 'idleproof.receipt.v1',
    project: state.project,
    generatedAt: now(),
    session: session ? {
      id: session.id,
      source: session.source,
      startedAt: session.startedAt,
      completedAt: session.completedAt || null,
      intent: { sha256: sha256(session.prompt || ''), chars: String(session.prompt || '').length },
      files: session.touchedFiles,
      changed: session.changed,
      proof: session.proof,
      findings: session.findings,
      concepts
    } : null,
    metrics,
    assurance: {
      policy: { profile: policy.profile, source: policy.source },
      provenance: { valid: chain.ok, events: chain.length, headSha256: chain.headHash },
      agentBillOfMaterials: bom
    }
  };
}

function writeReceipt(cwd, state) {
  const receipt = receiptFromState(state, cwd);
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
