let lastState = null;
let feedbackLock = null;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[ch]));

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
    ? files.slice(-9).reverse().map((file) => `<div class="file-row"><span>${escapeHtml(file)}</span><span>touched</span></div>`).join('')
    : '<p class="empty">No files observed yet.</p>';
  const changed = session?.changed || { added: 0, deleted: 0 };
  $('linesChanged').textContent = `+${changed.added || 0} −${changed.deleted || 0}`;
}

function renderFindings(session) {
  const findings = session?.findings || [];
  $('findingCount').textContent = findings.length;
  $('findings').innerHTML = findings.length
    ? findings.slice(0, 6).map((f) => `<div class="finding ${escapeHtml(f.severity)}"><strong>${escapeHtml(f.title)}</strong><p>${escapeHtml(f.message)}</p></div>`).join('')
    : `<p class="empty">${session?.status === 'complete' ? 'No deterministic high-signal rule fired on the current diff.' : 'Diff checks appear when the agent finishes a turn.'}</p>`;
}

function renderLedger(ledger) {
  const rows = Object.values(ledger || {}).sort((a,b) => (b.risk * b.exposures * (100-b.confidence)) - (a.risk * a.exposures * (100-a.confidence)));
  $('ledger').innerHTML = rows.length
    ? rows.slice(0,7).map((entry) => `<div class="ledger-row"><span class="ledger-title">${escapeHtml(entry.title)}</span><span class="ledger-risk">×${entry.exposures} · r${entry.risk}</span><span class="ledger-meter" title="${entry.confidence}% confidence"><i style="width:${entry.confidence}%"></i></span></div>`).join('')
    : '<p class="empty">Your ledger is empty. Start an agent task to create the first cognitive trace.</p>';
}

function renderCard(state) {
  const card = state.card;
  const handoff = state.session?.status === 'complete';
  $('cardRisk').textContent = riskLabel(card);
  $('cardTime').textContent = `≈ ${Math.min(card.seconds || 30, Math.max(12, state.session?.estimatedWindow || card.seconds || 30))} sec`;
  $('cardTitle').textContent = card.title;
  const reviewMode = handoff || state.preferences.mode === 'review';
  $('cardRisk').textContent = handoff ? 'HANDOFF' : riskLabel(card);
  $('cardWhy').textContent = reviewMode ? `Review target: ${card.review}` : card.why;
  $('cardLesson').textContent = reviewMode ? `You have ${card.confidence}% verified confidence in this concept after ${card.exposures} exposure${card.exposures === 1 ? '' : 's'}. Inspect the risky boundary; do not reread the whole diff.` : card.lesson;
  $('question').textContent = card.question;
  if (!feedbackLock || feedbackLock !== card.id) $('feedback').textContent = '';
  $('answers').innerHTML = card.options.map((option, index) => `<button class="answer" data-choice="${index}">${escapeHtml(option)}</button>`).join('');
  document.querySelectorAll('.answer').forEach((button) => button.addEventListener('click', () => submitAnswer(card.id, Number(button.dataset.choice))));
}

function render(state) {
  lastState = state;
  $('project').textContent = state.project;
  $('debt').textContent = state.metrics.debt;
  $('coverage').textContent = `${state.metrics.coverage}%`;
  $('coverageBar').style.width = `${state.metrics.coverage}%`;
  $('scoreHint').textContent = state.metrics.debt === 0
    ? 'Nothing to repay yet. Debt appears when agents introduce concepts you have not verified.'
    : `${state.metrics.conceptsSeen} concept${state.metrics.conceptsSeen === 1 ? '' : 's'} now sit between “the agent changed it” and “you can confidently own it.”`;

  const session = state.session;
  const active = session?.status === 'active';
  const complete = session?.status === 'complete';
  document.body.classList.toggle('completed', complete);
  $('statusDot').classList.toggle('active', active);
  const agentName = session?.source === 'codex' ? 'Codex' : session?.source === 'claude' ? 'Claude Code' : 'Agent';
  $('status').textContent = active ? `${agentName} working · learning window open` : complete ? `${agentName} turn complete · handoff ready` : 'Waiting for an agent';
  $('window').textContent = active ? `≈ ${session.estimatedWindow || 20} sec window` : complete ? 'window closed' : '0 sec window';
  $('currentTool').textContent = session?.currentTool || (complete ? 'Review the handoff' : 'No active tool');
  $('headline').innerHTML = active
    ? 'Don’t watch the spinner.<br><em>Repay knowledge debt.</em>'
    : complete
      ? 'The code moved.<br><em>Make sure your model did too.</em>'
      : 'Your agent writes.<br><em>You keep the mental model.</em>';
  $('task').textContent = session?.prompt || 'Run `idleproof on`, then use Claude Code normally. This surface adapts to what the agent actually touches.';

  renderCard(state);
  renderFiles(session);
  renderFindings(session);
  const proofHash = session?.proof?.diffSha256;
  $('proofId').textContent = proofHash ? `sha256:${proofHash.slice(0, 16)}…` : 'waiting for completed diff';
  $('copyProof').disabled = !proofHash;
  renderLedger(state.ledger);
  document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === state.preferences.mode));
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
    lastState = result.state;
    setTimeout(() => { feedbackLock = null; render(result.state); }, 1800);
  } catch (error) {
    $('feedback').textContent = `Could not record answer: ${error.message}`;
  }
}

async function poll() {
  try {
    const state = await api('/api/state');
    if (!feedbackLock) render(state);
  } catch (error) {
    $('status').textContent = 'Dashboard disconnected';
  }
}

document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', async () => {
  const state = await api('/api/preferences', { method:'POST', body:JSON.stringify({ mode:button.dataset.mode }) });
  render(state);
}));

poll();
setInterval(poll, 900);

document.getElementById('copyProof').addEventListener('click', async () => {
  try {
    const receipt = await api('/api/receipt');
    await navigator.clipboard.writeText(JSON.stringify(receipt, null, 2));
    const button = document.getElementById('copyProof');
    const before = button.textContent;
    button.textContent = 'copied';
    setTimeout(() => { button.textContent = before; }, 1200);
  } catch {
    document.getElementById('copyProof').textContent = 'copy failed';
  }
});
