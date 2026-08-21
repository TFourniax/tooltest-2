import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './paths.mjs';
import { computeMetrics, loadState } from './state.mjs';
import { assertPortalSnapshotSafe, buildPortalSnapshot, projectLocalId } from './portal-snapshot.mjs';

const CONFIG_SCHEMA = 'idleproof.portal-config.v1';
const MAX_QUEUE = 50;
const MAX_RESPONSE_BYTES = 16 * 1024;

function portalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding:'utf8', mode:0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, { force:true }); } catch {}
  }
}

function validateEndpoint(raw) {
  let url;
  try { url = new URL(String(raw || '')); }
  catch { throw portalError('IDLEPROOF_PORTAL_ENDPOINT_INVALID', 'Portal endpoint must be a valid http(s) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw portalError('IDLEPROOF_PORTAL_ENDPOINT_INVALID', 'Portal endpoint must use http or https.');
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback) throw portalError('IDLEPROOF_PORTAL_TLS_REQUIRED', 'Non-loopback Portal endpoints must use HTTPS.');
  url.hash = '';
  if (!url.pathname || url.pathname === '/') url.pathname = '/api/v1/snapshots';
  return url.toString();
}

function validateToken(token) {
  const value = String(token || '').trim();
  if (!/^ipd_[A-Za-z0-9_-]{20,}$/.test(value)) throw portalError('IDLEPROOF_PORTAL_TOKEN_INVALID', 'Portal enrollment token has an invalid format.');
  return value;
}

export function writePortalConfig(cwd = process.cwd(), { endpoint, token, enabled = true } = {}) {
  const paths = projectPaths(cwd);
  const config = { schema:CONFIG_SCHEMA, enabled:Boolean(enabled), endpoint:validateEndpoint(endpoint), token:validateToken(token), updatedAt:new Date().toISOString() };
  atomicJson(paths.portalConfig, config);
  return portalStatus(cwd);
}

export function readPortalConfig(cwd = process.cwd()) {
  const file = projectPaths(cwd).portalConfig;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw portalError('IDLEPROOF_PORTAL_CONFIG_CORRUPT', `Cannot read Portal config: ${error.message}`);
  }
  if (!parsed || parsed.schema !== CONFIG_SCHEMA || typeof parsed !== 'object') throw portalError('IDLEPROOF_PORTAL_CONFIG_CORRUPT', 'Portal config has an unsupported schema.');
  return { schema:CONFIG_SCHEMA, enabled:parsed.enabled !== false, endpoint:validateEndpoint(parsed.endpoint), token:validateToken(parsed.token), updatedAt:parsed.updatedAt || null };
}

export function disconnectPortal(cwd = process.cwd()) {
  const paths = projectPaths(cwd);
  try { fs.rmSync(paths.portalConfig, { force:true }); } catch {}
  return portalStatus(cwd);
}

function latestSession(state) {
  return Object.values(state.sessions || {}).sort((a,b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))[0] || null;
}

export function buildCurrentPortalSnapshot(cwd = process.cwd()) {
  const state = loadState(cwd);
  const session = latestSession(state);
  const metrics = computeMetrics(state);
  const snapshot = buildPortalSnapshot({
    state:{ ...state, metrics },
    session,
    featureModel:session?.featureModel || null,
    projectModel:null,
    explanation:null
  });
  assertPortalSnapshotSafe(snapshot);
  return snapshot;
}

function readQueue(cwd) {
  const file = projectPaths(cwd).portalQueue;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('queue root is not an array');
    return parsed.filter((item) => {
      try { return assertPortalSnapshotSafe(item); } catch { return false; }
    }).slice(-MAX_QUEUE);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw portalError('IDLEPROOF_PORTAL_QUEUE_CORRUPT', `Cannot read Portal queue: ${error.message}`);
  }
}

function writeQueue(cwd, queue) {
  const file = projectPaths(cwd).portalQueue;
  if (!queue.length) {
    try { fs.rmSync(file, { force:true }); } catch {}
    return;
  }
  atomicJson(file, queue.slice(-MAX_QUEUE));
}

export function queuePortalSnapshot(cwd = process.cwd(), snapshot = buildCurrentPortalSnapshot(cwd)) {
  assertPortalSnapshotSafe(snapshot);
  if (!readPortalConfig(cwd)?.enabled) return { queued:false, reason:'not-configured', snapshotId:snapshot.snapshotId };
  const queue = readQueue(cwd).filter((item) => item.snapshotId !== snapshot.snapshotId);
  queue.push(snapshot);
  writeQueue(cwd, queue);
  return { queued:true, snapshotId:snapshot.snapshotId, pending:queue.length };
}

async function boundedResponse(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw portalError('IDLEPROOF_PORTAL_RESPONSE_TOO_LARGE', 'Portal response exceeded the 16 KiB safety budget.');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

export async function flushPortalQueue(cwd = process.cwd(), { fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  const config = readPortalConfig(cwd);
  const queue = readQueue(cwd);
  if (!config?.enabled) return { configured:false, attempted:0, delivered:0, pending:queue.length };
  if (typeof fetchImpl !== 'function') throw portalError('IDLEPROOF_PORTAL_FETCH_UNAVAILABLE', 'This Node runtime does not provide fetch().');
  let delivered = 0;
  const remaining = [...queue];
  while (remaining.length) {
    const snapshot = remaining[0];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(250, Math.min(15_000, Number(timeoutMs) || 3000)));
    timer.unref?.();
    let response;
    try {
      response = await fetchImpl(config.endpoint, {
        method:'POST',
        headers:{ 'content-type':'application/json', 'authorization':`Bearer ${config.token}` },
        body:JSON.stringify(snapshot),
        signal:controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      writeQueue(cwd, remaining);
      return { configured:true, attempted:delivered + 1, delivered, pending:remaining.length, ok:false, errorCode:error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
    }
    clearTimeout(timer);
    const body = await boundedResponse(response);
    if (![200, 202].includes(response.status)) {
      writeQueue(cwd, remaining);
      return { configured:true, attempted:delivered + 1, delivered, pending:remaining.length, ok:false, httpStatus:response.status, errorCode:body?.error?.code || 'PORTAL_REJECTED' };
    }
    if (body?.snapshotId && body.snapshotId !== snapshot.snapshotId) {
      writeQueue(cwd, remaining);
      throw portalError('IDLEPROOF_PORTAL_RESPONSE_MISMATCH', 'Portal acknowledged a different snapshotId.');
    }
    remaining.shift();
    delivered += 1;
    writeQueue(cwd, remaining);
  }
  return { configured:true, attempted:delivered, delivered, pending:0, ok:true };
}

export async function syncPortal(cwd = process.cwd(), options = {}) {
  const queued = queuePortalSnapshot(cwd);
  const flushed = await flushPortalQueue(cwd, options);
  return { ...flushed, snapshotId:queued.snapshotId, newlyQueued:queued.queued };
}

export function portalStatus(cwd = process.cwd()) {
  const state = loadState(cwd);
  let config = null;
  try { config = readPortalConfig(cwd); } catch (error) { return { schema:'idleproof.portal-status.v1', configured:false, healthy:false, errorCode:error.code, projectLocalId:projectLocalId(state.project, state.createdAt), pending:null }; }
  let pending = null;
  try { pending = readQueue(cwd).length; } catch { pending = null; }
  return {
    schema:'idleproof.portal-status.v1',
    configured:Boolean(config),
    healthy:Boolean(config),
    enabled:Boolean(config?.enabled),
    endpoint:config?.endpoint || null,
    tokenLast4:config?.token?.slice(-4) || null,
    projectLocalId:projectLocalId(state.project, state.createdAt),
    pending
  };
}
