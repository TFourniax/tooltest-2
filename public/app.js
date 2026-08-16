let feedbackLock = null;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#039;', '"':'&quot;' }[ch]));
const shortHash = (value, size = 12) => value ? `${String(value).slice(0, size)}…` : 'waiting';

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function riskLabel(card = {}) {
  if (card.risk >= 5) return 'HIGH RISK';
  if (card.risk >= 4) return 'RISK';
  return card.level?.toUpperCase() || 'CORE';
}

function renderFiles(session) {
  const files = session?.touchedFiles || [];
  $('files').innerHTML = files.length
    ? files.slice(-10).reverse().map((file) => `<div class="file-row"><span>${escapeHtml(file)}</span><span>touched</span></div>`).join('')
    : '<p class="empty">No files observed yet.</p>';
  const changed = session?.changed || { added: 0, deleted: 0 };
  $('linesChanged').textContent = `+${changed.added || 0} −${changed.deleted || 0}`;
}

function renderFindings(session) {
  const findings = session?.findings || [];
  $('findingCount').textContent = findings.length;
  $('findings').innerHTML = findings.length
    ? findings.slice(0, 7).map((f) => `<div class="finding ${escapeHtml(f.severity)}"><strong>${escapeHtml(f.title)}</strong><p>${escapeHtml(f.message)}</p></div>`).join('')
    : `<p class="empty">${session?.status === 'complete' ? 'No narrow deterministic rule fired on this diff. This is not a guarantee of safety.' : 'Checks appear when the agent completes a turn.'}</p>`;
}

function renderLedger(ledger) {
  const rows = Object.values(ledger || {}).sort((a,b) => (b.risk * b.exposures * (100 - b.confidence)) - (a.risk * a.exposures * (100 - a.confidence)));
  $('ledger').innerHTML = rows.length
    ? rows.slice(0, 8).map((entry) => `<div class="ledger-row"><span class="ledger-title">${escapeHtml(entry.title)}</span><span class="ledger-risk">×${entry.exposures} · r${entry.risk}</span><span class="ledger-meter" title="${entry.confidence}% confidence"><i style="width:${entry.confidence}%"></i></span></div>`).join('')
    : '<p class="empty">Concepts appear as the coding agent touches your codebase.</p>';
}

function renderJourney(state) {
  const learning = state.learning || {};
  const concepts = learning.concepts || [];
  const complete = state.session?.status === 'complete';
  const visible = concepts.slice(0, complete ? 6 : 3);
  $('learningJourney').innerHTML = visible.length
    ? visible.map((item) => `<div class="ledger-row">
        <span class="ledger-title">${escapeHtml(item.title)}</span>
        <span class="ledger-risk">${escapeHtml(item.status)} · ${item.confidence}%</span>
        <span class="ledger-meter" title="${item.confidence}% mastery"><i style="width:${item.confidence}%"></i></span>
      </div>`).join('')
    : '<p class="empty">The task knowledge map will appear as the agent reveals relevant concepts.</p>';
}

function renderLearning(state) {
  const card = state.card || {};
  const learning = state.learning || {};
  const handoff = state.session?.status === 'complete';
  const recap = learning.recap || {};
  $('cardRisk').textContent = handoff ? 'HANDOFF' : riskLabel(card);
  $('cardTime').textContent = `≈ ${Math.min(card.seconds || 30, Math.max(12, state.session?.estimatedWindow || card.seconds || 30))} sec`;
  $('cardConfidence').textContent = handoff
    ? `${recap.mastered || 0} mastered · ${recap.building || 0} building · ${recap.review || 0} review`
    : `${card.confidence || 0}% mastery · ${learning.phase || 'live'}`;
  $('cardTitle').textContent = card.title || 'Current task';
  $('cardWhy').textContent = card.why || 'IdleProof will connect a useful concept to the task as soon as the agent starts working.';
  $('cardLesson').textContent = card.lesson || '';
  $('question').textContent = card.question || 'What should you understand before accepting this change?';
  if (!feedbackLock || feedbackLock !== card.id) $('feedback').textContent = '';
  $('answers').innerHTML = (card.options || []).map((option, index) => `<button class="answer" data-choice="${index}">${escapeHtml(option)}</button>`).join('');
  document.querySelectorAll('.answer').forEach((button) => button.addEventListener('click', () => submitAnswer(card.id, Number(button.dataset.choice))));
  renderJourney(state);
}

function eventClass(policy) {
  const decision = policy?.originalDecision || policy?.decision;
  if (decision === 'deny') return 'deny';
  if (decision === 'ask') return 'ask';
  if ((policy?.risk || 0) >= 50) return 'risk';
  return '';
}

function renderTimeline(control) {
  const rows = [...(control.recentEvents || [])].reverse();
  $('timeline').innerHTML = rows.length
    ? rows.slice(0, 18).map((record) => {
        const e = record.event || {};
        const p = e.policy;
        return `<div class="trace-row ${eventClass(p)}">
          <span class="trace-seq">#${record.sequence}</span>
          <div class="trace-main"><strong>${escapeHtml(e.eventType || 'event')}${e.tool ? ` · ${escapeHtml(e.tool)}` : ''}</strong><span>${escapeHtml(e.source || 'agent')}${e.resource ? ` · ${escapeHtml(e.resource)}` : ''}${e.mcp?.server ? ` · MCP ${escapeHtml(e.mcp.server)}` : ''}</span></div>
          <div class="trace-side">${p ? `<span class="decision ${escapeHtml(p.originalDecision || p.decision)}">${escapeHtml((p.originalDecision || p.decision || 'allow').toUpperCase())}</span><small>risk ${p.risk || 0}</small>` : '<small>observed</small>'}</div>
        </div>`;
      }).join('')
    : '<p class="empty">Agent activity appears here so each lesson can be grounded in what is actually happening.</p>';
}

function renderDecision(control) {
  const latest = control.latestDecision;
  const banner = $('decisionBanner');
  if (!latest || ['allow', 'observe'].includes(latest.originalDecision || latest.decision)) {
    banner.className = 'decision-banner hidden';
    banner.innerHTML = '';
    return;
  }
  const decision = latest.originalDecision || latest.decision;
  banner.className = `decision-banner ${decision}`;
  const canApprove = ['ask', 'deny'].includes(decision) && latest.approvalFingerprint;
  banner.innerHTML = `<div><strong>${escapeHtml(decision.toUpperCase())} · risk ${latest.risk || 0}</strong><span>${escapeHtml(latest.reason || 'IdleProof paused a risky agent action.')}</span></div>${canApprove ? `<button id="approveAction" data-fingerprint="${escapeHtml(latest.approvalFingerprint)}">approve once</button>` : ''}`;
  const button = $('approveAction');
  if (button) button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api('/api/approve', { method:'POST', body:JSON.stringify({ fingerprint: button.dataset.fingerprint, uses:1, minutes:10 }) });
      button.textContent = 'approved · retry action';
    } catch { button.textContent = 'approval failed'; }
  });
}

function renderControlPlane(state) {
  const control = state.controlPlane || {};
  $('runtimeRisk').textContent = control.runtimeRisk || 0;
  $('traceEvents').textContent = control.provenance?.events || 0;
  $('integrityChip').textContent = control.provenance?.valid ? 'local trace verified' : 'trace invalid';
  $('integrityChip').className = `chip ${control.provenance?.valid ? 'chip-ok' : 'chip-bad'}`;
  $('traceHint').textContent = control.provenance?.valid ? 'agent context observed' : 'integrity failure';
  $('chainHead').textContent = `head: ${shortHash(control.provenance?.headHash, 14)}`;
  $('traceHash').textContent = shortHash(control.provenance?.headHash, 20);

  const policy = control.policy || {};
  $('policyProfile').textContent = policy.profile || 'balanced';
  $('policySource').textContent = policy.source === 'project' ? 'project policy' : 'built-in safety';
  $('policyHash').textContent = shortHash(policy.sha256, 20);
  $('policyText').textContent = 'Safety hooks stay under the hood while IdleProof teaches from the same live agent context.';

  const bom = control.agentBom || { tools:[], mcpServers:[], sources:[] };
  $('agentCount').textContent = `${bom.capabilities?.length || 0} capabilit${bom.capabilities?.length === 1 ? 'y' : 'ies'}`;
  $('mcpCount').textContent = `${bom.mcpServers?.length || 0} MCP server${bom.mcpServers?.length === 1 ? '' : 's'}`;
  $('agentSources').textContent = bom.sources?.length ? `Observed: ${bom.sources.join(', ')} · ${bom.tools?.length || 0} raw tools` : 'No agent execution observed yet.';

  const att = control.attestation || {};
  $('attestationState').textContent = !att.exists ? 'waiting' : att.valid ? 'signed · valid' : 'signature invalid';
  $('attestationSigner').textContent = att.fingerprint ? `recorder ${shortHash(att.fingerprint, 12)}` : 'no completed turn';

  const responsibility = control.responsibility || { ownerCoverage:0, responsibilityCoverage:0, obligations:[] };
  $('responsibilityCoverage').textContent = `${responsibility.responsibilityCoverage || 0}%`;
  $('ownerCoverage').textContent = `${responsibility.ownerCoverage || 0}% owners mapped`;
  $('responsibilityText').textContent = responsibility.obligations?.length
    ? `${responsibility.obligations.length} high-risk ownership obligation${responsibility.obligations.length === 1 ? '' : 's'} remain.`
    : state.session?.status === 'complete' ? 'No uncovered high-risk ownership obligation.' : 'Ownership evidence becomes available after a completed change.';
  $('acceptResponsibility').disabled = state.session?.status !== 'complete';

  renderDecision(control);
  renderTimeline(control);
}

function render(state) {
  const session = state.session;
  const active = session?.status === 'active';
  const complete = session?.status === 'complete';
  const agentName = session?.source === 'codex' ? 'Codex' : session?.source === 'claude' ? 'Claude Code' : session?.source ? session.source : 'Agent';
  const learning = state.learning || {};

  $('project').textContent = state.project;
  $('debt').textContent = state.metrics.debt;
  $('coverage').textContent = `${state.metrics.coverage}%`;
  document.body.classList.toggle('completed', complete);
  $('statusDot').classList.toggle('active', active);
  $('status').textContent = active ? `${agentName} working · live lesson ready` : complete ? `${agentName} turn complete · recap ready` : 'Waiting for a coding agent';
  $('window').textContent = active ? `≈ ${session.estimatedWindow || 20} sec learning window` : complete ? 'handoff review' : '0 sec window';
  $('currentTool').textContent = session?.currentTool || (complete ? 'Task complete · review what changed' : 'No active tool');
  $('headline').innerHTML = active
    ? 'Your agent is building.<br><em>Learn this task while it works.</em>'
    : complete
      ? 'The code is ready.<br><em>Make sure the understanding is too.</em>'
      : 'Vibe code fast.<br><em>Stay fluent in your own product.</em>';
  $('task').textContent = session?.prompt || 'Run `idleproof on`, then use Claude Code or Codex normally. IdleProof turns the agent’s live work into short, contextual lessons.';

  if (active && learning.file) $('currentTool').textContent = `${session.currentTool || 'Working'} · ${learning.file}`;

  renderControlPlane(state);
  renderLearning(state);
  renderFiles(session);
  renderFindings(session);
  renderLedger(state.ledger);
  $('proofId').textContent = shortHash(session?.proof?.diffSha256, 20);
}

async function submitAnswer(conceptId, choice) {
  try {
    feedbackLock = conceptId;
    const result = await api('/api/answer', { method: 'POST', body: JSON.stringify({ conceptId, choice }) });
    const buttons = [...document.querySelectorAll('.answer')];
    buttons.forEach((button, index) => {
      button.disabled = true;
      if (index === result.answer) button.classList.add('correct');
      else if (index === choice) button.classList.add('wrong');
    });
    $('feedback').textContent = result.correct ? `Correct. ${result.review}` : `Not quite. ${result.review}`;
    setTimeout(() => { feedbackLock = null; render(result.state); }, 1700);
  } catch (error) {
    $('feedback').textContent = `Could not record answer: ${error.message}`;
  }
}

async function poll() {
  try {
    const state = await api('/api/state');
    if (!feedbackLock) render(state);
  } catch {
    $('status').textContent = 'IdleProof disconnected';
    $('integrityChip').textContent = 'offline';
    $('integrityChip').className = 'chip chip-bad';
  }
}

$('copyEvidence').addEventListener('click', async () => {
  const button = $('copyEvidence');
  const before = button.textContent;
  try {
    button.disabled = true;
    button.textContent = 'preparing local evidence…';
    const evidence = await api('/api/evidence');
    await navigator.clipboard.writeText(JSON.stringify(evidence, null, 2));
    button.textContent = 'evidence copied';
  } catch {
    button.textContent = 'not ready';
  } finally {
    setTimeout(() => { button.disabled = false; button.textContent = before; }, 1500);
  }
});

$('acceptResponsibility').addEventListener('click', async () => {
  const button = $('acceptResponsibility');
  const before = button.textContent;
  try {
    button.disabled = true;
    button.textContent = 'binding acceptance…';
    const result = await api('/api/responsibility/accept', { method:'POST', body:JSON.stringify({}) });
    button.textContent = `accepted · ${result.responsibility.responsibilityCoverage}% covered`;
    await poll();
  } catch {
    button.textContent = 'acceptance failed';
  } finally {
    setTimeout(() => { button.disabled = false; button.textContent = before; }, 1800);
  }
});

poll();
setInterval(poll, 1000);
