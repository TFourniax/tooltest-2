let feedbackLock = null;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[ch]));
const shortHash = (value, size = 12) => value ? `${String(value).slice(0, size)}…` : 'waiting';

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function riskLabel(card) {
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
  const rows = Object.values(ledger || {}).sort((a,b) => (b.risk * b.exposures * (100-b.confidence)) - (a.risk * a.exposures * (100-a.confidence)));
  $('ledger').innerHTML = rows.length
    ? rows.slice(0,8).map((entry) => `<div class="ledger-row"><span class="ledger-title">${escapeHtml(entry.title)}</span><span class="ledger-risk">×${entry.exposures} · r${entry.risk}</span><span class="ledger-meter" title="${entry.confidence}% confidence"><i style="width:${entry.confidence}%"></i></span></div>`).join('')
    : '<p class="empty">No human-assurance trace yet. Concepts appear as agents touch the codebase.</p>';
}

function renderCard(state) {
  const card = state.card;
  const handoff = state.session?.status === 'complete';
  const reviewMode = handoff || state.preferences.mode === 'review';
  $('cardRisk').textContent = handoff ? 'HANDOFF' : riskLabel(card);
  $('cardTime').textContent = `≈ ${Math.min(card.seconds || 30, Math.max(12, state.session?.estimatedWindow || card.seconds || 30))} sec`;
  $('cardConfidence').textContent = `${card.confidence || 0}% verified confidence`;
  $('cardTitle').textContent = card.title;
  $('cardWhy').textContent = reviewMode ? `Review boundary: ${card.review}` : card.why;
  $('cardLesson').textContent = reviewMode
    ? `IdleProof has ${card.exposures} exposure${card.exposures === 1 ? '' : 's'} for this concept. Treat this as evidence of recall, not proof of engineering competence.`
    : card.lesson;
  $('question').textContent = card.question;
  if (!feedbackLock || feedbackLock !== card.id) $('feedback').textContent = '';
  $('answers').innerHTML = card.options.map((option, index) => `<button class="answer" data-choice="${index}">${escapeHtml(option)}</button>`).join('');
  document.querySelectorAll('.answer').forEach((button) => button.addEventListener('click', () => submitAnswer(card.id, Number(button.dataset.choice))));
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
    : '<p class="empty">Agent lifecycle events will appear here. The recorder stores metadata and payload digests, not raw prompts.</p>';
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
  banner.innerHTML = `<div><strong>${escapeHtml(decision.toUpperCase())} · risk ${latest.risk || 0}</strong><span>${escapeHtml(latest.reason || 'Runtime policy intervened before execution.')}</span></div>${canApprove ? `<button id="approveAction" data-fingerprint="${escapeHtml(latest.approvalFingerprint)}">approve once</button>` : ''}`;
  const button = $('approveAction');
  if (button) button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api('/api/approve', { method:'POST', body:JSON.stringify({ fingerprint: button.dataset.fingerprint, uses:1, minutes:10 }) });
      button.textContent = 'approved · retry action';
    } catch { button.textContent = 'approval failed'; }
  });
}

function render(state) {
  const control = state.controlPlane || {};
  const session = state.session;
  const active = session?.status === 'active';
  const complete = session?.status === 'complete';
  const agentName = session?.source === 'codex' ? 'Codex' : session?.source === 'claude' ? 'Claude Code' : session?.source ? session.source : 'Agent';

  $('project').textContent = state.project;
  $('runtimeRisk').textContent = control.runtimeRisk || 0;
  $('traceEvents').textContent = control.provenance?.events || 0;
  $('debt').textContent = state.metrics.debt;
  $('coverage').textContent = `${state.metrics.coverage}%`;
  $('integrityChip').textContent = control.provenance?.valid ? 'trace verified' : 'trace invalid';
  $('integrityChip').className = `chip ${control.provenance?.valid ? 'chip-ok' : 'chip-bad'}`;
  $('traceHint').textContent = control.provenance?.valid ? 'hash-chain valid' : 'integrity failure';
  $('chainHead').textContent = `head: ${shortHash(control.provenance?.headHash, 14)}`;
  $('traceHash').textContent = shortHash(control.provenance?.headHash, 20);

  const policy = control.policy || {};
  $('policyProfile').textContent = policy.profile || 'balanced';
  $('policySource').textContent = policy.source === 'project' ? 'project policy' : 'built-in policy';
  $('policyHash').textContent = shortHash(policy.sha256, 20);
  $('policyText').textContent = policy.profile === 'strict'
    ? 'Strict mode fails closed if high-risk execution cannot be traced.'
    : policy.profile === 'observe'
      ? 'Observe mode records decisions without blocking matched actions.'
      : 'Balanced mode blocks catastrophic actions and requests review for high-risk mutations.';

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
    : session?.status === 'complete' ? 'No uncovered high-risk ownership obligation.' : 'A completed change creates maintenance-owner obligations.';
  $('acceptResponsibility').disabled = session?.status !== 'complete';

  document.body.classList.toggle('completed', complete);
  $('statusDot').classList.toggle('active', active);
  $('status').textContent = active ? `${agentName} working · control plane live` : complete ? `${agentName} turn complete · evidence sealed` : 'Waiting for an agent';
  $('window').textContent = active ? `≈ ${session.estimatedWindow || 20} sec window` : complete ? 'turn sealed' : '0 sec window';
  $('currentTool').textContent = session?.currentTool || (complete ? 'Evidence + handoff ready' : 'No active tool');
  $('headline').innerHTML = active
    ? 'The agent is moving.<br><em>The guardrails move with it.</em>'
    : complete
      ? 'The code changed.<br><em>The evidence changed with it.</em>'
      : 'Every agent action.<br><em>Governed. Traceable. Ownable.</em>';
  $('task').textContent = session?.prompt || 'Run `idleproof on`, then use Claude Code or Codex normally. IdleProof sits around the agent, not inside it.';

  renderDecision(control);
  renderTimeline(control);
  renderCard(state);
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
    $('status').textContent = 'Control plane disconnected';
    $('integrityChip').textContent = 'offline';
    $('integrityChip').className = 'chip chip-bad';
  }
}

$('copyEvidence').addEventListener('click', async () => {
  const button = $('copyEvidence');
  const before = button.textContent;
  try {
    button.disabled = true;
    button.textContent = 'sealing evidence…';
    const evidence = await api('/api/evidence');
    await navigator.clipboard.writeText(JSON.stringify(evidence, null, 2));
    button.textContent = 'evidence copied';
  } catch {
    button.textContent = 'not ready';
  } finally {
    setTimeout(() => { button.disabled = false; button.textContent = before; }, 1500);
  }
});

poll();
setInterval(poll, 1000);

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
