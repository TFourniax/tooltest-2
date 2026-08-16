import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendProvenanceEvent, buildAgentBom, ensureIdentity, readProvenanceEvents, signedCheckpoint, verifyBytes, verifyProvenanceChain, canonicalJson } from '../src/provenance.mjs';
import { projectPaths } from '../src/paths.mjs';
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-prov-')); }
function event(cwd, name, extra = {}) { return { cwd, source: 'claude', session_id: 's1', hook_event_name: name, ...extra }; }

test('provenance log is hash chained and does not persist raw prompt', () => {
  const cwd = tmp(); appendProvenanceEvent(event(cwd, 'UserPromptSubmit', { prompt: 'super secret prompt' })); appendProvenanceEvent(event(cwd, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  const events = readProvenanceEvents(cwd); assert.equal(events.length, 2); assert.equal(events[1].previousHash, events[0].hash); assert.equal(verifyProvenanceChain(cwd).ok, true);
  const raw = fs.readFileSync(projectPaths(cwd).events, 'utf8'); assert.equal(raw.includes('super secret prompt'), false); assert.match(events[0].event.payloadDigest, /^[a-f0-9]{64}$/);
});

test('tampering is detected', () => {
  const cwd = tmp(); appendProvenanceEvent(event(cwd, 'SessionStart')); const file = projectPaths(cwd).events; const record = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  record.event.source = 'attacker'; fs.writeFileSync(file, `${JSON.stringify(record)}\n`); const result = verifyProvenanceChain(cwd); assert.equal(result.ok, false); assert.ok(result.errors.some((error) => error.includes('hash mismatch')));
});

test('local Ed25519 identity signs checkpoints', () => {
  const cwd = tmp(); appendProvenanceEvent(event(cwd, 'SessionStart')); const identity = ensureIdentity(cwd); assert.equal(identity.keyType, 'ed25519'); assert.equal(fs.existsSync(projectPaths(cwd).identityKey), true);
  const checkpoint = signedCheckpoint(cwd); const { signature, ...payload } = checkpoint; const ok = verifyBytes(Buffer.from(canonicalJson(payload)), signature.sig, identity.publicKey); assert.equal(ok, true);
});

test('Agent BOM aggregates tools and MCP servers', () => {
  const cwd = tmp(); appendProvenanceEvent(event(cwd, 'PreToolUse', { tool_name: 'mcp__github__search', tool_input: { query: 'x' } })); appendProvenanceEvent(event(cwd, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  const bom = buildAgentBom(cwd); assert.deepEqual(bom.sources, ['claude']); assert.ok(bom.tools.includes('Bash')); assert.deepEqual(bom.mcpServers, ['github']); assert.ok(bom.capabilities.includes('mcp.invoke')); assert.ok(bom.capabilities.includes('test.execute')); assert.equal(bom.provenance.valid, true);
});
