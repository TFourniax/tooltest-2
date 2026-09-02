import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONCEPTS, CONCEPT_BY_ID } from './catalog.mjs';

function compactText(value, max = 32000) {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > max ? text.slice(0, max) : text;
  } catch {
    return '';
  }
}

export function eventText(event = {}) {
  return [
    event.hook_event_name,
    event.tool_name,
    compactText(event.prompt, 8000),
    compactText(event.tool_input, 16000),
    compactText(event.error, 4000)
  ].filter(Boolean).join('\n');
}

export function detectConcepts(text = '') {
  const matches = [];
  for (const concept of CONCEPTS) {
    if (concept.patterns.some((pattern) => pattern.test(text))) matches.push(concept.id);
  }
  return matches;
}

export function touchedFileFromEvent(event = {}) {
  const input = event.tool_input || {};
  const candidate = input.file_path || input.path || input.notebook_path;
  return typeof candidate === 'string' ? candidate : null;
}

export function estimateWindow(event = {}) {
  const name = event.hook_event_name;
  const tool = event.tool_name || '';
  const command = event.tool_input?.command || '';
  if (name === 'Stop' || name === 'SessionEnd') return 0;
  if (tool === 'Bash') {
    if (/npm\s+test|pnpm\s+test|pytest|vitest|jest|playwright|cypress/i.test(command)) return 55;
    if (/build|compile|docker\s+build/i.test(command)) return 70;
    if (/npm\s+(install|i)|pnpm\s+install|yarn\s+install|pip\s+install/i.test(command)) return 48;
    if (/deploy|migration|migrate/i.test(command)) return 60;
    return 28;
  }
  if (/Write|Edit|MultiEdit|apply_patch/.test(tool)) return 24;
  if (/Read|Grep|Glob/.test(tool)) return 18;
  if (name === 'UserPromptSubmit') return 32;
  return 22;
}

function isTimeoutError(error) {
  return error?.code === 'ETIMEDOUT' || Boolean(error?.signal) || /timed out|timeout/i.test(String(error?.message || ''));
}

function git(cwd, args, maxBuffer = 1024 * 1024) {
  const run = (timeout) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer,
    windowsHide: true
  });
  try {
    return run(5000);
  } catch (error) {
    // Missing Git / not-a-repository are normal in standalone IdleProof mode. A timeout inside a
    // valid project is different: silently converting it to an empty string previously fabricated
    // "no HEAD/no diff" receipts on loaded Windows runners. Retry once with a wider window, then
    // surface a bounded failure rather than inventing evidence.
    if (!isTimeoutError(error)) return '';
    try {
      return run(15000);
    } catch (retryError) {
      if (!isTimeoutError(retryError)) return '';
      const wrapped = new Error(`Git did not complete ${args[0] || 'command'} within the bounded retry window.`);
      wrapped.code = 'IDLEPROOF_GIT_TIMEOUT';
      wrapped.cause = retryError;
      throw wrapped;
    }
  }
}

function isIdleProofInternal(relative) {
  const normalized = String(relative || '').replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized === '.idleproof' ||
    normalized.startsWith('.idleproof/') ||
    normalized === '.claude/settings.local.json' ||
    normalized === '.codex/hooks.json' ||
    normalized === '.cursor/hooks.json' ||
    normalized === '.cursor/rules/idleproof-continuity.mdc';
}

function safeUntrackedPatch(cwd, relative) {
  try {
    const root = path.resolve(cwd);
    const absolute = path.resolve(root, relative);
    if (!(absolute === root || absolute.startsWith(`${root}${path.sep}`))) return '';
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.size > 128000) return '';
    const data = fs.readFileSync(absolute);
    if (data.includes(0)) return '';
    const text = data.toString('utf8');
    const lines = text.split('\n').slice(0, 2500);
    return `diff --git a/${relative} b/${relative}\nnew file mode 100644\n--- /dev/null\n+++ b/${relative}\n${lines.map((line) => `+${line}`).join('\n')}\n`;
  } catch {
    return '';
  }
}

function filterInternalDiff(diff) {
  const chunks = String(diff || '').split(/(?=^diff --git )/m);
  return chunks.filter((chunk) => {
    const match = chunk.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    if (!match) return chunk.trim();
    return !isIdleProofInternal(match[2]);
  }).join('');
}

export function captureGitSnapshot(cwd) {
  const status = git(cwd, ['status', '--short', '--untracked-files=all']);
  const head = git(cwd, ['rev-parse', '--verify', 'HEAD']).trim() || null;
  const trackedDiff = filterInternalDiff(`${git(cwd, ['diff', '--unified=0', '--no-ext-diff'], 4 * 1024 * 1024)}\n${git(cwd, ['diff', '--cached', '--unified=0', '--no-ext-diff'], 4 * 1024 * 1024)}`);
  const numstat = `${git(cwd, ['diff', '--numstat'])}\n${git(cwd, ['diff', '--cached', '--numstat'])}`;
  const files = new Set();
  const untracked = [];
  let added = 0;
  let deleted = 0;

  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    const file = line.slice(3).trim().replace(/^"|"$/g, '');
    if (file && isIdleProofInternal(file)) continue;
    if (file) files.add(file);
    if (line.startsWith('?? ') && file) untracked.push(file);
  }
  for (const line of numstat.split('\n')) {
    const [a, d, file] = line.split('\t');
    if (!file || isIdleProofInternal(file)) continue;
    files.add(file);
    if (/^\d+$/.test(a)) added += Number(a);
    if (/^\d+$/.test(d)) deleted += Number(d);
  }

  const untrackedPatches = [];
  for (const file of untracked.slice(0, 40)) {
    const patch = safeUntrackedPatch(cwd, file);
    if (!patch) continue;
    untrackedPatches.push(patch);
    added += patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  }
  const diff = `${trackedDiff}\n${untrackedPatches.join('\n')}`.slice(0, 220000);
  const diffHash = createHash('sha256').update(diff).digest('hex');
  return { files: [...files].slice(0, 80), added, deleted, diff, diffHash, head };
}

const REVIEW_RULES = [
  {
    id: 'client-secret', severity: 'critical',
    re: /(?:VITE_|NEXT_PUBLIC_|PUBLIC_).{0,40}(?:SECRET|PRIVATE|SERVICE_ROLE|TOKEN)/i,
    title: 'Possible secret exposed to client code',
    message: 'A public/client-prefixed environment variable appears to reference a credential. Browser-delivered code cannot keep secrets.'
  },
  {
    id: 'dangerous-html', severity: 'high',
    re: /dangerouslySetInnerHTML|\.innerHTML\s*=/i,
    title: 'Raw HTML rendering introduced',
    message: 'Confirm the value is sanitized or fully trusted; otherwise this can become an XSS path.'
  },
  {
    id: 'eval', severity: 'high',
    re: /\beval\s*\(|new\s+Function\s*\(/,
    title: 'Dynamic code execution introduced',
    message: 'Dynamic execution expands injection risk and makes behavior harder to reason about. Verify it is unavoidable.'
  },
  {
    id: 'cors-wildcard', severity: 'high',
    re: /Access-Control-Allow-Origin.{0,20}\*|origin\s*:\s*['"]\*['"]/i,
    title: 'Wildcard CORS policy detected',
    message: 'A wildcard origin may expose endpoints more broadly than intended. Verify credentials and origin policy.'
  },
  {
    id: 'sql-interpolation', severity: 'high',
    re: /(?:SELECT|INSERT|UPDATE|DELETE).{0,120}\$\{|(?:SELECT|INSERT|UPDATE|DELETE).{0,120}\+\s*\w+/i,
    title: 'Possible SQL string interpolation',
    message: 'Values should normally be parameterized so user-controlled text cannot become executable SQL.'
  },
  {
    id: 'shell-exec', severity: 'medium',
    re: /child_process|execSync\s*\(|spawn\s*\(/i,
    title: 'Shell/process execution added',
    message: 'Check whether any user-controlled value reaches the command or arguments, and whether the permission is necessary.'
  },
  {
    id: 'auth-change', severity: 'medium',
    re: /auth|session|jwt|oauth|permission|role/i,
    title: 'Authentication/authorization surface changed',
    message: 'Re-test both unauthenticated and authenticated-but-unauthorized cases before trusting the change.'
  },
  {
    id: 'migration-change', severity: 'medium',
    re: /migration|ALTER TABLE|DROP TABLE|DROP COLUMN|CREATE TABLE/i,
    title: 'Schema or migration behavior changed',
    message: 'Verify rollout compatibility, existing data handling, and rollback behavior.'
  },
  {
    id: 'workflow-change', severity: 'medium',
    re: /\.github\/workflows|permissions:\s*\n|secrets\./i,
    title: 'CI/CD execution policy changed',
    message: 'Inspect workflow permissions, secret access, trigger scope, and third-party action pinning.'
  }
];

export function analyzeDiff(diff = '') {
  if (!diff) return [];
  const addedOnly = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  return REVIEW_RULES.filter((rule) => rule.re.test(addedOnly || diff)).map(({ re, ...rule }) => rule);
}

export function conceptsFromGitSnapshot(snapshot) {
  const semanticDiff = String(snapshot.diff || '').split('\n')
    .filter((line) => !/^(diff --git |index |--- |\+\+\+ |@@)/.test(line))
    .join('\n');
  const text = `${snapshot.files.join('\n')}\n${semanticDiff}`;
  return detectConcepts(text);
}

export function rankCard(state, session) {
  const ids = new Set([
    ...Object.keys(session?.concepts || {}),
    ...Object.entries(state.ledger || {}).filter(([, entry]) => entry.exposures > 0).map(([id]) => id)
  ]);
  const scored = [...ids].map((id) => {
    const concept = CONCEPT_BY_ID[id];
    const entry = state.ledger[id];
    if (!concept || !entry) return null;
    const unansweredBoost = entry.lastAnsweredAt ? 0 : 3;
    const sessionBoost = session?.concepts?.[id] ? 4 : 0;
    const recencyPenalty = entry.lastAnsweredAt && (Date.now() - Date.parse(entry.lastAnsweredAt) < 120000) ? 5 : 0;
    return { id, score: concept.risk * Math.max(1, entry.exposures) * (1 - entry.confidence) + unansweredBoost + sessionBoost - recencyPenalty };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  return scored[0]?.id || 'testing';
}

export function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    source: session.source || 'agent',
    status: session.status,
    startedAt: session.startedAt,
    lastEventAt: session.lastEventAt,
    prompt: session.prompt,
    currentTool: session.currentTool,
    estimatedWindow: session.estimatedWindow || 0,
    touchedFiles: session.touchedFiles || [],
    changed: session.changed || { added: 0, deleted: 0 },
    proof: session.proof || null,
    findings: session.findings || [],
    concepts: session.concepts || {},
    events: (session.events || []).slice(-20)
  };
}
