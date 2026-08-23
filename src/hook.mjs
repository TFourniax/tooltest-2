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
import { cachedFeatureModel, rememberFeature } from './feature-memory.mjs';
import { buildHookDelivery } from './delivery.mjs';
import { captureBaselineIdentity, finalizeChangeIdentity } from './change-identity.mjs';
import { schedulePortalSync } from './portal-client.mjs';
import { taskContextQuery, taskDisplayText, taskMetadata, updateSessionTask } from './task.mjs';
import { continuityCounts, loadContinuityContext, renderContinuityForAgent } from './continuity.mjs';

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
      promptChars: 0,
      promptSha256: null,
      task: null,
      taskHistory: [],
      currentTool: null,
      estimatedWindow: 20,
      touchedFiles: [],
      changed: { added: 0, deleted: 0 },
      proof: null,
      baselineIdentity: null,
      changeIdentity: null,
      findings: [],
      concepts: {},
      events: []
    };
  }
  const session = state.sessions[id];
  session.taskHistory ||= [];
  return session;
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

function sessionForEvent(state, event) {
  if (event.session_id && state.sessions?.[event.session_id]) return state.sessions[event.session_id];
  return Object.values(state.sessions || {}).sort((a, b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))[0] || null;
}

function loadingOutput(cwd, state, event) {
  const session = sessionForEvent(state, event);
  if (!session?.task?.id) return null;
  const query = taskContextQuery(session);
  const continuity = loadContinuityContext(cwd, query);
  const counts = continuityCounts(continuity);
  const continuityText = renderContinuityForAgent(continuity, { maxChars: 5200 });
  const primary = taskDisplayText(session) || 'current task';
  const focus = String(session.task?.latestFocus || '').replace(/\s+/g, ' ').trim();
  const focusLine = focus && focus !== session.task.anchor ? `\nCurrent focus: ${focus.slice(0, 260)}` : '';
  const taskContext = [
    `ACTIVE TASK ${session.task.id}`,
    `Primary objective: ${String(session.task.anchor || primary).slice(0, 1000)}`,
    focusLine ? focusLine.trimStart() : null,
    continuityText || null
  ].filter(Boolean).join('\n\n');
  const contextSummary = counts
    ? `${counts.objectives} objective(s) · ${counts.decisions} decision(s) · ${counts.criticalInvariants || counts.invariants} invariant(s) · ${counts.debt} open debt item(s)`
    : 'task identity ready · project continuity will enrich when DiffWitness is available';
  const systemMessage = [
    `IdleProof · loading ${session.task.id}`,
    `Task: ${primary}`,
    `Context: ${contextSummary}`,
    'Engine: local/backoffice · correctness remains a DiffWitness evidence claim at handoff.'
  ].join('\n');
  return {
    systemMessage,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: taskContext.slice(0, 6500)
    }
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
  let surfacedExplanation = null;

  const state = mutateState(cwd, (state) => {
    const session = ensureSession(state, event);
    session.source = event.source || session.source || 'agent';
    session.lastEventAt = now();
    recordEvent(session, event, policyDecision, provenanceRecord, provenanceError);

    if (eventName === 'SessionStart') {
      session.status = 'idle';
      session.estimatedWindow = 0;
      if (!session.baselineIdentity) session.baselineIdentity = captureBaselineIdentity(cwd);
    }

    if (eventName === 'UserPromptSubmit') {
      if (!session.baselineIdentity) session.baselineIdentity = captureBaselineIdentity(cwd);
      const rawPrompt = String(event.prompt || '');
      session.status = 'active';
      // `prompt` remains the bounded latest turn for backward-compatible local diagnostics. The
      // stable user task is tracked separately so a reply such as "yes, continue" cannot erase the
      // objective that IdleProof is explaining. Full input provenance remains one-way metadata.
      session.prompt = rawPrompt.slice(0, 1200);
      session.promptChars = rawPrompt.length;
      session.promptSha256 = sha256(rawPrompt);
      const taskUpdate = updateSessionTask(session, rawPrompt, { sessionId: session.id });
      session.lastTaskBoundary = taskUpdate.boundary;
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
      session.changeIdentity = finalizeChangeIdentity(cwd, session.baselineIdentity);
      for (const id of conceptsFromGitSnapshot(snapshot)) exposeConcept(state, session, id);
      session.touchedFiles = [...new Set([...session.touchedFiles, ...snapshot.files])].slice(0, 80);
      session.changed = { added: snapshot.added, deleted: snapshot.deleted };
      session.proof = {
        diffSha256: snapshot.diffHash,
        head: snapshot.head,
        capturedAt: now(),
        changeId: session.changeIdentity?.available ? session.changeIdentity.changeId : null
      };
      session.findings = analyzeDiff(snapshot.diff);
      session.status = 'complete';
      session.currentTool = null;
      session.estimatedWindow = 0;
      session.completedAt = now();
      if (session.task && !session.task.completedAt) session.task.completedAt = session.completedAt;

      const featureModel = cachedFeatureModel(cwd, session);
      const featureMemory = rememberFeature(state, session, featureModel);
      session.featureModel = featureModel.generatedFrom.filesInspected ? {
        featureKey: featureModel.featureKey,
        fingerprint: featureModel.fingerprint,
        confidence: featureModel.confidence,
        story: featureModel.story,
        surfaces: featureModel.surfaces,
        tests: featureModel.tests,
        riskNotes: featureModel.riskNotes,
        explainBack: featureModel.explainBack,
        drift: featureMemory?.lastDrift || null,
        needsRefresh: Boolean(featureMemory?.needsRefresh),
        disclaimer: featureModel.disclaimer
      } : null;
    }

    const delivery = buildHookDelivery(cwd, state, session, eventName);
    if (delivery) {
      session.lastSurfacedExplanationKey = delivery.key;
      session.lastExplanationAt = now();
      session.taskSignals = delivery.signals;
      surfacedExplanation = delivery.message;
    }

    trimSessions(state);
    return state;
  });

  let attestation = null;
  let attestationError = null;
  let portalSync = null;
  if (['Stop', 'SessionEnd', 'generic-stop'].includes(eventName)) {
    writeReceipt(cwd, state);
    try { attestation = createAttestation(cwd); }
    catch (error) { attestationError = error.message; }
    // Portal transport is deliberately fail-open for the coding agent. The completed snapshot
    // is first persisted to a bounded local queue, then a detached helper attempts delivery.
    portalSync = schedulePortalSync(cwd);
  }

  const hookOutput = policyDecision
    ? policyDecisionOutput(event, policyDecision)
    : eventName === 'UserPromptSubmit'
      ? loadingOutput(cwd, state, event)
      : surfacedExplanation
        ? { systemMessage: surfacedExplanation }
        : null;

  return {
    state,
    policyDecision,
    provenance: provenanceRecord,
    provenanceError,
    attestation,
    attestationError,
    portalSync,
    hookOutput
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
  const boundedPrompt = String(session?.prompt || '');
  const promptChars = Number.isInteger(session?.promptChars) ? session.promptChars : boundedPrompt.length;
  const promptSha256 = /^[a-f0-9]{64}$/.test(String(session?.promptSha256 || '')) ? session.promptSha256 : sha256(boundedPrompt);
  return {
    schema: 'idleproof.receipt.v1',
    project: state.project,
    generatedAt: now(),
    session: session ? {
      id: session.id,
      source: session.source,
      startedAt: session.startedAt,
      completedAt: session.completedAt || null,
      task: taskMetadata(session),
      intent: { sha256: promptSha256, chars: promptChars, retainedChars: boundedPrompt.length },
      files: session.touchedFiles,
      changed: session.changed,
      proof: session.proof,
      change: session.changeIdentity || null,
      findings: session.findings,
      concepts,
      featureModel: session.featureModel || null
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
