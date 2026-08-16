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

poll();
setInterval(poll, 5000);
