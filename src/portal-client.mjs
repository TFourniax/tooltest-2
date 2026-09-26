import { normalizedProjectPath } from './project-path.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PACKAGE_ROOT, projectPaths } from './paths.mjs';
import { computeMetrics, excludeLocalState, freshState, loadPersistedState, loadState, mutateState } from './state.mjs';
import { repositoryFingerprint } from './change-identity.mjs';
import { validatePortalIngestAck } from './portal-ingest-ack.mjs';
import { assertPortalSnapshotSafe, buildPortalSnapshot, projectLocalId } from './portal-snapshot.mjs';
import { buildProjectModel } from './project-model.mjs';
import { loadContinuityContext } from './continuity.mjs';
import { taskContinuityQuery } from './task.mjs';
import { withMemoryLock } from './portal-memory-lock.mjs';

const CONFIG_SCHEMA = 'idleproof.portal-config.v1';
const DELIVERY_HEALTH_SCHEMA = 'idleproof.portal-delivery-health.v1';
const MAX_QUEUE = 200;
const MAX_RESPONSE_BYTES = 16 * 1024;
const QUEUE_LOCK_STALE_MS = 10000;
const QUEUE_LOCK_TIMEOUT_MS = 3000;
const QUEUE_LOCK_WAIT_MS = 10;
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

function allLearnedFiles(state) {
  const files=[];
  for (const feature of Object.values(state?.features || {})) {
    for (const item of feature?.story || []) {
      if (item?.type === 'file' && item?.label) files.push(normalizedProjectPath(item.label));
    }
  }
  return [...new Set(files)];
}

export function buildPortalProjectModel(cwd, state, session, featureModel) {
  const mental=buildProjectModel(state,session || {},featureModel || null);
  let continuity=null;
  try {
    const query=taskContinuityQuery(session) || session?.task?.anchor || '';
    if (query) continuity=loadContinuityContext(cwd,query,{timeoutMs:1500});
  } catch { continuity=null; }
  let repoFingerprint=null;
  try { repoFingerprint=repositoryFingerprint(cwd); } catch {}
  return {
    repositoryFingerprint:repoFingerprint,
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
  const config = { schema:CONFIG_SCHEMA, enabled:Boolean(enabled), endpoint:validateEndpoint(endpoint), token:validateToken(token), updatedAt:new Date().toISOString() };
  // Serialized with memory cursor writes and memory page initiation (see portal-memory-lock.mjs).
  withMemoryLock(cwd, () => atomicJson(paths.portalConfig, config));
  return portalStatus(cwd);
}

// `portal configure`: the enrollment is only reported saved alongside a persisted identity. A
// concurrent `idleproof reset` between creating the identity and writing the config would leave an
// enrollment without one, so both steps are repeated until a read confirms them together; if that
// never happens the config just written is removed again and nothing is configured.
export function configurePortal(cwd = process.cwd(), { endpoint, token } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    ensurePortalIdentity(cwd);
    const status = writePortalConfig(cwd, { endpoint, token });
    if (status.identityPersisted && status.configured && status.endpoint === validateEndpoint(endpoint)) return status;
  }
  try { fs.rmSync(projectPaths(cwd).portalConfig, { force:true }); } catch {}
  throw portalError('IDLEPROOF_PORTAL_IDENTITY_UNSTABLE', 'The IdleProof project state was removed while Portal was being configured (a concurrent reset?). Nothing was configured; retry.');
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
  return { schema:CONFIG_SCHEMA, enabled:parsed.enabled !== false, endpoint:validateEndpoint(parsed.endpoint), token:validateToken(parsed.token), updatedAt:parsed.updatedAt || null };
}

export function disconnectPortal(cwd = process.cwd()) {
  const paths = projectPaths(cwd);
  withMemoryLock(cwd, () => { try { fs.rmSync(paths.portalConfig, { force:true }); } catch {} });
  return portalStatus(cwd);
}

function latestSession(state) {
  return Object.values(state.sessions || {}).sort((a,b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))[0] || null;
}

export function buildCurrentPortalSnapshot(cwd = process.cwd()) {
  const state = loadState(cwd);
  const session = latestSession(state);
  const metrics = computeMetrics(state);
  const featureModel=session?.featureModel || null;
  const projectModel=buildPortalProjectModel(cwd,state,session,featureModel);
  const snapshot = buildPortalSnapshot({
    state:{ ...state, metrics },
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

// Snapshot identity excludes generatedAt, but Portal compares the complete body of a retransmission:
// the same snapshotId with another generatedAt is refused as SNAPSHOT_CONFLICT. A snapshot rebuilt
// with unchanged content (a repeated sync, a retry after a lost acknowledgement, a new credential or
// endpoint) therefore reuses the generatedAt it was first built with, so it is resent byte-for-byte:
// Portal answers duplicate when it already holds it and accepts it otherwise. Bounded, local only.
const SNAPSHOT_TIMES_SCHEMA = 'idleproof.portal-snapshot-times.v1';
const MAX_SNAPSHOT_TIMES = 1024;

// A reused generatedAt must be the UTC instant this client writes (Date#toISOString), never
// whatever a damaged local file holds: it is uploaded as is and the snapshot id does not cover it.
export function isPortalTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
}

function readSnapshotTimes(cwd) {
  try {
    const value = JSON.parse(fs.readFileSync(projectPaths(cwd).portalSnapshotTimes, 'utf8'));
    if (value?.schema !== SNAPSHOT_TIMES_SCHEMA || !Array.isArray(value.entries)) return [];
    return value.entries.filter((item) => /^ipsnap_[a-f0-9]{24}$/.test(String(item?.snapshotId)) && isPortalTimestamp(item?.generatedAt));
  } catch { return []; }
}

// Records the generatedAt of a snapshot that is queued or delivered without overriding a known one,
// so a snapshot queued before this record existed (an upgrade) is also resent with its own time.
function rememberSnapshotTime(cwd, snapshot) {
  const entries = readSnapshotTimes(cwd);
  if (entries.some((item) => item.snapshotId === snapshot.snapshotId) || !isPortalTimestamp(snapshot?.generatedAt)) return;
  entries.push({ snapshotId:snapshot.snapshotId, generatedAt:snapshot.generatedAt });
  atomicJson(projectPaths(cwd).portalSnapshotTimes, { schema:SNAPSHOT_TIMES_SCHEMA, entries:entries.slice(-MAX_SNAPSHOT_TIMES) });
}

// Snapshots a destination (endpoint and enrollment credential, stored only as a hash) already holds
// under another first time, as its SNAPSHOT_CONFLICT answer proves: not sent there again.
const HELD_SCHEMA = 'idleproof.portal-held.v1';
const MAX_HELD = 1024;
const destinationKey = (config) => createHash('sha256').update(`${config?.endpoint || ''}\n${config?.token || ''}`).digest('hex').slice(0, 32);

function readHeld(cwd) {
  try {
    const value = JSON.parse(fs.readFileSync(projectPaths(cwd).portalHeld, 'utf8'));
    if (value?.schema !== HELD_SCHEMA || !Array.isArray(value.entries)) return [];
    return value.entries.filter((item) => /^[a-f0-9]{32}$/.test(String(item?.destination)) && /^ipsnap_[a-f0-9]{24}$/.test(String(item?.snapshotId)));
  } catch { return []; }
}

function markHeldByPortal(cwd, config, snapshotId) {
  const destination = destinationKey(config);
  const entries = readHeld(cwd).filter((item) => !(item.destination === destination && item.snapshotId === snapshotId));
  entries.push({ destination, snapshotId });
  atomicJson(projectPaths(cwd).portalHeld, { schema:HELD_SCHEMA, entries:entries.slice(-MAX_HELD) });
}

function heldByDestination(cwd, config, snapshotId) {
  const destination = destinationKey(config);
  return readHeld(cwd).some((item) => item.destination === destination && item.snapshotId === snapshotId);
}

// Drops a recorded time that Portal has just refused for this snapshot.
function forgetSnapshotTime(cwd, snapshot) {
  const entries = readSnapshotTimes(cwd);
  const kept = entries.filter((item) => !(item.snapshotId === snapshot.snapshotId && item.generatedAt === snapshot.generatedAt));
  if (kept.length !== entries.length) atomicJson(projectPaths(cwd).portalSnapshotTimes, { schema:SNAPSHOT_TIMES_SCHEMA, entries:kept });
}

function withFirstGeneratedAt(cwd, snapshot) {
  const entries = readSnapshotTimes(cwd);
  const known = entries.find((item) => item.snapshotId === snapshot.snapshotId);
  if (known) return known.generatedAt === snapshot.generatedAt ? snapshot : { ...snapshot, generatedAt:known.generatedAt };
  entries.push({ snapshotId:snapshot.snapshotId, generatedAt:snapshot.generatedAt });
  atomicJson(projectPaths(cwd).portalSnapshotTimes, { schema:SNAPSHOT_TIMES_SCHEMA, entries:entries.slice(-MAX_SNAPSHOT_TIMES) });
  return snapshot;
}

export function queuePortalSnapshot(cwd = process.cwd(), snapshot = null) {
  const config = readPortalConfig(cwd);
  if (!config?.enabled) return { queued:false, reason:'not-configured', snapshotId:null, pending:0, skippedSnapshots:0 };
  const safeSnapshot = snapshot || buildCurrentPortalSnapshot(cwd);
  assertPortalSnapshotSafe(safeSnapshot);
  return withQueueLock(cwd, () => {
    const current = readQueue(cwd);
    if (heldByDestination(cwd, config, safeSnapshot.snapshotId)) {
      const health = readDeliveryHealth(cwd);
      return { queued:false, reason:'held-by-portal', snapshotId:safeSnapshot.snapshotId, pending:current.length, skippedSnapshots:health.skippedSnapshots };
    }
    const existing = current.find((item) => item.snapshotId === safeSnapshot.snapshotId);
    if (existing) {
      rememberSnapshotTime(cwd, existing);
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
      return { queued:false, reason:'queue-full', snapshotId:safeSnapshot.snapshotId, pending:current.length, skippedSnapshots:nextHealth.skippedSnapshots };
    }
    const next = [...current, withFirstGeneratedAt(cwd, safeSnapshot)];
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
  let heldByPortal = 0;
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
    // The snapshotId is verified by Portal as the hash of everything but generatedAt, so a conflict
    // means Portal already holds this receipt's content under another generatedAt (for example one
    // queued by an older client). Nothing is lost by no longer retrying it; Portal keeps refusing the
    // differing body, and the rest of the queue is no longer blocked behind it.
    if (response.status === 409 && body?.error?.code === 'SNAPSHOT_CONFLICT') {
      // The rejected generatedAt is never recorded as reusable; this destination is marked as
      // already holding the content, so later unchanged syncs send nothing for it.
      withQueueLock(cwd, () => { markHeldByPortal(cwd, config, snapshot.snapshotId); forgetSnapshotTime(cwd, snapshot); });
      removeQueuedSnapshot(cwd, snapshot.snapshotId);
      delivered += 1;
      heldByPortal += 1;
      continue;
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
    withQueueLock(cwd, () => rememberSnapshotTime(cwd, snapshot));
    removeQueuedSnapshot(cwd, snapshot.snapshotId);
    delivered += 1;
  }
  if (delivered || initialQueue.length === 0) recordDeliverySuccess(cwd);
  const delivery = readDeliveryHealth(cwd);
  return { configured:true, attempted:delivered, delivered, heldByPortal, pending:readQueue(cwd).length, ok:true, degraded:delivery.degraded, skippedSnapshots:delivery.skippedSnapshots };
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

// The enrollment identity is derived from the project state's creation time, so it is only stable
// once that state is persisted. Reading or configuring the identity persists it (under the state
// lock, reusing any state another process wrote first); no task or event is created. The local
// state directory is also excluded from Git locally, so it never becomes tracked code.
export function ensurePortalIdentity(cwd = process.cwd()) {
  // A concurrent `idleproof reset` can remove the state between creating it and reading it back,
  // so creation is repeated until one read of the persisted state confirms the identity.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!loadPersistedState(cwd)) mutateState(cwd, (state) => state);
    excludeLocalState(cwd);
    const status = portalStatus(cwd);
    if (status.identityPersisted) return status;
  }
  throw portalError('IDLEPROOF_PORTAL_IDENTITY_UNSTABLE', 'The IdleProof project state was removed while its identity was being created (a concurrent reset?). Nothing was configured; retry.');
}

export function portalStatus(cwd = process.cwd()) {
  // Persistence and the ID come from one read of the persisted state: a state created, reset or
  // removed concurrently can never pair a persisted flag with an ephemeral state's ID. Before the
  // state is persisted the ID would change on every read, so none is reported until then.
  const persisted = loadPersistedState(cwd);
  const identityPersisted = Boolean(persisted);
  const state = persisted || freshState(cwd);
  const localId = identityPersisted ? projectLocalId(state.project, state.createdAt) : null;
  let config = null;
  try { config = readPortalConfig(cwd); }
  catch (error) { return { schema:'idleproof.portal-status.v1', configured:false, healthy:false, degraded:true, errorCode:error.code, projectLocalId:localId, identityPersisted, pending:null, skippedSnapshots:null }; }
  let pending = null;
  let delivery;
  try {
    pending = readQueue(cwd).length;
    delivery = readDeliveryHealth(cwd);
  } catch (error) {
    return { schema:'idleproof.portal-status.v1', configured:Boolean(config), healthy:false, degraded:true, enabled:Boolean(config?.enabled), endpoint:config?.endpoint || null, tokenLast4:config?.token?.slice(-4) || null, errorCode:error?.code || 'PORTAL_LOCAL_STATE_INVALID', projectLocalId:localId, identityPersisted, pending:null, skippedSnapshots:null };
  }
  return {
    schema:'idleproof.portal-status.v1',
    configured:Boolean(config),
    healthy:Boolean(config) && !delivery.degraded && !delivery.lastErrorCode,
    degraded:Boolean(delivery.degraded),
    enabled:Boolean(config?.enabled),
    endpoint:config?.endpoint || null,
    tokenLast4:config?.token?.slice(-4) || null,
    projectLocalId:localId,
    identityPersisted,
    pending,
    skippedSnapshots:delivery.skippedSnapshots,
    lastErrorCode:delivery.lastErrorCode,
    lastSuccessAt:delivery.lastSuccessAt
  };
}
