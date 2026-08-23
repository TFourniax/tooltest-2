const root = document.getElementById('memoryReviewChallenge');
const question = document.getElementById('memoryReviewQuestion');
const answers = document.getElementById('memoryReviewAnswers');
const feedback = document.getElementById('memoryReviewFeedback');

let activeChallengeId = null;
let locked = false;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#039;', '"':'&quot;' }[ch]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch {}
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
}

function hide() {
  root.className = 'challenge memory-review-challenge hidden';
  root.dataset.featureKey = '';
  root.dataset.challengeId = '';
  question.textContent = '';
  answers.innerHTML = '';
  if (!locked) feedback.textContent = '';
  activeChallengeId = null;
}

function renderChallenge(challenge) {
  if (!challenge) return hide();
  const changed = challenge.challengeId !== activeChallengeId;
  activeChallengeId = challenge.challengeId;
  root.className = `challenge memory-review-challenge ${challenge.kind === 'drift-recall' ? 'drift-review' : ''}`;
  root.dataset.featureKey = challenge.featureKey;
  root.dataset.challengeId = challenge.challengeId;
  question.textContent = challenge.question;
  answers.innerHTML = (challenge.options || []).map((option, index) => `<button class="answer memory-review-answer" data-choice="${index}">${escapeHtml(option)}</button>`).join('');
  document.querySelectorAll('.memory-review-answer').forEach((button) => button.addEventListener('click', () => submit(challenge, Number(button.dataset.choice))));
  if (changed && !locked) feedback.textContent = challenge.kind === 'drift-recall'
    ? 'This feature changed after you learned it. Revalidate only the new boundary.'
    : 'A short retrieval check keeps this feature in your working mental model.';
}

async function submit(challenge, choice) {
  if (locked) return;
  locked = true;
  const buttons = [...document.querySelectorAll('.memory-review-answer')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api('/api/feature-review-answer', {
      method: 'POST',
      body: JSON.stringify({ featureKey: challenge.featureKey, challengeId: challenge.challengeId, choice })
    });
    buttons.forEach((button, index) => {
      if (index === result.answer) button.classList.add('correct');
      else if (index === choice) button.classList.add('wrong');
    });
    feedback.textContent = `${result.correct ? 'Correct.' : 'Not quite.'} ${result.explanation}`;
    setTimeout(() => {
      locked = false;
      renderChallenge(result.state?.projectModel?.reviewChallenge || null);
    }, 1800);
  } catch (error) {
    locked = false;
    feedback.textContent = `Could not record feature recall: ${error.message}`;
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function poll() {
  if (locked) return;
  try {
    const state = await api('/api/state');
    renderChallenge(state.projectModel?.reviewChallenge || null);
  } catch {
    // The main cockpit owns the global offline state; this module stays silent.
  }
}

// Explain-first UX: a user should receive the explanation without being forced into a quiz.
// The main app keeps the check up to date; this layer only decides whether it is visible.
function installOptionalLiveCheck() {
  const learningCard = document.getElementById('learningCard');
  const liveQuestion = document.getElementById('question');
  const liveChallenge = liveQuestion?.closest('.challenge');
  const lesson = document.getElementById('cardLesson');
  if (!learningCard || !liveQuestion || !liveChallenge || !lesson) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'text-button';
  button.id = 'revealUnderstandingCheck';
  button.textContent = 'check my understanding · optional';
  lesson.insertAdjacentElement('afterend', button);

  let key = '';
  let revealed = false;
  const sync = () => {
    const nextKey = liveQuestion.textContent.trim();
    if (nextKey !== key) { key = nextKey; revealed = false; }
    const available = Boolean(nextKey && document.querySelector('#answers .answer'));
    liveChallenge.hidden = available && !revealed;
    button.hidden = !available || revealed;
  };
  button.addEventListener('click', () => { revealed = true; sync(); liveQuestion.focus?.(); });
  new MutationObserver(sync).observe(liveChallenge, { childList:true, subtree:true, characterData:true });
  sync();
}

function installOptionalFeatureCheck() {
  const challenge = document.getElementById('featureChallenge');
  const question = document.getElementById('featureQuestion');
  const anchor = document.getElementById('featureDisclaimer');
  if (!challenge || !question || !anchor) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'text-button';
  button.textContent = 'check this feature map · optional';
  anchor.insertAdjacentElement('afterend', button);
  let key=''; let revealed=false;
  const sync=()=>{
    const nextKey=question.textContent.trim();
    if (nextKey!==key) { key=nextKey; revealed=false; }
    const available=Boolean(nextKey && document.querySelector('.feature-answer'));
    challenge.hidden=available && !revealed;
    button.hidden=!available || revealed;
  };
  button.addEventListener('click',()=>{ revealed=true; sync(); });
  new MutationObserver(sync).observe(challenge,{childList:true,subtree:true,characterData:true});
  sync();
}

function applyLocalEditionUi() {
  document.body.dataset.edition='local';
  document.querySelector('#learningCard .mini-label')?.replaceChildren(document.createTextNode('LIVE PROJECT EXPLANATION'));
  const liveKicker=document.querySelector('#learningCard .challenge-kicker'); if (liveKicker) liveKicker.textContent='OPTIONAL · CHECK YOUR UNDERSTANDING';
  const evidenceKicker=document.querySelector('.evidence .mini-label'); if (evidenceKicker) evidenceKicker.textContent='LOCAL · SOURCE STAYS ON THIS MACHINE';
  const footerFirst=document.querySelector('footer span'); if (footerFirst) footerFirst.textContent='IdleProof Local · understand what your coding agent is building';

  // Local is the immediate product: explain the current task and current feature map.
  // Longitudinal memory, Knowledge Debt history, project history and spaced recall belong to Portal.
  document.querySelector('.feature-memory-panel')?.setAttribute('hidden','');
  document.querySelector('.project-intel-grid')?.setAttribute('hidden','');
  document.querySelector('.ledger-panel')?.setAttribute('hidden','');
  document.getElementById('featureFluency')?.closest('.metric')?.setAttribute('hidden','');
  document.getElementById('debt')?.closest('.metric')?.setAttribute('hidden','');
  document.getElementById('coverage')?.closest('.metric')?.setAttribute('hidden','');

  const grid=document.querySelector('.feature-grid');
  if (grid && !document.getElementById('portalBoundary')) {
    const card=document.createElement('article');
    card.id='portalBoundary';
    card.className='panel';
    card.innerHTML='<div class="section-head"><div><span class="mini-label">IDLEPROOF PORTAL · PRO</span><h2>Understand now. Remember later.</h2></div><span class="chip">long-term</span></div><p class="memory-intro">IdleProof Local explains the task in front of you. Portal adds persistent project history, Knowledge Debt over time, feature drift, spaced recall, multi-project visibility and proof/debt history — without requiring source code to leave this machine.</p>';
    grid.appendChild(card);
  }
}

applyLocalEditionUi();
installOptionalLiveCheck();
installOptionalFeatureCheck();
// Longitudinal spaced-recall polling is intentionally not part of the Local cockpit.
