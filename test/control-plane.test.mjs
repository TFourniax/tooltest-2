import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { processHookLifecycle } from '../src/hook.mjs';
import { projectPaths } from '../src/paths.mjs';
import { verifyAttestation } from '../src/attest.mjs';
import { createEvidenceBundle } from '../src/evidence.mjs';
import { verifyProvenanceChain } from '../src/provenance.mjs';
function tempRepo() { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-control-')); execFileSync('git', ['init', '-q'], { cwd }); execFileSync('git', ['config', 'user.email', 'control@example.com'], { cwd }); execFileSync('git', ['config', 'user.name', 'IdleProof Control Test'], { cwd }); fs.writeFileSync(path.join(cwd, 'app.js'), 'export const ok = true;\n'); execFileSync('git', ['add', '.'], { cwd }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd }); return cwd; }

test('full control-plane lifecycle blocks, records, binds and signs one agent turn', () => {
  const cwd = tempRepo(); const sessionId = 'control-session';
  try {
    processHookLifecycle({ cwd, source: 'claude', session_id: sessionId, hook_event_name: 'UserPromptSubmit', prompt: 'SUPER_SECRET_PROMPT add authentication and tests' });
    const blocked = processHookLifecycle({ cwd, source: 'claude', session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } });
    assert.equal(blocked.policyDecision.originalDecision, 'deny'); assert.equal(blocked.hookOutput.hookSpecificOutput.permissionDecision, 'deny');
    processHookLifecycle({ cwd, source: 'claude', session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'app.js') } });
    fs.writeFileSync(path.join(cwd, 'app.js'), 'export const auth = user => Boolean(user?.id);\n');
    const stopped = processHookLifecycle({ cwd, source: 'claude', session_id: sessionId, hook_event_name: 'Stop' });
    assert.equal(stopped.state.sessions[sessionId].status, 'complete'); assert.ok(stopped.attestation);
    const paths = projectPaths(cwd); assert.ok(fs.existsSync(paths.attestation)); assert.ok(fs.existsSync(paths.events)); assert.ok(fs.existsSync(paths.identityKey)); assert.ok(verifyAttestation(paths.attestation).ok); assert.ok(verifyProvenanceChain(cwd).ok);
    const recorderText = fs.readFileSync(paths.events, 'utf8'); assert.doesNotMatch(recorderText, /SUPER_SECRET_PROMPT/); assert.doesNotMatch(recorderText, /rm -rf ~/);
    const bundle = createEvidenceBundle(cwd); assert.equal(bundle.schema, 'idleproof.evidence-bundle.v1'); assert.equal(bundle.provenanceCheckpoint.chain.length, 4); assert.equal(bundle.agentBillOfMaterials.policy.denied, 1); assert.ok(bundle.receipt.session.proof.diffSha256); assert.match(bundle.receipt.session.intent.sha256, /^[a-f0-9]{64}$/);
    const portable = JSON.stringify(bundle); assert.doesNotMatch(portable, /SUPER_SECRET_PROMPT/); assert.doesNotMatch(portable, /rm -rf ~/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
