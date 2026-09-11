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

test('warm verification and read-only BOM reuse parsed provenance without rereading the log', () => {
  const cwd = tmp(); appendProvenanceEvent(event(cwd, 'SessionStart')); appendProvenanceEvent(event(cwd, 'PreToolUse', { tool_name:'Bash', tool_input:{ command:'npm test' } }));
  assert.equal(verifyProvenanceChain(cwd).ok, true);
  buildAgentBom(cwd, { write:false });

  const target = path.resolve(projectPaths(cwd).events);
  const original = fs.readFileSync;
  let eventReads = 0;
  fs.readFileSync = function patched(file, ...args) {
    if (path.resolve(String(file)) === target) eventReads += 1;
    return original.call(this, file, ...args);
  };
  try {
    assert.equal(verifyProvenanceChain(cwd).ok, true);
    assert.equal(verifyProvenanceChain(cwd).ok, true);
    assert.equal(buildAgentBom(cwd, { write:false }).events, 2);
    assert.equal(buildAgentBom(cwd, { write:false }).events, 2);
  } finally {
    fs.readFileSync = original;
  }
  assert.equal(eventReads, 0, 'unchanged provenance should be served from the file-identity cache');
});

test('append invalidates warm provenance caches immediately', () => {
  const cwd = tmp(); appendProvenanceEvent(event(cwd, 'SessionStart'));
  assert.equal(verifyProvenanceChain(cwd).length, 1);
  assert.equal(buildAgentBom(cwd, { write:false }).events, 1);
  appendProvenanceEvent(event(cwd, 'PreToolUse', { tool_name:'Bash', tool_input:{ command:'npm test' } }));
  const verified = verifyProvenanceChain(cwd);
  assert.equal(verified.ok, true);
  assert.equal(verified.length, 2);
  assert.equal(buildAgentBom(cwd, { write:false }).events, 2);
});

test('tampering after a warm cache invalidates the cache and still fails closed', () => {
  const cwd = tmp(); appendProvenanceEvent(event(cwd, 'SessionStart'));
  const file = projectPaths(cwd).events;
  assert.equal(verifyProvenanceChain(cwd).ok, true);
  assert.equal(buildAgentBom(cwd, { write:false }).provenance.valid, true);

  const raw = fs.readFileSync(file, 'utf8');
  const record = JSON.parse(raw.trim());
  // Keep the replacement the same length so size alone cannot invalidate the cache.
  assert.equal(record.event.source.length, 'claude'.length);
  record.event.source = 'hacker';
  const rewritten = `${JSON.stringify(record)}\n`;
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(raw));
  fs.writeFileSync(file, rewritten);
  // Force an observable mtime transition even on filesystems with coarse timestamp resolution.
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(file, future, future);

  const verified = verifyProvenanceChain(cwd);
  assert.equal(verified.ok, false);
  assert.ok(verified.errors.some((error) => error.includes('hash mismatch')));
  assert.equal(buildAgentBom(cwd, { write:false }).provenance.valid, false);
});

test('callers cannot mutate cached provenance through returned objects', () => {
  const cwd = tmp(); appendProvenanceEvent(event(cwd, 'SessionStart'));
  const first = readProvenanceEvents(cwd);
  first[0].event.source = 'caller-mutated';
  first.push({ injected:true });

  const second = readProvenanceEvents(cwd);
  assert.equal(second.length, 1);
  assert.equal(second[0].event.source, 'claude');
  assert.equal(verifyProvenanceChain(cwd).ok, true);
});

test('local Ed25519 identity signs checkpoints', () => {
  const cwd = tmp(); appendProvenanceEvent(event(cwd, 'SessionStart')); const identity = ensureIdentity(cwd); assert.equal(identity.keyType, 'ed25519'); assert.equal(fs.existsSync(projectPaths(cwd).identityKey), true);
  const checkpoint = signedCheckpoint(cwd); const { signature, ...payload } = checkpoint; const ok = verifyBytes(Buffer.from(canonicalJson(payload)), signature.sig, identity.publicKey); assert.equal(ok, true);
});

test('Agent BOM aggregates tools and MCP servers', () => {
  const cwd = tmp(); appendProvenanceEvent(event(cwd, 'PreToolUse', { tool_name: 'mcp__github__search', tool_input: { query: 'x' } })); appendProvenanceEvent(event(cwd, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  const bom = buildAgentBom(cwd); assert.deepEqual(bom.sources, ['claude']); assert.ok(bom.tools.includes('Bash')); assert.deepEqual(bom.mcpServers, ['github']); assert.ok(bom.capabilities.includes('mcp.invoke')); assert.ok(bom.capabilities.includes('test.execute')); assert.equal(bom.provenance.valid, true);
});
