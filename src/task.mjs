import { createHash } from 'node:crypto';

const MAX_ANCHOR_CHARS = 1200;
const MAX_FOCUS_CHARS = 1200;
const MAX_HISTORY = 12;

const WEAK_FOLLOWUP = /^(?:yes|yep|yeah|ok(?:ay)?|sure|go(?: ahead)?|continue|keep going|do it|proceed|retry|try again|fix it|fix that|same|exactly|great|thanks?|oui|ok|d['’]?accord|vas[- ]?y|continue|continues?|poursuis|fais[- ]?le|refais|réessaie|essaie encore|corrige(?: ça| cela)?|parfait|merci)[.!…\s]*$/iu;
const EXPLICIT_PIVOT = /^(?:new task|next task|different task|switch (?:to|topic)|now (?:work|let['’]?s work) on|move on to|instead[, :]|separate task|nouvelle tâche|tâche suivante|autre tâche|changeons de (?:tâche|sujet)|passons à|maintenant (?:travaille|travaillons) sur|autre sujet|à la place[, :])/iu;

function sha256(value = '') {
  return createHash('sha256').update(String(value)).digest('hex');
}

function compact(value = '', max = MAX_FOCUS_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function nowIso(now = null) {
  if (typeof now === 'string' && now) return now;
  if (now instanceof Date) return now.toISOString();
  return new Date().toISOString();
}

export function isWeakFollowup(prompt = '') {
  const text = compact(prompt, 320);
  if (!text) return true;
  if (WEAK_FOLLOWUP.test(text)) return true;
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
  return tokens.length <= 3 && text.length <= 36 && !/[\/.]/.test(text);
}

export function isExplicitTaskPivot(prompt = '') {
  return EXPLICIT_PIVOT.test(compact(prompt, 500));
}

export function stableTaskId(sessionId, ordinal, anchorPrompt) {
  const session = String(sessionId || 'default');
  const position = Number.isInteger(ordinal) && ordinal > 0 ? ordinal : 1;
  const anchorDigest = sha256(String(anchorPrompt || ''));
  return `dwtask_${sha256(`task-v1\0${session}\0${position}\0${anchorDigest}`).slice(0, 24)}`;
}

function snapshotTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    ordinal: task.ordinal,
    anchor: task.anchor,
    anchorChars: task.anchorChars,
    anchorSha256: task.anchorSha256,
    latestFocus: task.latestFocus,
    latestFocusChars: task.latestFocusChars,
    latestFocusSha256: task.latestFocusSha256,
    prompts: task.prompts,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt || null
  };
}

function startTask(session, sessionId, rawPrompt, timestamp) {
  const anchor = compact(rawPrompt, MAX_ANCHOR_CHARS);
  const ordinal = Math.max(1, Number(session.task?.ordinal || 0) + 1);
  const task = {
    id: stableTaskId(sessionId, ordinal, rawPrompt),
    ordinal,
    anchor,
    anchorChars: String(rawPrompt || '').length,
    anchorSha256: sha256(rawPrompt),
    latestFocus: anchor,
    latestFocusChars: String(rawPrompt || '').length,
    latestFocusSha256: sha256(rawPrompt),
    prompts: 1,
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: null
  };
  session.task = task;
  return { task, boundary: ordinal === 1 ? 'started' : 'pivoted', weakFollowup: false };
}

export function updateSessionTask(session, rawPrompt, { sessionId = null, now = null } = {}) {
  if (!session || typeof session !== 'object') throw new Error('IdleProof task tracking requires a session object.');
  const prompt = String(rawPrompt || '');
  const text = compact(prompt, MAX_FOCUS_CHARS);
  const timestamp = nowIso(now);
  const id = String(sessionId || session.id || 'default');
  if (!text) return { task: session.task || null, boundary: 'none', weakFollowup: true };

  if (!session.task) return startTask(session, id, prompt, timestamp);

  if (isExplicitTaskPivot(text)) {
    session.task.completedAt = timestamp;
    session.taskHistory ||= [];
    session.taskHistory.push(snapshotTask(session.task));
    session.taskHistory = session.taskHistory.slice(-MAX_HISTORY);
    return startTask(session, id, prompt, timestamp);
  }

  const weak = isWeakFollowup(text);
  session.task.prompts = Math.max(1, Number(session.task.prompts || 1)) + 1;
  session.task.updatedAt = timestamp;
  session.task.latestFocusChars = prompt.length;
  session.task.latestFocusSha256 = sha256(prompt);
  if (!weak) session.task.latestFocus = text;
  return { task: session.task, boundary: weak ? 'continued' : 'focused', weakFollowup: weak };
}

export function taskContextQuery(session = {}) {
  const task = session.task;
  if (!task) return compact(session.prompt || '', MAX_ANCHOR_CHARS);
  const anchor = compact(task.anchor || '', MAX_ANCHOR_CHARS);
  const focus = compact(task.latestFocus || '', MAX_FOCUS_CHARS);
  if (!focus || focus === anchor) return anchor;
  return `Primary task: ${anchor}\nCurrent focus: ${focus}`;
}

export function taskDisplayText(session = {}) {
  return compact(session.task?.anchor || session.prompt || '', 220);
}

export function taskMetadata(session = {}) {
  const task = session.task;
  if (!task) return null;
  return {
    id: task.id,
    ordinal: task.ordinal,
    prompts: task.prompts,
    anchorChars: task.anchorChars,
    anchorDigest: task.anchorSha256 ? `sha256:${task.anchorSha256}` : null,
    latestFocusChars: task.latestFocusChars,
    latestFocusDigest: task.latestFocusSha256 ? `sha256:${task.latestFocusSha256}` : null,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt || null
  };
}

export const __taskTest = { MAX_ANCHOR_CHARS, MAX_FOCUS_CHARS, MAX_HISTORY, compact, sha256 };
