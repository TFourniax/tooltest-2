import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendProvenanceEvent } from '../src/provenance.mjs';
import { createAttestation, decodeAttestation, verifyAttestation } from '../src/attest.mjs';
import { projectPaths } from '../src/paths.mjs';
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-attest-')); }
function seed(cwd) {
  fs.mkdirSync(projectPaths(cwd).dir, { recursive: true });
  fs.writeFileSync(projectPaths(cwd).receipt, JSON.stringify({ schema: 'idleproof.receipt.v1', project: 'demo', session: { id: 's1', source: 'claude', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', files: ['src/a.js'], changed: { added: 2, deleted: 1 }, proof: { diffSha256: 'a'.repeat(64), head: 'deadbeef' }, findings: [] }, metrics: { debt: 12, coverage: 78 } }));
  fs.writeFileSync(projectPaths(cwd).state, JSON.stringify({ sessions: { s1: { id: 's1', source: 'claude', events: [] } } }));
  appendProvenanceEvent({ cwd, source: 'claude', session_id: 's1', hook_event_name: 'SessionStart' });
  appendProvenanceEvent({ cwd, source: 'claude', session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
}

test('creates a signed DSSE in-toto attestation and verifies it', () => {
  const cwd = tmp(); seed(cwd); const envelope = createAttestation(cwd); assert.equal(envelope.payloadType, 'application/vnd.in-toto+json'); assert.equal(envelope.signatures.length, 1); const verified = verifyAttestation(envelope); assert.equal(verified.ok, true);
  const statement = decodeAttestation(envelope); assert.equal(statement._type, 'https://in-toto.io/Statement/v1'); assert.equal(statement.subject[0].digest.sha256, 'a'.repeat(64)); assert.equal(statement.predicate.provenance.chainLength, 2);
});

test('signature verification fails after payload tampering', () => {
  const cwd = tmp(); seed(cwd); const envelope = createAttestation(cwd); const statement = decodeAttestation(envelope); statement.predicate.project = 'evil'; envelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64'); const verified = verifyAttestation(envelope); assert.equal(verified.ok, false); assert.equal(verified.signatureOk, false);
});

test('a self-signed replacement is rejected when verifier pins the original recorder key', () => {
  const victim = tmp(); const attacker = tmp(); seed(victim); seed(attacker); const victimEnvelope = createAttestation(victim); const attackerEnvelope = createAttestation(attacker); const victimKey = victimEnvelope.verificationMaterial.publicKey;
  assert.equal(verifyAttestation(attackerEnvelope).ok, true, 'self-contained cryptographic integrity still verifies'); const pinned = verifyAttestation(attackerEnvelope, { expectedPublicKey: victimKey }); assert.equal(pinned.ok, false); assert.equal(pinned.signatureOk, false);
});
