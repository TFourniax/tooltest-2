let feedbackLock = null;
let featureFeedbackLock = null;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#039;', '"':'&quot;' }[ch]));
const shortHash = (value, size = 12) => value ? `${String(value).slice(0, size)}…` : 'waiting';

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function riskLabel(card = {}) {
  if (card.risk >= 5) return 'HIGH RISK';
  if (card.risk >= 4) return 'RISK';
  return card.level?.toUpperCase() || 'CORE';
}

function resumeLabel(value) {
  if (!value) return 'when the task context changes';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'soon';
  const minutes = Math.max(1, Math.ceil((date.getTime() - Date.now()) / 60000));
  return `in about ${minutes} min`;
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
  const concepts = state.learning?.concepts || [];
  const complete = state.session?.status === 'complete';
  const visible = concepts.slice(0, complete ? 6 : 3);
  $('learningJourney').innerHTML = visible.length
    ? visible.map((item) => `<div class="ledger-row"><span class="ledger-title">${escapeHtml(item.title)}</span><span class="ledger-risk">${escapeHtml(item.status)} · ${item.confidence}%</span><span class="ledger-meter" title="${item.confidence}% mastery"><i style="width:${item.confidence}%"></i></span></div>`).join('')
    : '<p class="empty">The task knowledge map will appear as the agent reveals relevant concepts.</p>';
}

function renderLearning(state) {
  const card = state.card || {};
  const learning = state.learning || {};
  const handoff = state.session?.status === 'complete';
  const recap = learning.recap || {};

  if (learning.paused) {
    const first = learning.snoozedConceptIds?.[0] || '';
    $('cardRisk').textContent = 'PAUSED';
    $('cardTime').textContent = resumeLabel(learning.resumeAt);
    $('cardConfidence').textContent = `${recap.mastered || 0} mastered · ${recap.building || 0} building · ${recap.review || 0} review`;
    $('cardTitle').textContent = 'No lesson forced right now';
    $('cardWhy').textContent = 'You chose “not now”. IdleProof does not count that as a wrong answer or reduce your mastery.';
    $('cardLesson').textContent = 'The agent can keep working. A useful lesson returns when context changes or the snooze expires.';
    $('question').textContent = '';
    $('answers').innerHTML = first ? '<button class="text-button" id="resumeLesson" type="button">resume learning now</button>' : '';
    $('feedback').textContent = '';
    $('resumeLesson')?.addEventListener('click', () => snoozeLesson(first, 0));
    renderJourney(state);
    return;
  }

  $('cardRisk').textContent = handoff ? 'HANDOFF' : riskLabel(card);
  const depth = card.presentation?.label ? ` · ${card.presentation.label}` : '';
  $('cardTime').textContent = `≈ ${card.seconds || 20} sec${depth}`;
  $('cardConfidence').textContent = handoff
    ? `${recap.mastered || 0} mastered · ${recap.building || 0} building · ${recap.review || 0} review`
    : `${card.confidence || 0}% mastery · ${learning.phase || 'live'}`;
  $('cardTitle').textContent = card.title || 'Current task';
  $('cardWhy').textContent = card.why || 'IdleProof will connect a useful concept to the task as soon as the agent starts working.';
  $('cardLesson').textContent = card.lesson || '';
  $('question').textContent = card.question || 'What should you understand before accepting this change?';
  if (!feedbackLock || feedbackLock !== card.id) $('feedback').textContent = '';
  const choices = (card.options || []).map((option, index) => `<button class="answer" data-choice="${index}">${escapeHtml(option)}</button>`).join('');
  const snooze = card.id ? '<button class="text-button" id="snoozeLesson" type="button">not now · 10 min</button>' : '';
  $('answers').innerHTML = `${choices}${snooze}`;
  document.querySelectorAll('#answers .answer').forEach((button) => button.addEventListener('click', () => submitAnswer(card.id, Number(button.dataset.choice))));
  $('snoozeLesson')?.addEventListener('click', () => snoozeLesson(card.id, 10));
  renderJourney(state);
}

function storyStep(step, index) {
  const role = escapeHtml(step.role || step.type || 'code');
  return `<div class="feature-step role-${role}"><span>${role}</span><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.evidence || 'observed locally')}</small></div>${index >= 0 ? '<span class="feature-arrow" aria-hidden="true">→</span>' : ''}`;
}

function surfaceChip(type, value) {
  return `<span class="surface-chip"><b>${escapeHtml(type)}</b>${escapeHtml(value)}</span>`;
}

function driftDetails(drift = {}) {
  const additions = Object.entries(drift.added || {}).flatMap(([group, values]) => (values || []).map((value) => `<span class="drift-token added">+ ${escapeHtml(group)} · ${escapeHtml(value)}</span>`));
  const removals = Object.entries(drift.removed || {}).flatMap(([group, values]) => (values || []).map((value) => `<span class="drift-token removed">− ${escapeHtml(group)} · ${escapeHtml(value)}</span>`));
  return [...additions, ...removals].slice(0, 8).join('');
}

function renderFeatureMemory(memory = []) {
  $('featureMemoryCount').textContent = `${memory.length} learned`;
  $('featureMemory').innerHTML = memory.length ? memory.map((item) => {
    const story = (item.story || []).slice(0, 4).map((step) => escapeHtml(step.label)).join(' → ');
    const surfaces = [...(item.surfaces?.technologies || []).slice(0, 2), ...(item.surfaces?.routes || []).slice(0, 1), ...(item.surfaces?.tables || []).slice(0, 1)];
    const status = item.needsRefresh ? '<span class="refresh-badge">refresh</span>' : `<span>${item.confidence || 0}% fluent</span>`;
    const drift = item.needsRefresh && item.drift?.summary ? `<div class="memory-drift">${escapeHtml(item.drift.summary)}</div>` : '';
    return `<article class="memory-card ${item.needsRefresh ? 'needs-refresh' : ''}"><div class="memory-top"><strong>${escapeHtml(item.task || 'Previous feature')}</strong>${status}</div><p>${story || 'Feature structure captured from a completed task.'}</p>${drift}<div class="memory-tags">${surfaces.map((value) => `<span>${escapeHtml(value)}</span>`).join('')}</div><div class="memory-meter"><i style="width:${item.confidence || 0}%"></i></div></article>`;
  }).join('') : '<p class="empty">Completed feature tasks will accumulate here and become spaced-review material.</p>';
}

function renderFeatureModel(state) {
  const model = state.featureModel;
  const projectFluency = state.metrics?.featureCoverage || 0;
  const pending = state.projectModel?.stats?.pendingFeatureReviews || 0;
  $('featureFluency').textContent = `${projectFluency}%`;
  $('featureFluencyHint').textContent = pending ? `${pending} feature review${pending === 1 ? '' : 's'} waiting` : state.metrics?.featuresSeen ? `${state.metrics.featuresSeen} feature mental model${state.metrics.featuresSeen === 1 ? '' : 's'} tracked` : 'mental models demonstrated';
  renderFeatureMemory(state.featureMemory || []);

  if (!model) {
    $('featureModelStatus').textContent = 'waiting for code context';
    $('currentFeatureFluency').textContent = '0%';
    $('featureDisclaimer').textContent = 'IdleProof will build a bounded static map once the agent touches project-local code.';
    $('featureDrift').className = 'drift-banner hidden';
    $('featureStory').innerHTML = '<p class="empty">No connected feature structure observed yet.</p>';
    $('featureSurfaces').innerHTML = '';
    $('featureRiskNotes').innerHTML = '';
    $('featureExplainBack').className = 'explain-back hidden';
    $('featureChallenge').className = 'challenge feature-challenge hidden';
    return;
  }

  $('featureModelStatus').textContent = `bounded static · ${model.generatedFrom?.filesInspected || 0} files`;
  $('currentFeatureFluency').textContent = `${model.fluency?.confidence || 0}%`;
  $('featureDisclaimer').textContent = model.disclaimer || 'This is a bounded static map, not a proven runtime trace.';

  if (model.drift?.changed) {
    $('featureDrift').className = `drift-banner ${escapeHtml(model.drift.level || 'minor')}`;
    $('featureDrift').innerHTML = `<div><span>${model.drift.preview ? 'LIVE MENTAL MODEL DRIFT' : 'MENTAL MODEL DRIFT'} · ${escapeHtml((model.drift.level || 'changed').toUpperCase())}</span><strong>${escapeHtml(model.drift.summary || 'Feature structure changed.')}</strong></div><div class="drift-tokens">${driftDetails(model.drift)}</div>`;
  } else {
    $('featureDrift').className = 'drift-banner hidden';
    $('featureDrift').innerHTML = '';
  }

  const story = model.story || [];
  $('featureStory').innerHTML = story.length ? story.map((step, index) => storyStep(step, index === story.length - 1 ? -1 : index)).join('') : '<p class="empty">IdleProof sees code, but not enough connected structure to tell a useful feature story yet.</p>';
  const surfaces = [
    ...(model.surfaces?.routes || []).slice(0, 4).map((v) => ['route', v]),
    ...(model.surfaces?.technologies || []).slice(0, 4).map((v) => ['external', v]),
    ...(model.surfaces?.tables || []).slice(0, 4).map((v) => ['data', v]),
    ...(model.tests || []).slice(0, 3).map((v) => ['test', v])
  ];
  $('featureSurfaces').innerHTML = surfaces.map(([type, value]) => surfaceChip(type, value)).join('');
  $('featureRiskNotes').innerHTML = (model.riskNotes || []).map((note) => `<p>↳ ${escapeHtml(note)}</p>`).join('');

  if (model.explainBack) {
    $('featureExplainBack').className = 'explain-back';
    $('featureExplainBack').innerHTML = `<span>60-SECOND EXPLAIN-BACK</span><p>${escapeHtml(model.explainBack)}</p>`;
  } else $('featureExplainBack').className = 'explain-back hidden';

  if (model.challenge) {
    $('featureChallenge').className = 'challenge feature-challenge';
    $('featureQuestion').textContent = model.challenge.question;
    if (!featureFeedbackLock || featureFeedbackLock !== model.fingerprint) $('featureFeedback').textContent = '';
    $('featureAnswers').innerHTML = (model.challenge.options || []).map((option, index) => `<button class="answer feature-answer" data-choice="${index}">${escapeHtml(option)}</button>`).join('');
    document.querySelectorAll('.feature-answer').forEach((button) => button.addEventListener('click', () => submitFeatureAnswer(model.fingerprint, Number(button.dataset.choice))));
  } else $('featureChallenge').className = 'challenge feature-challenge hidden';
}

function renderProjectModel(state) {
  const model = state.projectModel || {};
  const impact = model.impact || { otherFeatures: [], blastRadius: 0, summary: '' };
  $('impactCount').textContent = `${impact.blastRadius || 0} other feature${impact.blastRadius === 1 ? '' : 's'}`;
  $('impactSummary').textContent = impact.summary || 'IdleProof will compare touched files with feature mental models you have already learned.';
  $('impactFeatures').innerHTML = impact.otherFeatures?.length ? impact.otherFeatures.slice(0, 6).map((item) => {
    const shared = (item.sharedFiles || []).map((entry) => `${entry.role} · ${entry.file}`).join(' · ');
    const status = item.needsRefresh || item.confidence < 60 ? 'review recommended' : `${item.confidence}% fluent`;
    return `<article class="impact-card ${item.needsRefresh || item.confidence < 60 ? 'weak' : ''}"><div><strong>${escapeHtml(item.task)}</strong><span>${escapeHtml(status)}</span></div><p>shared through ${escapeHtml(shared)}</p></article>`;
  }).join('') : '<p class="empty">No other learned feature currently shares the files touched by this task.</p>';

  const hotspots = model.topology?.hotspots || [];
  const queue = model.reviewQueue || [];
  $('projectModelStats').textContent = `${hotspots.length} hotspot${hotspots.length === 1 ? '' : 's'} · ${model.stats?.pendingFeatureReviews || 0} review`;
  $('projectHotspots').innerHTML = hotspots.length ? hotspots.slice(0, 7).map((item) => `<div class="compact-row"><div><strong>${escapeHtml(item.file)}</strong><span>${escapeHtml(item.role)} · ${item.featureCount} features</span></div><b>${item.averageFluency}%</b></div>`).join('') : '<p class="empty">Hotspots emerge when multiple learned features share code.</p>';
  $('featureReviewQueue').innerHTML = queue.length ? queue.slice(0, 7).map((item) => `<div class="compact-row ${item.needsRefresh ? 'refresh-row' : ''}"><div><strong>${escapeHtml(item.task)}</strong><span>${escapeHtml(item.reason)}</span></div><b>${item.confidence}%</b></div>`).join('') : '<p class="empty">Feature reviews appear as your project memory grows.</p>';
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
  $('timeline').innerHTML = rows.length ? rows.slice(0, 18).map((record) => {
    const e = record.event || {}; const p = e.policy;
    return `<div class="trace-row ${eventClass(p)}"><span class="trace-seq">#${record.sequence}</span><div class="trace-main"><strong>${escapeHtml(e.eventType || 'event')}${e.tool ? ` · ${escapeHtml(e.tool)}` : ''}</strong><span>${escapeHtml(e.source || 'agent')}${e.resource ? ` · ${escapeHtml(e.resource)}` : ''}${e.mcp?.server ? ` · MCP ${escapeHtml(e.mcp.server)}` : ''}</span></div><div class="trace-side">${p ? `<span class="decision ${escapeHtml(p.originalDecision || p.decision)}">${escapeHtml((p.originalDecision || p.decision || 'allow').toUpperCase())}</span><small>risk ${p.risk || 0}</small>` : '<small>observed</small>'}</div></div>`;
  }).join('') : '<p class="empty">Agent activity appears here so each lesson can be grounded in what is actually happening.</p>';
}

function renderDecision(control) {
  const latest = control.latestDecision; const banner = $('decisionBanner');
  if (!latest || ['allow', 'observe'].includes(latest.originalDecision || latest.decision)) { banner.className = 'decision-banner hidden'; banner.innerHTML = ''; return; }
  const decision = latest.originalDecision || latest.decision;
  banner.className = `decision-banner ${decision}`;
  const canApprove = ['ask', 'deny'].includes(decision) && latest.approvalFingerprint;
  banner.innerHTML = `<div><strong>${escapeHtml(decision.toUpperCase())} · risk ${latest.risk || 0}</strong><span>${escapeHtml(latest.reason || 'IdleProof paused a risky agent action.')}</span></div>${canApprove ? `<button id="approveAction" data-fingerprint="${escapeHtml(latest.approvalFingerprint)}">approve once</button>` : ''}`;
  $('approveAction')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try { await api('/api/approve', { method:'POST', body:JSON.stringify({ fingerprint: button.dataset.fingerprint, uses:1, minutes:10 }) }); button.textContent = 'approved · retry action'; }
    catch { button.textContent = 'approval failed'; }
  });
}

function renderControlPlane(state) {
  const control = state.controlPlane || {};
  $('runtimeRisk').textContent = control.runtimeRisk || 0;
  $('integrityChip').textContent = control.provenance?.valid ? 'local trace verified' : 'trace invalid';
  $('integrityChip').className = `chip ${control.provenance?.valid ? 'chip-ok' : 'chip-bad'}`;
  $('chainHead').textContent = `head: ${shortHash(control.provenance?.headHash, 14)}`;
  $('traceHash').textContent = shortHash(control.provenance?.headHash, 20);
  const policy = control.policy || {};
  $('policyProfile').textContent = policy.profile || 'balanced'; $('policySource').textContent = policy.source === 'project' ? 'project policy' : 'built-in safety'; $('policyHash').textContent = shortHash(policy.sha256, 20);
  $('policyText').textContent = 'Safety hooks stay under the hood while IdleProof teaches from the same live agent context.';
  const bom = control.agentBom || { tools:[], mcpServers:[], sources:[] };
  $('agentCount').textContent = `${bom.capabilities?.length || 0} capabilit${bom.capabilities?.length === 1 ? 'y' : 'ies'}`; $('mcpCount').textContent = `${bom.mcpServers?.length || 0} MCP server${bom.mcpServers?.length === 1 ? '' : 's'}`;
  $('agentSources').textContent = bom.sources?.length ? `Observed: ${bom.sources.join(', ')} · ${control.provenance?.events || 0} events` : 'No agent execution observed yet.';
  const att = control.attestation || {}; $('attestationState').textContent = !att.exists ? 'waiting' : att.valid ? 'signed · valid' : 'signature invalid'; $('attestationSigner').textContent = att.fingerprint ? `recorder ${shortHash(att.fingerprint, 12)}` : 'no completed turn';
  const responsibility = control.responsibility || { ownerCoverage:0, responsibilityCoverage:0, obligations:[] };
  $('responsibilityCoverage').textContent = `${responsibility.responsibilityCoverage || 0}%`; $('ownerCoverage').textContent = `${responsibility.ownerCoverage || 0}% owners mapped`;
  $('responsibilityText').textContent = responsibility.obligations?.length ? `${responsibility.obligations.length} high-risk ownership obligation${responsibility.obligations.length === 1 ? '' : 's'} remain.` : state.session?.status === 'complete' ? 'No uncovered high-risk ownership obligation.' : 'Ownership evidence becomes available after a completed change.';
  $('acceptResponsibility').disabled = state.session?.status !== 'complete';
  renderDecision(control); renderTimeline(control);
}

function render(state) {
  const session = state.session; const active = session?.status === 'active'; const complete = session?.status === 'complete';
  const agentName = session?.source === 'codex' ? 'Codex' : session?.source === 'claude' ? 'Claude Code' : session?.source ? session.source : 'Agent';
  const learning = state.learning || {};
  $('project').textContent = state.project; $('debt').textContent = state.metrics.debt; $('coverage').textContent = `${state.metrics.coverage}%`;
  document.body.classList.toggle('completed', complete); $('statusDot').classList.toggle('active', active);
  $('status').textContent = active ? `${agentName} working · ${learning.paused ? 'learning snoozed' : 'live lesson ready'}` : complete ? `${agentName} turn complete · mental-model review ready` : 'Waiting for a coding agent';
  $('window').textContent = active ? `≈ ${session.estimatedWindow || 20} sec learning window` : complete ? 'handoff review' : '0 sec window';
  $('currentTool').textContent = session?.currentTool || (complete ? 'Task complete · review what changed' : 'No active tool');
  $('headline').innerHTML = active ? 'Your agent is building.<br><em>Keep the mental model.</em>' : complete ? 'The code is ready.<br><em>Make sure the understanding is too.</em>' : 'Vibe code fast.<br><em>Stay fluent in your own product.</em>';
  $('task').textContent = session?.prompt || 'Run `idleproof on`, then use Claude Code or Codex normally. IdleProof turns live agent work into task-specific learning and feature understanding.';
  if (active && learning.file) $('currentTool').textContent = `${session.currentTool || 'Working'} · ${learning.file}`;
  renderControlPlane(state); renderLearning(state); renderFeatureModel(state); renderProjectModel(state); renderFiles(session); renderFindings(session); renderLedger(state.ledger); $('proofId').textContent = shortHash(session?.proof?.diffSha256, 20);
}

async function submitAnswer(conceptId, choice) {
  try {
    feedbackLock = conceptId; const result = await api('/api/answer', { method: 'POST', body: JSON.stringify({ conceptId, choice }) });
    [...document.querySelectorAll('#answers .answer')].forEach((button, index) => { button.disabled = true; if (index === result.answer) button.classList.add('correct'); else if (index === choice) button.classList.add('wrong'); });
    $('feedback').textContent = result.correct ? `Correct. ${result.review}` : `Not quite. ${result.review}`;
    setTimeout(() => { feedbackLock = null; render(result.state); }, 1700);
  } catch (error) { feedbackLock = null; $('feedback').textContent = `Could not record answer: ${error.message}`; }
}

async function submitFeatureAnswer(fingerprint, choice) {
  try {
    featureFeedbackLock = fingerprint; const result = await api('/api/feature-answer', { method: 'POST', body: JSON.stringify({ fingerprint, choice }) });
    [...document.querySelectorAll('.feature-answer')].forEach((button, index) => { button.disabled = true; if (index === result.answer) button.classList.add('correct'); else if (index === choice) button.classList.add('wrong'); });
    $('featureFeedback').textContent = `${result.correct ? 'Correct.' : 'Not quite.'} ${result.explanation}`;
    setTimeout(() => { featureFeedbackLock = null; render(result.state); }, 2200);
  } catch (error) { featureFeedbackLock = null; $('featureFeedback').textContent = `Could not record feature check: ${error.message}`; }
}

async function snoozeLesson(conceptId, minutes = 10) {
  if (!conceptId) return;
  try { feedbackLock = conceptId; const result = await api('/api/snooze', { method: 'POST', body: JSON.stringify({ conceptId, minutes }) }); feedbackLock = null; render(result.state); }
  catch (error) { feedbackLock = null; $('feedback').textContent = `Could not pause this lesson: ${error.message}`; }
}

async function poll() {
  try { const state = await api('/api/state'); if (!feedbackLock && !featureFeedbackLock) render(state); }
  catch { $('status').textContent = 'IdleProof disconnected'; $('integrityChip').textContent = 'offline'; $('integrityChip').className = 'chip chip-bad'; }
}

$('copyEvidence').addEventListener('click', async () => {
  const button = $('copyEvidence'); const before = button.textContent;
  try { button.disabled = true; button.textContent = 'preparing local evidence…'; const evidence = await api('/api/evidence'); await navigator.clipboard.writeText(JSON.stringify(evidence, null, 2)); button.textContent = 'evidence copied'; }
  catch { button.textContent = 'not ready'; }
  finally { setTimeout(() => { button.disabled = false; button.textContent = before; }, 1500); }
});

$('acceptResponsibility').addEventListener('click', async () => {
  const button = $('acceptResponsibility'); const before = button.textContent;
  try { button.disabled = true; button.textContent = 'binding acceptance…'; const result = await api('/api/responsibility/accept', { method:'POST', body:JSON.stringify({}) }); button.textContent = `accepted · ${result.responsibility.responsibilityCoverage}% covered`; await poll(); }
  catch { button.textContent = 'acceptance failed'; }
  finally { setTimeout(() => { button.disabled = false; button.textContent = before; }, 1800); }
});

poll();
setInterval(poll, 1500);
