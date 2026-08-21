import fs from 'node:fs';
import path from 'node:path';
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPublicKey
} from 'node:crypto';
import { projectPaths } from './paths.mjs';
import { classifyCapabilities } from './capabilities.mjs';

const ZERO_HASH = '0'.repeat(64);
// Provenance is append-only and must not silently lose a hook merely because many
// agents/subagents report at once. Uncontended acquisition remains immediate; the
// longer bounded wait only applies during genuine concurrent writer bursts.
const LOCK_STALE_MS = 15000;
const LOCK_TIMEOUT_MS = 7500;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const eventCache = new Map();
const verificationCache = new Map();
const bomCache = new Map();

function sleep(ms) { Atomics.wait(sleepBuffer, 0, 0, ms); }
export function canonicalJson(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`; const keys = Object.keys(value).sort(); return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`; }
export function sha256(value) { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value)); return createHash('sha256').update(bytes).digest('hex'); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
function writeJson(file, value, mode = 0o600) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode }); fs.renameSync(temp, file); }
function acquireLock(cwd) { const file = projectPaths(cwd).provenanceLock; fs.mkdirSync(path.dirname(file), { recursive: true }); const started = Date.now(); while (Date.now() - started < LOCK_TIMEOUT_MS) { try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, `${process.pid} ${Date.now()}\n`); return () => { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(file); } catch {} }; } catch (error) { if (error.code !== 'EEXIST') throw error; try { if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(file); continue; } } catch {} sleep(10); } } throw new Error('IdleProof provenance ledger stayed busy for 7.5s; refusing to drop a concurrent trace event.'); }
function relativeTarget(cwd, candidate) { if (!candidate || typeof candidate !== 'string') return null; const root = path.resolve(cwd); const absolute = path.resolve(root, candidate); if (absolute.startsWith(`${root}${path.sep}`)) return path.relative(root, absolute).replaceAll('\\', '/'); return candidate.replaceAll('\\', '/').slice(0, 500); }
function executable(command = '') { const text = String(command || '').trim(); return text.match(/^(?:env\s+[^\s]+\s+|sudo\s+)?([^\s]+)/)?.[1] || null; }

function fileStamp(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function cacheKey(cwd) { return path.resolve(cwd); }
function eventsStamp(cwd) { return fileStamp(projectPaths(cwd).events); }
function provenanceStamp(cwd) {
  const paths = projectPaths(cwd);
  return `${fileStamp(paths.events)}|${fileStamp(paths.chain)}`;
}
function clone(value) { return structuredClone(value); }
function invalidateProvenanceCache(cwd) {
  const key = cacheKey(cwd);
  eventCache.delete(key);
  verificationCache.delete(key);
  bomCache.delete(key);
}

function cachedEvents(cwd) {
  const key = cacheKey(cwd);
  const stamp = eventsStamp(cwd);
  const hit = eventCache.get(key);
  if (hit?.stamp === stamp) return hit.events;
  const file = projectPaths(cwd).events;
  let events;
  try {
    events = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') events = [];
    else throw error;
  }
  eventCache.set(key, { stamp, events });
  return events;
}

export function summarizeEvent(event = {}, policyDecision = null, cwd = event.cwd || process.cwd()) {
  const input = event.tool_input || {};
  const raw = { prompt: event.prompt ?? null, tool_input: event.tool_input ?? null, tool_response: event.tool_response ?? null, error: event.error ?? null, last_assistant_message: event.last_assistant_message ?? null };
  const rawBytes = Buffer.from(canonicalJson(raw));
  const target = relativeTarget(cwd, input.file_path || input.path || input.notebook_path);
  const mcp = String(event.tool_name || '').match(/^mcp__([^_]+)__(.+)$/);
  const capabilities = policyDecision?.action?.capabilities || classifyCapabilities({ tool: event.tool_name || '', command: typeof input.command === 'string' ? input.command : '', path: target || '' });
  return { id: randomUUID(), at: new Date().toISOString(), source: event.source || 'agent', eventType: event.hook_event_name || event.type || 'event', sessionId: event.session_id || null, turnId: event.turn_id || null, toolUseId: event.tool_use_id || null, agentId: event.agent_id || null, agentType: event.agent_type || null, permissionMode: event.permission_mode || null, tool: event.tool_name || null, resource: target, mcp: mcp ? { server: mcp[1], tool: mcp[2] } : null, commandExecutable: executable(input.command), capabilities, promptChars: typeof event.prompt === 'string' ? event.prompt.length : 0, inputBytes: rawBytes.length, payloadDigest: sha256(rawBytes), failed: (event.hook_event_name || event.type) === 'PostToolUseFailure' || Boolean(event.error), policy: policyDecision ? { decision: policyDecision.decision, originalDecision: policyDecision.originalDecision, risk: policyDecision.risk, approvalFingerprint: policyDecision.approvalFingerprint, reason: String(policyDecision.reason || '').slice(0, 320), matchedRuleIds: (policyDecision.matches || []).map((rule) => rule.id) } : null };
}

export function appendProvenanceEvent(event = {}, policyDecision = null, cwd = event.cwd || process.cwd()) {
  const release = acquireLock(cwd);
  try {
    const paths = projectPaths(cwd);
    fs.mkdirSync(paths.dir, { recursive: true });
    const chain = readJson(paths.chain, { schema: 'idleproof.chain.v1', length: 0, headHash: ZERO_HASH });
    const summary = summarizeEvent(event, policyDecision, cwd);
    const core = { schema: 'idleproof.event.v1', sequence: chain.length + 1, previousHash: chain.headHash || ZERO_HASH, event: summary };
    const hash = sha256(canonicalJson(core));
    const record = { ...core, hash };
    fs.appendFileSync(paths.events, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    writeJson(paths.chain, { schema: 'idleproof.chain.v1', length: record.sequence, headHash: hash, updatedAt: summary.at });
    invalidateProvenanceCache(cwd);
    return record;
  } finally {
    release();
  }
}

export function readProvenanceEvents(cwd = process.cwd(), { limit = 500 } = {}) {
  const events = cachedEvents(cwd);
  return clone(events.slice(-Math.max(1, limit)));
}

export function verifyProvenanceChain(cwd = process.cwd()) {
  const key = cacheKey(cwd);
  let stamp;
  try { stamp = provenanceStamp(cwd); }
  catch (error) { return { ok: false, length: 0, headHash: ZERO_HASH, errors: [`provenance stat failed: ${error.message}`] }; }
  const hit = verificationCache.get(key);
  if (hit?.stamp === stamp) return clone(hit.result);

  let events;
  try { events = cachedEvents(cwd); }
  catch (error) {
    const result = { ok: false, length: 0, headHash: ZERO_HASH, errors: [`provenance log cannot be parsed: ${error.message}`] };
    verificationCache.set(key, { stamp, result });
    return clone(result);
  }
  let previous = ZERO_HASH;
  const errors = [];
  for (let index = 0; index < events.length; index += 1) {
    const record = events[index];
    const { hash, ...core } = record;
    const expected = sha256(canonicalJson(core));
    if (record.sequence !== index + 1) errors.push(`sequence ${record.sequence} at line ${index + 1}`);
    if (record.previousHash !== previous) errors.push(`previousHash mismatch at sequence ${record.sequence}`);
    if (hash !== expected) errors.push(`hash mismatch at sequence ${record.sequence}`);
    previous = hash;
  }
  let chain;
  try { chain = readJson(projectPaths(cwd).chain, { length: 0, headHash: ZERO_HASH }); }
  catch (error) { chain = { length: -1, headHash: null }; errors.push(`chain checkpoint cannot be parsed: ${error.message}`); }
  if (chain.length !== events.length) errors.push(`chain length ${chain.length} != event count ${events.length}`);
  if ((chain.headHash || ZERO_HASH) !== previous) errors.push('chain head hash mismatch');
  const result = { ok: errors.length === 0, length: events.length, headHash: previous, errors };
  verificationCache.set(key, { stamp, result });
  return clone(result);
}

export function ensureIdentity(cwd = process.cwd()) { const paths = projectPaths(cwd); const existing = readJson(paths.identity, null); if (existing && fs.existsSync(paths.identityKey)) { if (!fs.existsSync(paths.identityPublic) && existing.publicKey) fs.writeFileSync(paths.identityPublic, existing.publicKey, { encoding: 'utf8', mode: 0o644 }); return existing; } fs.mkdirSync(paths.dir, { recursive: true }); const { publicKey, privateKey } = generateKeyPairSync('ed25519'); const publicPem = publicKey.export({ type: 'spki', format: 'pem' }); const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }); const publicDer = publicKey.export({ type: 'spki', format: 'der' }); const fingerprint = sha256(publicDer).slice(0, 32); const identity = { schema: 'idleproof.identity.v1', keyType: 'ed25519', fingerprint, publicKey: String(publicPem), createdAt: new Date().toISOString() }; fs.writeFileSync(paths.identityKey, privatePem, { encoding: 'utf8', mode: 0o600 }); fs.writeFileSync(paths.identityPublic, publicPem, { encoding: 'utf8', mode: 0o644 }); writeJson(paths.identity, identity); return identity; }
export function signBytes(cwd, bytes) { const identity = ensureIdentity(cwd); const privatePem = fs.readFileSync(projectPaths(cwd).identityKey, 'utf8'); const signature = cryptoSign(null, Buffer.from(bytes), privatePem); return { keyid: identity.fingerprint, sig: signature.toString('base64'), publicKey: identity.publicKey }; }
export function verifyBytes(bytes, signature, publicKey) { try { return cryptoVerify(null, Buffer.from(bytes), createPublicKey(publicKey), Buffer.from(signature, 'base64')); } catch { return false; } }
export function signedCheckpoint(cwd = process.cwd()) { const chain = verifyProvenanceChain(cwd); if (!chain.ok) throw new Error(`Cannot sign invalid provenance chain: ${chain.errors.join('; ')}`); const identity = ensureIdentity(cwd); const payload = { schema: 'idleproof.checkpoint.v1', project: path.basename(path.resolve(cwd)), generatedAt: new Date().toISOString(), chain: { length: chain.length, headHash: chain.headHash }, signer: { fingerprint: identity.fingerprint, keyType: identity.keyType, publicKey: identity.publicKey } }; const bytes = Buffer.from(canonicalJson(payload)); const signature = signBytes(cwd, bytes); return { ...payload, signature: { keyid: signature.keyid, sig: signature.sig } }; }

function computeAgentBom(cwd, events, chain) {
  const sources = new Set(); const tools = new Set(); const mcpServers = new Set(); const permissionModes = new Set(); const capabilities = new Set(); const sessions = new Set(); const agents = new Set(); let denied = 0; let asked = 0; let failures = 0;
  for (const record of events) {
    const event = record.event || {};
    if (event.source) sources.add(event.source);
    if (event.tool) tools.add(event.tool);
    if (event.mcp?.server) mcpServers.add(event.mcp.server);
    if (event.permissionMode) permissionModes.add(event.permissionMode);
    for (const capability of event.capabilities || []) capabilities.add(capability);
    if (event.sessionId) sessions.add(event.sessionId);
    if (event.agentType || event.agentId) agents.add(`${event.agentType || 'agent'}:${event.agentId || 'unknown'}`);
    if (event.policy?.originalDecision === 'deny') denied += 1;
    if (event.policy?.originalDecision === 'ask') asked += 1;
    if (event.failed) failures += 1;
  }
  return { schema: 'idleproof.agent-bom.v1', generatedAt: new Date().toISOString(), project: path.basename(path.resolve(cwd)), sources: [...sources].sort(), agents: [...agents].sort(), tools: [...tools].sort(), mcpServers: [...mcpServers].sort(), permissionModes: [...permissionModes].sort(), capabilities: [...capabilities].sort(), sessions: sessions.size, events: events.length, failures, policy: { denied, asked }, provenance: { valid: chain.ok, length: chain.length, headHash: chain.headHash } };
}

export function buildAgentBom(cwd = process.cwd(), { write = true } = {}) {
  const key = cacheKey(cwd);
  const stamp = provenanceStamp(cwd);
  if (!write) {
    const hit = bomCache.get(key);
    if (hit?.stamp === stamp) return clone(hit.bom);
  }
  const events = cachedEvents(cwd);
  const chain = verifyProvenanceChain(cwd);
  const bom = computeAgentBom(cwd, events, chain);
  if (write) writeJson(projectPaths(cwd).agentBom, bom);
  else bomCache.set(key, { stamp, bom });
  return clone(bom);
}