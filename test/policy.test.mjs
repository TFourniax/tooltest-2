import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluatePolicy, grantApproval, initPolicy, loadPolicy, policyDecisionOutput } from '../src/policy.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-policy-')); }
function bash(cwd, command, source = 'claude') { return { cwd, source, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 's1' }; }

test('balanced policy blocks catastrophic delete', () => {
  const cwd = tmp(); const result = evaluatePolicy(bash(cwd, 'sudo rm -rf /'));
  assert.equal(result.decision, 'deny'); assert.equal(result.matches[0].id, 'catastrophic-delete'); assert.ok(result.risk >= 50);
  const output = policyDecisionOutput(bash(cwd, 'sudo rm -rf /'), result); assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});

test('balanced policy requires review for force push and emits ask for Claude', () => {
  const cwd = tmp(); const event = bash(cwd, 'git push origin main --force-with-lease', 'claude'); const result = evaluatePolicy(event);
  assert.equal(result.decision, 'ask'); const output = policyDecisionOutput(event, result); assert.equal(output.hookSpecificOutput.permissionDecision, 'ask');
});

test('Codex ask is fail-closed and can be granted once', () => {
  const cwd = tmp(); const event = bash(cwd, 'git push --force origin main', 'codex'); const first = evaluatePolicy(event);
  assert.equal(first.decision, 'ask'); const output = policyDecisionOutput(event, first); assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  grantApproval(cwd, first.approvalFingerprint, { minutes: 5, uses: 1 });
  const allowed = evaluatePolicy(event, { cwd, consumeApproval: true }); assert.equal(allowed.decision, 'allow'); assert.equal(allowed.approved, true);
  const again = evaluatePolicy(event, { cwd, consumeApproval: true }); assert.equal(again.decision, 'ask');
});

test('strict profile escalates critical ask to deny', () => {
  const cwd = tmp(); initPolicy(cwd, 'strict'); assert.equal(loadPolicy(cwd).profile, 'strict');
  const result = evaluatePolicy(bash(cwd, 'psql app -c "DROP TABLE users"')); assert.equal(result.decision, 'deny');
});

test('project rule can protect a sensitive path', () => {
  const cwd = tmp(); initPolicy(cwd, 'balanced'); const file = path.join(cwd, 'idleproof.policy.json'); const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  policy.rules[0].enabled = true; fs.writeFileSync(file, JSON.stringify(policy));
  const result = evaluatePolicy({ cwd, source: 'claude', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'auth/session.ts') } });
  assert.equal(result.decision, 'ask'); assert.ok(result.matches.some((match) => match.id === 'example-protected-path'));
});

test('effective policy hash changes with project profile and includes built-in engine material', async () => {
  const cwd = tmp(); const { policyHash, effectivePolicyMaterial } = await import('../src/policy.mjs'); const balanced = policyHash(cwd); const material = effectivePolicyMaterial(cwd);
  assert.match(balanced, /^[a-f0-9]{64}$/); assert.ok(material.builtinRules.some((rule) => rule.id === 'catastrophic-delete'));
  initPolicy(cwd, 'strict'); assert.notEqual(policyHash(cwd), balanced);
});
