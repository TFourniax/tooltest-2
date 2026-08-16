import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectPaths } from './paths.mjs';
import { classifyCapabilities } from './capabilities.mjs';

export const POLICY_SCHEMA = 'idleproof.policy.v1';
const EFFECT_WEIGHT = { allow: 0, observe: 1, ask: 2, deny: 3 };

const BUILTIN_RULES = [
  { id: 'catastrophic-delete', severity: 'critical', effect: 'deny', match: { capability: '^filesystem\\.catastrophic_delete$' }, message: 'Catastrophic recursive deletion is blocked.' },
  { id: 'remote-script-exec', severity: 'critical', effect: 'deny', match: { capability: '^shell\\.remote_exec$' }, message: 'Piping an unverified remote response directly into a shell is blocked.' },
  { id: 'force-push', severity: 'high', effect: 'ask', match: { capability: '^scm\\.history_rewrite$' }, message: 'Force-push can rewrite shared history.' },
  { id: 'destructive-git-reset', severity: 'high', effect: 'ask', match: { capability: '^scm\\.local_destroy$' }, message: 'This Git command can irreversibly discard local work.' },
  { id: 'destructive-database', severity: 'critical', effect: 'ask', match: { capability: '^database\\.destructive$' }, message: 'Potentially destructive database operation requires explicit human review.' },
  { id: 'production-deploy', severity: 'high', effect: 'ask', match: { capability: '^deploy\\.production$' }, message: 'Production deployment requires explicit review.' },
  { id: 'secret-file-write', severity: 'high', effect: 'ask', match: { capability: '^secrets\\.write$' }, message: 'Writing a credential-bearing file is high risk.' },
  { id: 'workflow-write', severity: 'high', effect: 'observe', match: { capability: '^ci\\.modify$' }, message: 'CI/CD policy changed; verify permissions, triggers, and secret access.' },
  { id: 'migration-write', severity: 'high', effect: 'observe', match: { capability: '^database\\.migration$' }, message: 'Database migration changed; verify rollout and rollback compatibility.' },
  { id: 'mcp-tool-call', severity: 'medium', effect: 'observe', match: { capability: '^mcp\\.invoke$' }, message: 'External MCP tool call observed.' },
  { id: 'dependency-install', severity: 'medium', effect: 'observe', match: { capability: '^dependency\\.install$' }, message: 'Dependency surface changed.' }
];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`Cannot parse ${file}: ${error.message}`); }
}
function writeJson(file, value, mode = 0o600) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode }); }
function normalizePath(cwd, candidate) {
  if (typeof candidate !== 'string' || !candidate) return '';
  const normalized = candidate.replaceAll('\\', '/');
  const root = path.resolve(cwd).replaceAll('\\', '/');
  const absolute = path.resolve(cwd, candidate).replaceAll('\\', '/');
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : normalized;
}
function extractApplyPatchPath(command = '') { const match = String(command || '').match(/(?:\*\*\* (?:Update|Add|Delete) File:|\+\+\+ b\/|--- a\/)([^\r\n]+)/); return match?.[1]?.trim() || ''; }

export function normalizeAction(event = {}, cwd = event.cwd || process.cwd()) {
  const input = event.tool_input || {};
  const command = typeof input.command === 'string' ? input.command.trim().replace(/\s+/g, ' ') : '';
  const candidatePath = input.file_path || input.path || input.notebook_path || extractApplyPatchPath(input.command);
  const action = { event: event.hook_event_name || event.type || 'event', source: event.source || 'agent', sessionId: event.session_id || null, turnId: event.turn_id || null, toolUseId: event.tool_use_id || null, tool: event.tool_name || '', command, path: normalizePath(cwd, candidatePath), permissionMode: event.permission_mode || null };
  action.capabilities = classifyCapabilities(action);
  return action;
}
function fingerprintAction(action) { return createHash('sha256').update(JSON.stringify({ source: action.source, tool: action.tool, command: action.command, path: action.path, capabilities: action.capabilities || [] })).digest('hex').slice(0, 16); }
function matchesValue(value, pattern, exact = false) { if (!pattern) return true; if (exact) return String(value || '') === String(pattern); try { return new RegExp(pattern, 'i').test(String(value || '')); } catch { return false; } }
function ruleMatches(rule, action) {
  const match = rule.match || {};
  return matchesValue(action.event, match.event) && matchesValue(action.source, match.source) && matchesValue(action.tool, match.tool, match.tool && !/[\\^$.*+?()[\]{}|]/.test(match.tool)) && matchesValue(action.command, match.command) && matchesValue(action.path, match.path) && (!match.capability || (action.capabilities || []).some((capability) => matchesValue(capability, match.capability)));
}
function profileEffect(profile, rule) { const effect = rule.effect || 'observe'; if (profile === 'observe') return 'observe'; if (profile !== 'strict') return effect; if (effect === 'observe' && ['high', 'critical'].includes(rule.severity)) return 'ask'; if (effect === 'ask' && rule.severity === 'critical') return 'deny'; return effect; }
function riskScore(action, matches) {
  let score = action.tool === 'Bash' ? 14 : /^mcp__/.test(action.tool) ? 18 : /Write|Edit|apply_patch|NotebookEdit/.test(action.tool) ? 12 : 4;
  const severity = { low: 5, medium: 12, high: 25, critical: 45 };
  for (const item of matches) score += severity[item.severity] || 0;
  if (/prod|production/i.test(action.command)) score += 10;
  if (/secret|token|credential|\.env/i.test(`${action.command}\n${action.path}`)) score += 10;
  if ((action.capabilities || []).some((capability) => /destructive|history_rewrite|production|catastrophic/.test(capability))) score += 10;
  return Math.min(100, score);
}
function activeApproval(cwd, fingerprint, { consume = false } = {}) {
  const file = projectPaths(cwd).approvals; const approvals = readJson(file, { schema: 'idleproof.approvals.v1', grants: {} }); const grant = approvals.grants?.[fingerprint];
  if (!grant) return null;
  if (Date.parse(grant.expiresAt || '') <= Date.now() || (grant.remainingUses ?? 0) <= 0) { delete approvals.grants[fingerprint]; writeJson(file, approvals); return null; }
  if (consume) { grant.remainingUses -= 1; if (grant.remainingUses <= 0) delete approvals.grants[fingerprint]; writeJson(file, approvals); }
  return grant;
}
export function loadPolicy(cwd = process.cwd()) {
  const policy = readJson(projectPaths(cwd).policy, null);
  if (!policy) return { schema: POLICY_SCHEMA, profile: 'balanced', rules: [], source: 'builtin' };
  if (policy.schema !== POLICY_SCHEMA) throw new Error(`Unsupported policy schema: ${policy.schema || 'missing'}`);
  const profile = ['observe', 'balanced', 'strict'].includes(policy.profile) ? policy.profile : 'balanced';
  return { ...policy, profile, rules: Array.isArray(policy.rules) ? policy.rules : [], source: 'project' };
}
export function initPolicy(cwd = process.cwd(), profile = 'balanced', { force = false } = {}) {
  if (!['observe', 'balanced', 'strict'].includes(profile)) throw new Error('Policy profile must be observe, balanced, or strict.');
  const file = projectPaths(cwd).policy;
  if (fs.existsSync(file) && !force) throw new Error(`${path.basename(file)} already exists. Use --force to replace it.`);
  const policy = { schema: POLICY_SCHEMA, profile, description: 'Runtime policy for AI coding agents. Project rules are evaluated together with IdleProof built-ins; deny wins.', rules: [
    { id: 'example-protected-path', enabled: false, severity: 'high', effect: 'ask', match: { path: '^(?:src/)?(?:auth|billing|permissions)/' }, message: 'Example: require review before modifying a protected domain.' },
    { id: 'example-no-production-deploy', enabled: false, severity: 'critical', effect: 'deny', match: { capability: '^deploy\\.production$' }, message: 'Example: agents may not deploy directly to production.' }
  ] };
  writeJson(file, policy, 0o644); return file;
}
function policyRules(policy) { return [...(policy.rules || []).filter((rule) => rule && rule.enabled !== false).map((rule) => ({ ...rule, origin: 'project' })), ...BUILTIN_RULES.map((rule) => ({ ...rule, origin: 'builtin' }))]; }
export function evaluateNormalizedAction(action, { cwd = process.cwd(), consumeApproval = false, policyOverride = null, allowApprovals = true } = {}) {
  const policy = policyOverride || loadPolicy(cwd); const normalized = { ...action, capabilities: action.capabilities || classifyCapabilities(action) }; const fingerprint = fingerprintAction(normalized);
  const matched = policyRules(policy).filter((rule) => ruleMatches(rule, normalized)).map((rule) => ({ ...rule, effectiveEffect: profileEffect(policy.profile, rule) }));
  const approved = allowApprovals ? activeApproval(cwd, fingerprint, { consume: consumeApproval }) : null;
  const strongest = [...matched].sort((a, b) => (EFFECT_WEIGHT[b.effectiveEffect] || 0) - (EFFECT_WEIGHT[a.effectiveEffect] || 0))[0];
  let decision = strongest?.effectiveEffect || 'allow'; if (approved && ['ask', 'deny'].includes(decision)) decision = 'allow';
  const risk = riskScore(normalized, matched); const reason = approved ? `Approved locally until ${approved.expiresAt}.` : strongest?.message || (risk >= 60 ? 'High-risk agent action observed.' : 'No blocking policy matched.');
  return { schema: 'idleproof.policy-decision.v1', profile: policy.profile, policySource: policy.source, decision, originalDecision: strongest?.effectiveEffect || 'allow', approved: Boolean(approved), approvalFingerprint: fingerprint, risk, reason, action: normalized, matches: matched.map((rule) => ({ id: rule.id, origin: rule.origin, severity: rule.severity || 'medium', effect: rule.effectiveEffect, message: rule.message || '' })) };
}
export function evaluatePolicy(event = {}, { cwd = event.cwd || process.cwd(), consumeApproval = false } = {}) { return evaluateNormalizedAction(normalizeAction(event, cwd), { cwd, consumeApproval }); }
export function grantApproval(cwd = process.cwd(), fingerprint, { minutes = 10, uses = 1, note = '' } = {}) {
  if (!/^[a-f0-9]{16}$/.test(String(fingerprint || ''))) throw new Error('Approval fingerprint must be a 16-character hex id from a blocked action.');
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw new Error('Approval duration must be between 1 and 1440 minutes.');
  if (!Number.isInteger(uses) || uses < 1 || uses > 100) throw new Error('Approval uses must be between 1 and 100.');
  const file = projectPaths(cwd).approvals; const approvals = readJson(file, { schema: 'idleproof.approvals.v1', grants: {} }); approvals.grants ||= {};
  approvals.grants[fingerprint] = { grantedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + minutes * 60000).toISOString(), remainingUses: uses, note: String(note || '').slice(0, 500) }; writeJson(file, approvals); return approvals.grants[fingerprint];
}
export function policyDecisionOutput(event, result) {
  if ((event.hook_event_name || event.type) !== 'PreToolUse') return null;
  if (result.decision === 'deny') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${result.reason} IdleProof approval id: ${result.approvalFingerprint}` } };
  if (result.decision === 'ask') {
    if ((event.source || '') === 'codex') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${result.reason} Codex does not support hook-level ask yet. Review then run: idleproof approve ${result.approvalFingerprint}` } };
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: result.reason } };
  }
  return null;
}
export function effectivePolicyMaterial(cwd = process.cwd()) { const policy = loadPolicy(cwd); return { schema: POLICY_SCHEMA, engineVersion: 2, profile: policy.profile, projectRules: Array.isArray(policy.rules) ? policy.rules : [], builtinRules: BUILTIN_RULES }; }
export function policyHash(cwd = process.cwd()) { return createHash('sha256').update(JSON.stringify(effectivePolicyMaterial(cwd))).digest('hex'); }
export function builtinPolicyRules() { return BUILTIN_RULES.map((rule) => JSON.parse(JSON.stringify(rule))); }
