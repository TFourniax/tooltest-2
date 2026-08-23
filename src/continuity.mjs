import { execFileSync } from 'node:child_process';

const CONTEXT_TIMEOUT_MS = 1500;
const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_ADDITIONAL_CHARS = 6500;

function list(value) {
  return Array.isArray(value) ? value : [];
}

function validContext(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.schema_version === 'continuity-context-1' &&
    /^dwctx_[a-f0-9]{24}$/.test(String(value.context_id || ''))
  );
}

export function loadContinuityContext(cwd, taskQuery, { timeoutMs = CONTEXT_TIMEOUT_MS } = {}) {
  const task = String(taskQuery || '').trim();
  if (!task) return null;
  try {
    const raw = execFileSync(
      'dw',
      ['context', task, '--json', '--max-items', '8', '--no-refresh-structure'],
      {
        cwd,
        encoding: 'utf8',
        timeout: Math.max(250, Math.min(Number(timeoutMs) || CONTEXT_TIMEOUT_MS, 5000)),
        maxBuffer: MAX_CONTEXT_BYTES,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }
    );
    const parsed = JSON.parse(raw);
    return validContext(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function itemLine(item, fallbackKind) {
  const id = String(item?.id || '').slice(0, 96);
  const status = String(item?.epistemicStatus || item?.epistemic_status || 'UNKNOWN').slice(0, 16);
  const label = String(item?.label || item?.title || fallbackKind || '').replace(/\s+/g, ' ').trim().slice(0, 320);
  return `${id ? `${id} ` : ''}[${status}] ${label}`.trim();
}

export function renderContinuityForAgent(context, { maxChars = MAX_ADDITIONAL_CHARS } = {}) {
  if (!validContext(context)) return '';
  const sections = [];
  const add = (title, items, fallbackKind) => {
    const values = list(items).slice(0, 8);
    if (!values.length) return;
    sections.push(title, ...values.map((item) => `- ${itemLine(item, fallbackKind)}`), '');
  };
  sections.push(
    `PROJECT CONTINUITY ${context.context_id}`,
    'Advisory local project memory. Preserve epistemic labels: DECLARED < INFERRED < OBSERVED < VERIFIED. Only executed DiffWitness evidence can establish VERIFIED claims.',
    ''
  );
  add('OBJECTIVES', context.objectives, 'objective');
  add('DECISIONS', context.decisions, 'decision');
  add('INVARIANTS', context.invariants, 'invariant');
  add('KNOWN SOFTWARE DEBT', context.knownDebt, 'debt');
  add('FAILED APPROACHES', context.failedApproaches, 'failed approach');
  if (list(context.components).length) {
    sections.push('RELEVANT COMPONENTS');
    for (const item of list(context.components).slice(0, 8)) {
      sections.push(`- [${String(item?.epistemicStatus || 'UNKNOWN').slice(0, 16)}] ${String(item?.path || '').slice(0, 320)}`);
    }
    sections.push('');
  }
  const text = sections.join('\n').trim();
  return text.slice(0, Math.max(500, Math.min(Number(maxChars) || MAX_ADDITIONAL_CHARS, MAX_ADDITIONAL_CHARS)));
}

export function continuityCounts(context) {
  if (!validContext(context)) return null;
  return {
    contextId: context.context_id,
    objectives: list(context.objectives).length,
    decisions: list(context.decisions).length,
    invariants: list(context.invariants).length,
    criticalInvariants: list(context.invariants).filter((item) => item?.details?.critical === true).length,
    debt: list(context.knownDebt).length,
    failedApproaches: list(context.failedApproaches).length,
    components: list(context.components).length
  };
}

export const __continuityTest = { validContext, CONTEXT_TIMEOUT_MS, MAX_ADDITIONAL_CHARS };
