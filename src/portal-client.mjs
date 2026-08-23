import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PACKAGE_ROOT, projectPaths } from './paths.mjs';
import { computeMetrics, loadState } from './state.mjs';
import { repositoryFingerprint } from './change-identity.mjs';
import { validatePortalIngestAck } from './portal-ingest-ack.mjs';
import { assertPortalSnapshotSafe, buildPortalSnapshot, projectLocalId } from './portal-snapshot.mjs';
import { buildProjectModel } from './project-model.mjs';
import { loadContinuityContext } from './continuity.mjs';
import { taskContextQuery } from './task.mjs';

const CONFIG_SCHEMA = 'idleproof.portal-config.v1';
const DELIVERY_HEALTH_SCHEMA = 'idleproof.portal-delivery-health.v1';
const MAX_QUEUE = 200;
const MAX_RESPONSE_BYTES = 16 * 1024;
const QUEUE_LOCK_STALE_MS = 10000;
const QUEUE_LOCK_TIMEOUT_MS = 3000;
const QUEUE_LOCK_WAIT_MS = 10;
const PROJECT_ID_SEED_RE = /^dwrepo_[a-f0-9]{24}$/;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function portalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleep(ms) {
  Atomics.wait(sleepBuffer, 0, 0, ms);
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

function isLockContention(error, file) {
  if (error?.code === 'EEXIST') return true;
  if (!['EPERM', 'EACCES'].includes(error?.code)) return false;
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function withQueueLock(cwd, fn) {
  const paths = projectPaths(cwd);
  fs.mkdirSync(paths.dir, { recursive:true });
  const started = Date.now();
  let fd = null;
  while (Date.now() - started < QUEUE_LOCK_TIMEOUT_MS) {
    try {
      fd = fs.openSync(paths.portalQueueLock, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid} ${Date.now()}\n`);
      break;
    } catch (error) {
      if (!isLockContention(error, paths.portalQueueLock)) throw error;
      try {
        const stat = fs.statSync(paths.portalQueueLock);
        if (Date.now() - stat.mtimeMs > QUEUE_LOCK_STALE_MS) {
          try { fs.unlinkSync(paths.portalQueueLock); } catch {}
          continue;
        }
      } catch {}
      sleep(QUEUE_LOCK_WAIT_MS);
    }
  }
  if (fd == null) throw portalError('IDLEPROOF_PORTAL_QUEUE_BUSY', 'Portal retry queue stayed busy for 3s; refusing to overwrite concurrent delivery state.');
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(paths.portalQueueLock); } catch {}
  }
}

function validateEndpoint(raw) {
  let url;
  try { url = new URL(String(raw || '')); }
  catch { throw portalError('IDLEPROOF_PORTAL_ENDPOINT_INVALID', 'Portal endpoint must be a valid http(s) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw portalError('IDLEPROOF_PORTAL_ENDPOINT_INVALID', 'Portal endpoint must use http or https.');
  if (url.username || url.password) throw portalError('IDLEPROOF_PORTAL_ENDPOINT_CREDENTIALS', 'Portal endpoint credentials are forbidden; authentication must use the enrollment token header.');
  if (url.search) throw portalError('IDLEPROOF_PORTAL_ENDPOINT_QUERY', 'Portal endpoint query parameters are forbidden; use a stable API URL without credential-bearing query strings.');
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

function stableProjectSeed(cwd, state) {
  try { return repositoryFingerprint(cwd); }
  catch { return String(state?.createdAt || ''); }
}

export function resolvePortalProjectSeed(cwd = process.cwd(), state = null, config = undefined) {
  const currentState = state || loadState(cwd);
  let currentConfig = config;
  if (currentConfig === undefined) {
    try { currentConfig = readPortalConfig(cwd); }
    catch { currentConfig = null; }
  }
  if (currentConfig?.projectIdentitySeed) return currentConfig.projectIdentitySeed;
  // Existing v1 configs predate the stable repository seed. Keep their exact local id so an
  // upgrade never produces PROJECT_SCOPE_MISMATCH against an already-enrolled device.
  if (currentConfig) return String(currentState.createdAt || '');
  return stableProjectSeed(cwd, currentState);
}

function allLearnedFiles(state) {
  const files=[];
  for (const feature of Object.values(state?.features || {})) {
    for (const item of feature?.story || []) {
      if (item?.type === 'file' && item?.label) files.push(String(item.label).replaceAll('\\','/'));
    }
  }
  return [...new Set(files)];
}

export function buildPortalProjectModel(cwd, state, session, featureModel) {
  const mental=buildProjectModel(state,session || {},featureModel || null);
  let continuity=null;
  try {
    const query=taskContextQuery(session) || session?.task?.anchor || '';
    if (query) continuity=loadContinuityContext(cwd,query,{timeoutMs:1500});
  } catch { continuity=null; }
  return {
    stats:{
      features:Number(mental?.stats?.learnedFeatures || 0),
      files:allLearnedFiles(state).length,
      sharedFiles:Number(mental?.topology?.hotspots?.length || 0),
      boundaryNodes:Number(mental?.topology?.sharedBoundaries?.length || 0)
    },
    impact:{ blastRadius:Number(mental?.impact?.blastRadius || 0) },
    continuity
  };
}

function defaultDeliveryHealth() {
  return {
    schema:DELIVERY_HEALTH_SCHEMA,
    degraded:false,
    skippedSnapshots:0,
    lastSkippedAt:null,
    lastSkippedSnapshotId:null,
    lastErrorCode:null,
    lastErrorAt:null,
    lastSuccessAt:null
  };
}

function readDeliveryHealth(cwd) {
  const file = projectPaths(cwd).portalDeliveryHealth;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.schema !== DELIVERY_HEALTH_SCHEMA || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('unsupported delivery health schema');
    return {
      ...defaultDeliveryHealth(),
      ...parsed,
      degraded:Boolean(parsed.degraded),
      skippedSnapshots:Number.isInteger(parsed.skippedSnapshots) && parsed.skippedSnapshots >= 0 ? parsed.skippedSnapshots : 0
    };
  } catch (error) {
    if (error.code === 'ENOENT') return defaultDeliveryHealth();
    throw portalError('IDLEPROOF_PORTAL_HEALTH_CORRUPT', `Cannot read Portal delivery health: ${error.message}`);
  }
}

function writeDeliveryHealth(cwd, health) {
  atomicJson(projectPaths(cwd).portalDeliveryHealth, { ...defaultDeliveryHealth(), ...health, schema:DELIVERY_HEALTH_SCHEMA });
}

function recordDeliveryError(cwd, code) {
  return withQueueLock(cwd, () => {
    const health = readDeliveryHealth(cwd);
    const next = { ...health, lastErrorCode:String(code || 'DELIVERY_ERROR').slice(0,80), lastErrorAt:new Date().toISOString() };
    writeDeliveryHealth(cwd, next);
    return next;
  });
}

function recordDeliverySuccess(cwd) {
  return withQueueLock(cwd, () => {
    const health = readDeliveryHealth(cwd);
    const next = { ...health, lastErrorCode:null, lastErrorAt:null, lastSuccessAt:new Date().toISOString() };
    writeDeliveryHealth(cwd, next);
    return next;
  });
}

export function writePortalConfig(cwd = process.cwd(), { endpoint, token, enabled = true } = {}) {
  const paths = projectPaths(cwd);
  const state = loadState(cwd);
  let existing = null;
  if (fs.existsSync(paths.portalConfig)) existing = readPortalConfig(cwd);
  const projectIdentitySeed = existing
    ? (existing.projectIdentitySeed || String(state.createdAt || ''))
    : stableProjectSeed(cwd, state);
  const config = {
    schema:CONFIG_SCHEMA,
    enabled:Boolean(enabled),
    endpoint:validateEndpoint(endpoint),
    token:validateToken(token),
    projectIdentitySeed:PROJECT_ID_SEED_RE.test(projectIdentitySeed) ? projectIdentitySeed : undefined,
    updatedAt:new Date().toISOString()
  };
  // A legacy enrollment intentionally omits projectIdentitySeed; omission is the compatibility
  // marker that keeps using state.createdAt until the user disconnects and explicitly re-enrolls.
  if (!config.projectIdentitySeed) delete config.projectIdentitySeed;
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
  if (!parsed || parsed.schema !== CONFIG_SCHEMA || typeof parsed !== 'object' || Array.isArray(parsed)) throw portalError('IDLEPROOF_PORTAL_CONFIG_CORRUPT', 'Portal config has an unsupported schema.');
  const projectIdentitySeed = parsed.projectIdentitySeed == null ? null : String(parsed.projectIdentitySeed);
  if (projectIdentitySeed != null && !PROJECT_ID_SEED_RE.test(projectIdentitySeed)) throw portalError('IDLEPROOF_PORTAL_CONFIG_CORRUPT', 'Portal config has an invalid project identity seed.');
  return {
    schema:CONFIG_SCHEMA,
    enabled:parsed.enabled !== false,
    endpoint:validateEndpoint(parsed.endpoint),
    token:validateToken(parsed.token),
    projectIdentitySeed,
    updatedAt:parsed.updatedAt || null
  };
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
  let config = null;
  try { config = readPortalConfig(cwd); } catch {}
  const projectIdentitySeed = resolvePortalProjectSeed(cwd, state, config);
  const featureModel=session?.featureModel || null;
  const projectModel=buildPortalProjectModel(cwd,state,session,featureModel);
  const snapshot = buildPortalSnapshot({
    state:{ ...state, metrics, createdAt:projectIdentitySeed },
    session,
    featureModel,
    projectModel,
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
    if (parsed.length > MAX_QUEUE) throw new Error(`queue exceeds the ${MAX_QUEUE} snapshot bound`);
    for (const item of parsed) {
      try { assertPortalSnapshotSafe(item); }
      catch (error) { throw new Error(`unsafe queued snapshot: ${error.message}`); }
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    if (error.code === 'IDLEPROOF_PORTAL_QUEUE_CORRUPT') throw error;
    throw portalError('IDLEPROOF_PORTAL_QUEUE_CORRUPT', `Cannot read Portal queue: ${error.message}`);
  }
}

function writeQueue(cwd, queue) {
  const file = projectPaths(cwd).portalQueue;
  if (!queue.length) {
    try { fs.rmSync(file, { force:true }); } catch {}
    return;
  }
  atomicJson(file, queue);
}

export function queuePortalSnapshot(cwd = process.cwd(), snapshot = null) {
  const config = readPortalConfig(cwd);
  if (!config?.enabled) return { queued:false, reason:'not-configured', snapshotId:null, pending:0, skippedSnapshots:0 };
  const safeSnapshot = snapshot || buildCurrentPortalSnapshot(cwd);
  assertPortalSnapshotSafe(safeSnapshot);
  return withQueueLock(cwd, () => {
    const current = readQueue(cwd);
    const existed = current.some((item) => item.snapshotId === safeSnapshot.snapshotId);
    if (existed) {
      const health = readDeliveryHealth(cwd);
      return { queued:false, reason:'duplicate', snapshotId:safeSnapshot.snapshotId, pending:current.length, skippedSnapshots:health.skippedSnapshots };
    }
    if (current.length >= MAX_QUEUE) {
      const health = readDeliveryHealth(cwd);
      const nextHealth = {
        ...health,
        degraded:true,
        skippedSnapshots:health.skippedSnapshots + 1,
        lastSkippedAt:new Date().toISOString(),
        lastSkippedSnapshotId:safeSnapshot.snapshotId,
        lastErrorCode:'QUEUE_FULL',
        lastErrorAt:new Date().toISOString()
      };
      writeDeliveryHealth(cwd, nextHealth);
      // Never silently evict historical snapshots to make room. The coding agent remains
      // unblocked, but status/support become explicitly degraded because one snapshot could
      // not be retained for delivery.
      return { queued:false, reason:'queue-full', snapshotId:safeSnapshot.snapshotId, pending:current.length, skippedSnapshots:nextHealth.skippedSnapshots };
    }
    const next = [...current, safeSnapshot];
    writeQueue(cwd, next);
    const health = readDeliveryHealth(cwd);
    return { queued:true, snapshotId:safeSnapshot.snapshotId, pending:next.length, skippedSnapshots:health.skippedSnapshots };
  });
}

function removeQueuedSnapshot(cwd, snapshotId) {
  return withQueueLock(cwd, () => {
    const current = readQueue(cwd);
    const next = current.filter((item) => item.snapshotId !== snapshotId);
    writeQueue(cwd, next);
    return next.length;
  });
}

async function boundedResponse(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw portalError('IDLEPROOF_PORTAL_RESPONSE_TOO_LARGE', 'Portal response exceeded the 16 KiB safety budget.');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

export async function flushPortalQueue(cwd = process.cwd(), { fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  const config = readPortalConfig(cwd);
  const initialQueue = readQueue(cwd);
  if (!config?.enabled) return { configured:false, attempted:0, delivered:0, pending:initialQueue.length };
  if (typeof fetchImpl !== 'function') throw portalError('IDLEPROOF_PORTAL_FETCH_UNAVAILABLE', 'This Node runtime does not provide fetch().');
  let delivered = 0;
  for (const snapshot of initialQueue) {
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
      const errorCode = error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      recordDeliveryError(cwd, errorCode);
      return { configured:true, attempted:delivered + 1, delivered, pending:readQueue(cwd).length, ok:false, errorCode };
    }
    clearTimeout(timer);
    let body;
    try { body = await boundedResponse(response); }
    catch (error) {
      const errorCode = error?.code || 'INVALID_RESPONSE';
      recordDeliveryError(cwd, errorCode);
      return { configured:true, attempted:delivered + 1, delivered, pending:readQueue(cwd).length, ok:false, httpStatus:response.status, errorCode };
    }
    if (![200, 202].includes(response.status)) {
      const errorCode = body?.error?.code || `HTTP_${response.status}`;
      recordDeliveryError(cwd, errorCode);
      return { configured:true, attempted:delivered + 1, delivered, pending:readQueue(cwd).length, ok:false, httpStatus:response.status, errorCode };
    }
    try {
      validatePortalIngestAck(body, snapshot.snapshotId);
    } catch (error) {
      const errorCode = error?.code || 'IDLEPROOF_PORTAL_ACK_INVALID';
      recordDeliveryError(cwd, errorCode);
      return { configured:true, attempted:delivered + 1, delivered, pending:readQueue(cwd).length, ok:false, httpStatus:response.status, errorCode };
    }
    removeQueuedSnapshot(cwd, snapshot.snapshotId);
    delivered += 1;
  }
  if (delivered || initialQueue.length === 0) recordDeliverySuccess(cwd);
  const delivery = readDeliveryHealth(cwd);
  return { configured:true, attempted:delivered, delivered, pending:readQueue(cwd).length, ok:true, degraded:delivery.degraded, skippedSnapshots:delivery.skippedSnapshots };
}

export async function syncPortal(cwd = process.cwd(), options = {}) {
  const queued = queuePortalSnapshot(cwd);
  const flushed = await flushPortalQueue(cwd, options);
  const currentSnapshotRetained = queued.reason !== 'queue-full';
  return {
    ...flushed,
    ok: flushed.configured === false ? flushed.ok : Boolean(flushed.ok) && currentSnapshotRetained,
    errorCode: currentSnapshotRetained ? flushed.errorCode : (flushed.errorCode || 'QUEUE_FULL'),
    snapshotId:queued.snapshotId,
    newlyQueued:queued.queued,
    queueReason:queued.reason || null,
    skippedSnapshots:Math.max(queued.skippedSnapshots || 0, flushed.skippedSnapshots || 0)
  };
}

export function schedulePortalSync(cwd = process.cwd()) {
  try {
    const queued = queuePortalSnapshot(cwd);
    if (queued.reason === 'not-configured') return { scheduled:false, ...queued };
    const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'idleproof.mjs'), 'portal', 'flush', '--quiet'], {
      cwd,
      detached:true,
      stdio:'ignore',
      windowsHide:true,
      env:{ ...process.env, IDLEPROOF_PORTAL_BACKGROUND:'1' }
    });
    child.once('error', () => {});
    child.unref();
    return { scheduled:true, ...queued };
  } catch (error) {
    return { scheduled:false, errorCode:error?.code || 'IDLEPROOF_PORTAL_BACKGROUND_FAILED', message:String(error?.message || error) };
  }
}

export function portalStatus(cwd = process.cwd()) {
  const state = loadState(cwd);
  let config = null;
  try { config = readPortalConfig(cwd); }
  catch (error) {
    const seed=resolvePortalProjectSeed(cwd,state,null);
    return { schema:'idleproof.portal-status.v1', configured:false, healthy:false, degraded:true, errorCode:error.code, projectLocalId:projectLocalId(state.project, seed), pending:null, skippedSnapshots:null };
  }
  const seed=resolvePortalProjectSeed(cwd,state,config);
  let pending = null;
  let delivery;
  try {
    pending = readQueue(cwd).length;
    delivery = readDeliveryHealth(cwd);
  } catch (error) {
    return { schema:'idleproof.portal-status.v1', configured:Boolean(config), healthy:false, degraded:true, enabled:Boolean(config?.enabled), endpoint:config?.endpoint || null, tokenLast4:config?.token?.slice(-4) || null, errorCode:error?.code || 'PORTAL_LOCAL_STATE_INVALID', projectLocalId:projectLocalId(state.project, seed), pending:null, skippedSnapshots:null };
  }
  return {
    schema:'idleproof.portal-status.v1',
    configured:Boolean(config),
    healthy:Boolean(config) && !delivery.degraded && !delivery.lastErrorCode,
    degraded:Boolean(delivery.degraded),
    enabled:Boolean(config?.enabled),
    endpoint:config?.endpoint || null,
    tokenLast4:config?.token?.slice(-4) || null,
    projectLocalId:projectLocalId(state.project, seed),
    pending,
    skippedSnapshots:delivery.skippedSnapshots,
    lastErrorCode:delivery.lastErrorCode,
    lastSuccessAt:delivery.lastSuccessAt
  };
}
