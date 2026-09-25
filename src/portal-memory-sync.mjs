// Incremental, acknowledged export of retained Project Memory history to Portal
// (idleproof.portal-memory-page.v1). The source is the validated Core journal paged
// forward from an anchored prefix; only categories the snapshot contract already
// represents are projected, through the same identity and redaction rules.
//
// Durability rules:
// - the exact page is persisted before it is sent, so a retransmission is byte-identical;
// - the cursor advances only after a valid ack for the same project/stream/range/page;
// - a server cursor is adopted only after the local journal proves the same prefix;
// - divergence, journal replacement or identity conflicts become explicit states.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectPaths } from './paths.mjs';
import { loadState } from './state.mjs';
import { repositoryFingerprint } from './change-identity.mjs';
import { readPortalConfig } from './portal-client.mjs';
import { withMemoryLock } from './portal-memory-lock.mjs';
import {
  PORTAL_FORBIDDEN_KEYS,
  PORTAL_SECRET_PATTERNS,
  portalCanonical,
  portalContinuityIdentity,
  portalDigest,
  projectLocalId,
  redactPortalText
} from './portal-snapshot.mjs';

export const MEMORY_PAGE_SCHEMA = 'idleproof.portal-memory-page.v1';
export const MEMORY_ACK_SCHEMA = 'idleproof.portal-memory-ack.v1';
const STATE_SCHEMA = 'idleproof.portal-memory-cursor.v1';
const MAX_PAGE_BYTES = 64 * 1024;
const MAX_PAGE_ITEMS = 256;
const DEFAULT_PAGE_EVENTS = 200;
const MAX_CORE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const EVENT_ID = /^dwev_[a-f0-9]{24}$/;
const STATUSES = new Set(['DECLARED', 'INFERRED', 'OBSERVED', 'VERIFIED']);
const DECLARATIONS = new Map([
  ['objective.declared', 'objective'], ['decision.recorded', 'decision'],
  ['invariant.declared', 'invariant'], ['approach.failed', 'failed-approach'],
  ['task.recorded', 'task'], ['task.described', 'task']
]);
const CONFIRMATIONS = new Map([
  ['objective.confirmed', 'objective'], ['decision.confirmed', 'decision'],
  ['invariant.confirmed', 'invariant'], ['approach.confirmed', 'failed-approach']
]);
// Relation endpoints carry the Core entity kind so Portal never attaches a relation to another
// entity that merely shares the same opaque ID. A kind outside Portal's set is sent as null.
const ENTITY_KINDS = new Set(['task', 'objective', 'decision', 'invariant', 'failed-approach', 'component', 'debt', 'change']);
const entityKind = (value) => ENTITY_KINDS.has(value) ? value : null;

function memoryError(code, message) {
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

// Short critical sections only (read-modify-write of the cursor file); never held across network I/O.
function freshState(binding, journal = null, epoch = 1) {
  return { schema:STATE_SCHEMA, ...binding, protocol:MEMORY_PAGE_SCHEMA, journal, epoch, next:0, headHash:null,
    status:'active', statusCode:null, pending:null, lastAckAt:null, previous:null, updatedAt:new Date().toISOString() };
}

function validState(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.schema === STATE_SCHEMA
    && value.protocol === MEMORY_PAGE_SCHEMA && Number.isSafeInteger(value.next) && value.next >= 0
    && Number.isSafeInteger(value.epoch) && value.epoch >= 1
    && (value.next === 0 ? value.headHash === null : HASH.test(String(value.headHash || '')))
    && (value.journal === null || /^dwjrn_[a-f0-9]{64}$/.test(String(value.journal)));
}

export function readPortalMemoryState(cwd) {
  const file = projectPaths(cwd).portalMemoryState;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validState(value)) throw memoryError('IDLEPROOF_PORTAL_MEMORY_CORRUPT', 'Portal memory cursor has an unsupported or inconsistent shape.');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'IDLEPROOF_PORTAL_MEMORY_CORRUPT') throw error;
    throw memoryError('IDLEPROOF_PORTAL_MEMORY_CORRUPT', `Cannot read Portal memory cursor: ${error.message}`);
  }
}

function writeState(cwd, state) {
  atomicJson(projectPaths(cwd).portalMemoryState, { ...state, updatedAt:new Date().toISOString() });
  return state;
}

function currentBinding(cwd, config) {
  const state = loadState(cwd);
  let fingerprint = null;
  try { fingerprint = repositoryFingerprint(cwd); } catch {}
  // Non-secret enrollment identity: a re-enrollment (new token, possibly another Portal project)
  // is a different server stream and must never reuse an old cursor.
  const enrollment = `dwenr_${portalDigest(`idleproof-memory-enrollment:${config.token}`).slice(0, 24)}`;
  return { endpoint:config.endpoint, enrollment, localProjectId:projectLocalId(state.project, state.createdAt), repositoryFingerprint:fingerprint };
}

function sameBinding(state, binding) {
  return state.endpoint === binding.endpoint && state.enrollment === binding.enrollment
    && state.localProjectId === binding.localProjectId && state.repositoryFingerprint === binding.repositoryFingerprint;
}

// The cursor file does not change on `portal configure`/`portal disconnect`, so work that started
// under one configuration re-reads it before every write and every send and stops once it changed.
function sameConfig(cwd, config) {
  let current;
  try { current = readPortalConfig(cwd); } catch { return false; }
  return Boolean(current?.enabled) && current.endpoint === config.endpoint && current.token === config.token;
}

// ---------------------------------------------------------------------------------------------
// Core journal source
// ---------------------------------------------------------------------------------------------
function runCore(cwd, args, timeoutMs, runner = null) {
  if (runner) return runner(['state', 'events', ...args], { cwd, timeoutMs });
  try {
    const stdout = execFileSync('dw', ['state', 'events', ...args], {
      cwd, encoding:'utf8', timeout:Math.max(500, Math.min(Number(timeoutMs) || 5000, 30000)),
      maxBuffer:MAX_CORE_BYTES, windowsHide:true, stdio:['ignore', 'pipe', 'pipe']
    });
    return { ok:true, stdout };
  } catch (error) {
    return { ok:false, stderr:String(error?.stderr || ''), code:error?.status ?? null, errno:error?.code || null };
  }
}

function checkedEvents(items, after, expectHead) {
  let previous = expectHead ?? null;
  let sequence = after;
  for (const item of items) {
    const event = item?.event;
    sequence += 1;
    if (item?.sequence !== sequence || !event || typeof event !== 'object' || !EVENT_ID.test(String(event.event_id))
      || !HASH.test(String(event.event_hash)) || (event.prev_hash ?? null) !== previous) {
      throw memoryError('IDLEPROOF_PORTAL_MEMORY_SOURCE_INVALID', 'Core journal page is not a contiguous hash chain from the requested prefix.');
    }
    previous = event.event_hash;
  }
  return items;
}

// Returns { status:'ok', genesis, events:[{sequence,event}], next, head, hasMore, eventCount }
// or { status:'prefix-mismatch'|'unsupported'|'unavailable', detail }.
export function readJournalPage(cwd, { after = 0, expectHead = null, limit = DEFAULT_PAGE_EVENTS, timeoutMs = 5000, runner = null } = {}) {
  const args = ['--after', String(after), '--limit', String(limit), '--json'];
  if (after > 0) args.splice(2, 0, '--expect-head', expectHead);
  const result = runCore(cwd, args, timeoutMs, runner);
  if (result.ok) {
    let page;
    try { page = JSON.parse(result.stdout); } catch { return { status:'unavailable', detail:'invalid Core JSON' }; }
    if (!page || page.schema_version !== 'project-event-page-1' || page.after !== after || !Array.isArray(page.events)) {
      return { status:'unavailable', detail:'unsupported Core page shape' };
    }
    const genesis = page.journal?.genesisHash ?? null;
    if (genesis !== null && !HASH.test(String(genesis))) return { status:'unavailable', detail:'invalid journal identity' };
    try { checkedEvents(page.events, after, after > 0 ? expectHead : null); }
    catch (error) { return { status:'unavailable', detail:error.message }; }
    const next = after + page.events.length;
    if (page.next !== next || (next > 0 && page.events.length && page.head !== page.events.at(-1).event.event_hash)) {
      return { status:'unavailable', detail:'inconsistent Core page cursor' };
    }
    // An empty page means the end of the journal only if it does not advertise more history.
    // A genesis names the journal's first event, so an empty first page that carries one is not an
    // empty journal either.
    if (!page.events.length && (page.hasMore || Number(page.journal?.eventCount ?? next) > next || (after === 0 && genesis !== null))) {
      return { status:'unavailable', detail:'empty Core page advertises more history' };
    }
    // An empty page past the start proves the prefix only if Core itself reports the expected head
    // (a Core that ignored --expect-head must not confirm a cursor on another journal).
    if (!page.events.length && after > 0 && page.head !== expectHead) {
      return { status:'unavailable', detail:'empty Core page does not confirm the expected head' };
    }
    return { status:'ok', genesis, events:page.events, next, head:next === after ? (after ? page.head : null) : page.head,
      hasMore:Boolean(page.hasMore), eventCount:Number(page.journal?.eventCount ?? next) };
  }
  if (/restart/i.test(result.stderr)) return { status:'prefix-mismatch', detail:'journal prefix differs from the acknowledged cursor' };
  if (/unrecognized arguments/i.test(result.stderr)) return legacyJournalPage(cwd, { after, expectHead, limit, timeoutMs, runner });
  return { status:'unavailable', detail:result.errno === 'ENOENT' ? 'DiffWitness Core (dw) is not installed' : 'Core journal read failed' };
}

// Older Core only exposes the newest <=500 events. That is a complete source only when the
// genesis event is included; otherwise history is declared unavailable instead of skipped.
function legacyJournalPage(cwd, { after, expectHead, limit, timeoutMs, runner }) {
  const result = runCore(cwd, ['--limit', '500', '--json'], timeoutMs, runner);
  if (!result.ok) return { status:'unavailable', detail:'Core journal read failed' };
  let events;
  try { events = JSON.parse(result.stdout); } catch { return { status:'unavailable', detail:'invalid Core JSON' }; }
  if (!Array.isArray(events)) return { status:'unavailable', detail:'unsupported Core events shape' };
  if (events.length >= 500 || (events.length && events[0]?.prev_hash !== null)) {
    return { status:'unsupported', detail:'installed Core cannot page its full journal; upgrade DiffWitness Core to export older history' };
  }
  if (after > events.length || (after > 0 && events[after - 1]?.event_hash !== expectHead)) {
    return { status:'prefix-mismatch', detail:'journal prefix differs from the acknowledged cursor' };
  }
  const items = events.slice(after, after + limit).map((event, index) => ({ sequence:after + index + 1, event }));
  try { checkedEvents(items, after, after > 0 ? expectHead : null); }
  catch (error) { return { status:'unavailable', detail:error.message }; }
  const next = after + items.length;
  return { status:'ok', genesis:events[0]?.event_hash ?? null, events:items, next, head:items.length ? items.at(-1).event.event_hash : (after ? expectHead : null),
    hasMore:next < events.length, eventCount:events.length, legacy:true };
}

// ---------------------------------------------------------------------------------------------
// Projection through the existing Portal allowlist
// ---------------------------------------------------------------------------------------------
function status(value) {
  return STATUSES.has(value) ? value : 'UNKNOWN';
}

function omit(omitted, reason, count = 1) {
  omitted.total += count;
  omitted.byReason[reason] = (omitted.byReason[reason] || 0) + count;
}

// Coverage contract: every source event is either represented by at least one item or counted
// once in `omitted` (by event); items dropped from represented events are counted in `partial`.
export function projectJournalEvents(items) {
  const out = [];
  const omitted = { total:0, byReason:{} };
  const partial = { total:0, byReason:{} };
  for (const { sequence, event } of items) {
    const type = String(event.event_type || '');
    const base = { sequence, eventId:event.event_id, eventHash:event.event_hash, declaredAt:String(event.timestamp || '') };
    const emitted = [];
    const dropped = [];
    let reason = null;
    const subjectId = portalContinuityIdentity(event.subject?.id);
    const relations = (list) => {
      for (const relation of Array.isArray(list) ? list : []) {
        const predicate = portalContinuityIdentity(relation?.predicate);
        const target = portalContinuityIdentity(relation?.target?.id);
        if (!predicate || !target) { dropped.push('sensitive-identity'); continue; }
        emitted.push({ type:'relation', ...base, predicate, sourceId:subjectId, sourceKind:entityKind(event.subject?.kind), targetId:target,
          targetKind:entityKind(relation?.target?.kind), status:status(relation.epistemic_status || event.epistemic_status) });
      }
    };
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(base.declaredAt)) reason = 'invalid-source-time';
    else if (DECLARATIONS.has(type) && event.subject?.kind === DECLARATIONS.get(type)) {
      if (!subjectId) reason = 'sensitive-identity';
      else {
        emitted.push({ type:'assertion', ...base, entity:{ kind:event.subject.kind, id:subjectId, status:status(event.epistemic_status),
          label:redactPortalText(event.subject?.label || '', 240) || null } });
        relations(event.relations);
      }
    } else if (CONFIRMATIONS.has(type) && event.subject?.kind === CONFIRMATIONS.get(type) && event.epistemic_status === 'DECLARED') {
      const assertionEventId = event.payload?.source_event_id;
      const text = redactPortalText(event.payload?.reason || '', 240);
      if (!subjectId) reason = 'sensitive-identity';
      else if (!EVENT_ID.test(String(assertionEventId)) || assertionEventId === event.event_id || !text) reason = 'invalid-confirmation';
      else emitted.push({ type:'confirmation', ...base, entity:{ kind:event.subject.kind, id:subjectId }, assertionEventId, reason:text });
    } else if (type === 'relation.declared') {
      if (!subjectId) reason = 'sensitive-identity';
      else { relations(event.relations); if (!emitted.length && !dropped.length) reason = 'unsupported-relation'; }
    } else {
      // Other lifecycle transitions, Proof/Debt/Git/code events and payload text are not part of the
      // representable categories; they are counted, never silently dropped.
      reason = `unsupported-${type.split('.')[0].replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'unknown'}`;
    }
    if (emitted.length) {
      out.push(...emitted);
      for (const item of dropped) omit(partial, item);
    } else {
      omit(omitted, reason || dropped[0] || 'unsupported-unknown');
    }
  }
  return { items:out, omitted, partial };
}

function scanPage(value, key = 'root') {
  if (PORTAL_FORBIDDEN_KEYS.has(key)) throw memoryError('IDLEPROOF_PORTAL_MEMORY_UNSAFE', `Forbidden memory page field: ${key}`);
  if (Array.isArray(value)) return value.forEach((item) => scanPage(item, key));
  if (value && typeof value === 'object') { for (const [child, item] of Object.entries(value)) scanPage(item, child); return; }
  if (typeof value === 'string' && PORTAL_SECRET_PATTERNS.some((pattern) => { pattern.lastIndex = 0; return pattern.test(value); })) {
    throw memoryError('IDLEPROOF_PORTAL_MEMORY_UNSAFE', 'Memory page contains a secret-like value.');
  }
}

export function sealMemoryPage(page) {
  const stable = { ...page };
  delete stable.generatedAt;
  delete stable.pageId;
  return { ...page, pageId:`ipmpg_${portalDigest(portalCanonical(stable)).slice(0, 24)}` };
}

export function assertPortalMemoryPageSafe(page) {
  scanPage(page);
  if (page?.schema !== MEMORY_PAGE_SCHEMA || sealMemoryPage(page).pageId !== page.pageId) throw memoryError('IDLEPROOF_PORTAL_MEMORY_UNSAFE', 'Memory page identity does not match its content.');
  if (!Array.isArray(page.items) || page.items.length > MAX_PAGE_ITEMS) throw memoryError('IDLEPROOF_PORTAL_MEMORY_UNSAFE', 'Memory page exceeds its item bound.');
  if (Buffer.byteLength(JSON.stringify(page), 'utf8') > MAX_PAGE_BYTES) throw memoryError('IDLEPROOF_PORTAL_MEMORY_UNSAFE', 'Memory page exceeds the 64 KiB wire bound.');
  const represented = new Set(page.items.map((item) => item.sequence)).size;
  if (represented + page.omitted.total !== page.range.to - page.range.from) throw memoryError('IDLEPROOF_PORTAL_MEMORY_UNSAFE', 'Memory page does not account for every source event in its range.');
  return true;
}

function composePage({ binding, journal, epoch, after, prefixHash, events }) {
  const projected = projectJournalEvents(events);
  const last = events.at(-1);
  return sealMemoryPage({
    schema:MEMORY_PAGE_SCHEMA, pageId:'', generatedAt:new Date().toISOString(),
    project:{ localId:binding.localProjectId, repositoryFingerprint:binding.repositoryFingerprint },
    stream:{ kind:'core-project-events', journal, epoch },
    range:{ from:after, to:last.sequence, prefixHash:after === 0 ? null : prefixHash, headHash:last.event.event_hash },
    items:projected.items, omitted:projected.omitted, partial:projected.partial,
    privacy:{ sourceCodeIncluded:false, rawDiffIncluded:false, rawAgentEventsIncluded:false, rawPromptIncluded:false, rawCommandsIncluded:false, secretsRedacted:true }
  });
}

const fits = (page) => page.items.length <= MAX_PAGE_ITEMS && Buffer.byteLength(JSON.stringify(page), 'utf8') <= MAX_PAGE_BYTES;

// Largest event prefix whose projection fits the wire bounds. A single oversize event keeps its
// first items and counts the remainder as explicit page-limit omissions.
export function buildMemoryPage({ binding, journal, epoch, after, prefixHash, events }) {
  if (!events.length) return null;
  let low = 1, high = events.length, best = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const page = composePage({ binding, journal, epoch, after, prefixHash, events:events.slice(0, mid) });
    if (fits(page)) { best = page; low = mid + 1; } else high = mid - 1;
  }
  if (best) return best;
  const page = composePage({ binding, journal, epoch, after, prefixHash, events:events.slice(0, 1) });
  while (page.items.length && !fits(sealMemoryPage(page))) {
    page.items.pop();
    if (page.items.length) omit(page.partial, 'page-limit');
    else { page.partial = { total:0, byReason:{} }; omit(page.omitted, 'page-limit'); } // wholly omitted now
  }
  const sealed = sealMemoryPage(page);
  if (!fits(sealed)) throw memoryError('IDLEPROOF_PORTAL_MEMORY_UNSAFE', 'A single journal event cannot fit a memory page.');
  return sealed;
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------
// The 16 KiB bound applies while reading: a declared oversized body is refused unread, and a body
// stream is abandoned as soon as it exceeds the bound, so a bad response cannot exhaust memory.
async function boundedJson(response) {
  const tooLarge = () => memoryError('IDLEPROOF_PORTAL_RESPONSE_TOO_LARGE', 'Portal response exceeded 16 KiB.');
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    try { await response.body?.cancel?.(); } catch {}
    throw tooLarge();
  }
  let text;
  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        throw tooLarge();
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    // Doubles without a body stream; the bound is then checked after the fact.
    text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw tooLarge();
  }
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

export function validateMemoryAck(value, page) {
  const fail = (message) => { throw memoryError('IDLEPROOF_PORTAL_MEMORY_ACK_INVALID', message); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Memory ack must be an object.');
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'admitted,cursor,pageId,range,schema,status,stream') fail('Memory ack has unexpected fields.');
  if (value.schema !== MEMORY_ACK_SCHEMA || !['accepted', 'duplicate'].includes(value.status)) fail('Memory ack schema/status is invalid.');
  if (value.pageId !== page.pageId) fail('Portal acknowledged a different memory page.');
  if (value.stream?.journal !== page.stream.journal || value.stream?.epoch !== page.stream.epoch) fail('Portal acknowledged a different memory stream.');
  if (value.range?.from !== page.range.from || value.range?.to !== page.range.to) fail('Portal acknowledged a different range.');
  const next = value.cursor?.next;
  if (!Number.isSafeInteger(next) || next < page.range.to || !HASH.test(String(value.cursor?.headHash || ''))) fail('Memory ack cursor is invalid.');
  if (value.status === 'accepted' && (next !== page.range.to || value.cursor.headHash !== page.range.headHash)) fail('Accepted memory ack does not bind this page head.');
  if (next === page.range.to && value.cursor.headHash !== page.range.headHash) fail('Memory ack head differs from this page.');
  return { status:value.status, next, headHash:value.cursor.headHash };
}

async function probeCapabilities(endpoint, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(endpoint, { method:'GET', headers:{ accept:'application/json' }, signal:controller.signal });
    const body = await boundedJson(response);
    if (!response.ok) return { ok:false, reason:`HTTP_${response.status}`, transient:response.status === 429 || response.status >= 500 };
    return body?.memoryPages === MEMORY_PAGE_SCHEMA && body?.memoryAck === MEMORY_ACK_SCHEMA
      ? { ok:true } : { ok:false, reason:'SERVER_WITHOUT_MEMORY_PAGES' };
  } catch (error) {
    return { ok:false, reason:error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', transient:true };
  } finally { clearTimeout(timer); }
}

function updateState(cwd, mutate) {
  return withMemoryLock(cwd, () => {
    const current = readPortalMemoryState(cwd);
    const next = mutate(current);
    return next ? writeState(cwd, next) : current;
  });
}

// Adopt a server cursor only when the local journal proves the identical prefix at that point.
function verifiedCursor(cwd, cursor, timeoutMs, runner) {
  if (!cursor || !Number.isSafeInteger(cursor.next) || cursor.next < 0) return false;
  if (cursor.next === 0) return cursor.headHash === null || cursor.headHash === undefined;
  if (!HASH.test(String(cursor.headHash || ''))) return false;
  return readJournalPage(cwd, { after:cursor.next, expectHead:cursor.headHash, limit:1, timeoutMs, runner }).status === 'ok';
}

export async function syncPortalMemory(cwd = process.cwd(), { fetchImpl = globalThis.fetch, timeoutMs = 5000, maxPages = 25, pageEvents = DEFAULT_PAGE_EVENTS, failpoint = null, coreRunner = null } = {}) {
  let config;
  try { config = readPortalConfig(cwd); } catch (error) { return { configured:false, ok:false, status:'config-invalid', errorCode:error.code }; }
  if (!config?.enabled) return { configured:false, ok:true, status:'not-configured', pagesSent:0 };
  if (typeof fetchImpl !== 'function') throw memoryError('IDLEPROOF_PORTAL_FETCH_UNAVAILABLE', 'This Node runtime does not provide fetch().');
  const binding = currentBinding(cwd, config);
  if (!binding.repositoryFingerprint) return { configured:true, ok:false, status:'source-unavailable', errorCode:'REPOSITORY_FINGERPRINT_UNAVAILABLE', pagesSent:0 };

  if (!sameConfig(cwd, config)) return { configured:true, ok:false, status:'superseded', errorCode:'CONFIG_CHANGED', pagesSent:0 };
  let state = updateState(cwd, (current) => {
    if (current && sameBinding(current, binding)) return null;
    if (!sameConfig(cwd, config)) return null;
    // A different endpoint/enrollment/repository is a different server stream. The old cursor is
    // kept for inspection but never reused.
    return { ...freshState(binding), previous:current ? { endpoint:current.endpoint, enrollment:current.enrollment ?? null, journal:current.journal, epoch:current.epoch, next:current.next, status:current.status } : null };
  });
  // Every update after the binding step is conditional on the state still belonging to this
  // request's enrollment (and, after network I/O, to this page's stream). A concurrent
  // re-enrollment or resync makes a late ack or error inert instead of advancing the new cursor.
  // Updates after local journal I/O also require the exact cursor the read started from, so a
  // concurrent `portal memory resync` (new epoch) or another sync's progress is never undone.
  const guarded = (owns, mutate) => {
    let applied = false;
    const next = updateState(cwd, (current) => {
      if (!owns(current) || !sameConfig(cwd, config)) return null;
      applied = true;
      return mutate(current);
    });
    return applied ? next : null;
  };
  const bound = (mutate) => guarded((current) => Boolean(current) && sameBinding(current, binding), mutate);
  const ownsStream = (current, page) => Boolean(current) && sameBinding(current, binding)
    && current.journal === page.stream.journal && current.epoch === page.stream.epoch;
  const streamBound = (page, mutate) => guarded((current) => ownsStream(current, page), mutate);
  // A failure of a request applies only while this request's page is still the pending one: if
  // another process acknowledged it (or replaced it) meanwhile, the failure is stale.
  const pageBound = (page, mutate) => guarded((current) => ownsStream(current, page) && current.pending?.pageId === page.pageId, mutate);
  const cursorView = (current) => ({ journal:current.journal, epoch:current.epoch, next:current.next, headHash:current.headHash ?? null });
  const ownsCursor = (current, view) => Boolean(current) && sameBinding(current, binding) && current.journal === view.journal
    && current.epoch === view.epoch && current.next === view.next && (current.headHash ?? null) === view.headHash;
  const cursorBound = (view, mutate) => guarded((current) => ownsCursor(current, view), mutate);
  const superseded = () => ({ configured:true, ok:false, status:'superseded', errorCode:sameConfig(cwd, config) ? 'CURSOR_SUPERSEDED' : 'CONFIG_CHANGED', pagesSent, acknowledged });
  let pagesSent = 0;
  let acknowledged = 0;
  // The first binding is skipped when the configuration changed while waiting for the lock.
  if (!state || !sameBinding(state, binding)) return superseded();
  if (['reset-required', 'identity-conflict'].includes(state.status)) {
    return { configured:true, ok:false, status:state.status, errorCode:state.statusCode, next:state.next, pagesSent:0, pending:Boolean(state.pending) };
  }

  const capability = await probeCapabilities(config.endpoint, fetchImpl, timeoutMs);
  if (!capability.ok) {
    state = bound((current) => ({ ...current, status:capability.transient ? current.status : 'server-incompatible', statusCode:capability.reason }));
    if (!state) return superseded();
    return { configured:true, ok:false, degraded:!capability.transient, status:capability.transient ? 'deferred' : 'server-incompatible', errorCode:capability.reason, next:state.next, pagesSent:0, pending:Boolean(state.pending) };
  }
  if (state.status === 'server-incompatible') state = bound((current) => ({ ...current, status:'active', statusCode:null }));
  if (!state) return superseded();

  for (let round = 0; round < maxPages; round += 1) {
    if (!state || !sameBinding(state, binding) || !sameConfig(cwd, config)) return superseded();
    const view = cursorView(state);
    let page = state.pending;
    if (page) {
      // A restored page gets the same safety checks as a new one and must continue this cursor.
      let valid = true;
      try { assertPortalMemoryPageSafe(page); } catch { valid = false; }
      valid = valid && page.stream?.journal === state.journal && page.stream?.epoch === state.epoch
        && page.range?.from === state.next && (page.range?.prefixHash ?? null) === state.headHash
        && page.project?.localId === binding.localProjectId && page.project?.repositoryFingerprint === binding.repositoryFingerprint;
      if (!valid) {
        state = cursorBound(view, (current) => current.pending?.pageId === page.pageId ? { ...current, status:'reset-required', statusCode:'PENDING_PAGE_INVALID' } : null);
        if (!state) return superseded();
        return { configured:true, ok:false, status:'reset-required', errorCode:'PENDING_PAGE_INVALID', next:state.next, pagesSent, acknowledged, pending:true };
      }
    }
    if (!page) {
      const source = readJournalPage(cwd, { after:state.next, expectHead:state.headHash, limit:pageEvents, timeoutMs, runner:coreRunner });
      if (source.status === 'prefix-mismatch') {
        const origin = readJournalPage(cwd, { after:0, limit:1, timeoutMs, runner:coreRunner });
        const code = origin.status === 'ok' && state.journal && origin.genesis && `dwjrn_${origin.genesis}` !== state.journal
          ? 'JOURNAL_IDENTITY_CHANGED' : 'LOCAL_PREFIX_DIVERGED';
        state = cursorBound(view, (current) => ({ ...current, status:'reset-required', statusCode:code }));
        if (!state) return superseded();
        return { configured:true, ok:false, status:'reset-required', errorCode:code, next:state.next, pagesSent, acknowledged };
      }
      if (source.status !== 'ok') {
        state = cursorBound(view, (current) => ({ ...current, statusCode:source.status === 'unsupported' ? 'SOURCE_HISTORY_UNAVAILABLE' : 'SOURCE_UNAVAILABLE' }));
        if (!state) return superseded();
        return { configured:true, ok:false, degraded:source.status === 'unsupported', status:'source-unavailable', errorCode:state.statusCode, detail:source.detail, next:state.next, pagesSent, acknowledged };
      }
      const journal = source.genesis ? `dwjrn_${source.genesis}` : null;
      // Only an empty page means "nothing new". Events without a journal identity are an invalid
      // source, never a reason to skip them.
      if (source.events.length && !journal) {
        state = cursorBound(view, (current) => ({ ...current, statusCode:'SOURCE_JOURNAL_IDENTITY_MISSING' }));
        if (!state) return superseded();
        return { configured:true, ok:false, status:'source-unavailable', errorCode:'SOURCE_JOURNAL_IDENTITY_MISSING', next:state.next, pagesSent, acknowledged };
      }
      if (!source.events.length) {
        // "Up to date" is a claim about this enrollment's cursor: it must still be the one the read
        // started from, under the same configuration.
        if (state.statusCode) {
          state = cursorBound(view, (current) => ({ ...current, statusCode:null }));
          if (!state) return superseded();
        } else if (!ownsCursor(readPortalMemoryState(cwd), view) || !sameConfig(cwd, config)) return superseded();
        return { configured:true, ok:true, status:'up-to-date', next:state.next, pagesSent, acknowledged };
      }
      if (state.journal && state.journal !== journal) {
        state = cursorBound(view, (current) => ({ ...current, status:'reset-required', statusCode:'JOURNAL_IDENTITY_CHANGED' }));
        if (!state) return superseded();
        return { configured:true, ok:false, status:'reset-required', errorCode:'JOURNAL_IDENTITY_CHANGED', next:state.next, pagesSent, acknowledged };
      }
      page = buildMemoryPage({ binding, journal, epoch:state.epoch, after:state.next, prefixHash:state.headHash, events:source.events });
      assertPortalMemoryPageSafe(page);
      // The page was built for this exact cursor (journal, epoch, position, prefix); if anything moved
      // meanwhile, re-read instead of storing a page for a stream that no longer exists.
      const stored = cursorBound(view, (current) => current.pending ? null : { ...current, journal, pending:page });
      state = stored || readPortalMemoryState(cwd);
      if (state?.pending?.pageId !== page.pageId) continue;
    }
    if (failpoint === 'before-send') throw memoryError('IDLEPROOF_TEST_FAILPOINT', 'failpoint before-send');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    // The configuration check and the request initiation happen under the lock that
    // `portal configure`/`portal disconnect` take: a committed change is either seen here, or it
    // waits until this request has been started. No page is started with a replaced token.
    const initiated = withMemoryLock(cwd, () => {
      if (!sameConfig(cwd, config) || !ownsStream(readPortalMemoryState(cwd), page)) return null;
      try {
        return Promise.resolve(fetchImpl(config.endpoint, { method:'POST', headers:{ 'content-type':'application/json', authorization:`Bearer ${config.token}` },
          body:JSON.stringify(page), signal:controller.signal }));
      } catch (error) { return Promise.reject(error); }
    });
    if (!initiated) { clearTimeout(timer); return superseded(); }
    let response;
    let body;
    try {
      response = await initiated;
      body = await boundedJson(response);
    } catch (error) {
      clearTimeout(timer);
      const errorCode = error?.name === 'AbortError' ? 'TIMEOUT' : error?.code === 'IDLEPROOF_PORTAL_RESPONSE_TOO_LARGE' ? error.code : 'NETWORK_ERROR';
      state = pageBound(page, (current) => ({ ...current, statusCode:errorCode }));
      if (!state) return superseded();
      return { configured:true, ok:false, status:'deferred', errorCode, next:state.next, pagesSent:pagesSent + 1, acknowledged, pending:true };
    }
    clearTimeout(timer);
    pagesSent += 1;
    if (!ownsStream(readPortalMemoryState(cwd), page)) return superseded();

    if ([200, 202].includes(response.status)) {
      let ack;
      try { ack = validateMemoryAck(body, page); }
      catch (error) {
        state = pageBound(page, (current) => ({ ...current, statusCode:error.code }));
        if (!state) return superseded();
        return { configured:true, ok:false, status:'deferred', errorCode:error.code, next:state.next, pagesSent, acknowledged, pending:true };
      }
      if (failpoint === 'after-ack-before-cursor') throw memoryError('IDLEPROOF_TEST_FAILPOINT', 'failpoint after-ack-before-cursor');
      let target = { next:page.range.to, headHash:page.range.headHash };
      if (ack.next > page.range.to && verifiedCursor(cwd, ack, timeoutMs, coreRunner)) target = { next:ack.next, headHash:ack.headHash };
      const acked = streamBound(page, (current) => current.pending?.pageId === page.pageId
        ? { ...current, next:target.next, headHash:target.headHash, pending:null, status:'active', statusCode:null, lastAckAt:new Date().toISOString() }
        : null);
      if (acked) acknowledged += 1;
      // Not applied: either another process already acknowledged this page on the same stream
      // (continue from its cursor) or the stream was replaced (superseded).
      state = acked || readPortalMemoryState(cwd);
      if (!ownsStream(state, page)) return superseded();
      continue;
    }

    const code = String(body?.error?.code || `HTTP_${response.status}`);
    if (code === 'CURSOR_MISMATCH') {
      const cursor = body?.error?.cursor;
      const serverCursor = cursor && Number.isSafeInteger(cursor.next) ? { next:cursor.next, headHash:cursor.next === 0 ? null : cursor.headHash } : null;
      if (serverCursor && cursor?.stream?.journal === page.stream.journal && cursor?.stream?.epoch === page.stream.epoch && verifiedCursor(cwd, serverCursor, timeoutMs, coreRunner)) {
        state = streamBound(page, (current) => current.pending?.pageId === page.pageId
          ? { ...current, next:serverCursor.next, headHash:serverCursor.headHash, pending:null, statusCode:'CURSOR_REALIGNED' } : null)
          || readPortalMemoryState(cwd);
        continue;
      }
      state = pageBound(page, (current) => ({ ...current, status:'reset-required', statusCode:'SERVER_CURSOR_UNVERIFIABLE' }));
      if (!state) return superseded();
      return { configured:true, ok:false, status:'reset-required', errorCode:'SERVER_CURSOR_UNVERIFIABLE', next:state.next, pagesSent, acknowledged, pending:true };
    }
    if (code === 'PREFIX_DIVERGED' || code === 'IDENTITY_CONFLICT') {
      const status = code === 'IDENTITY_CONFLICT' ? 'identity-conflict' : 'reset-required';
      state = pageBound(page, (current) => ({ ...current, status, statusCode:code }));
      if (!state) return superseded();
      return { configured:true, ok:false, status, errorCode:code, next:state.next, pagesSent, acknowledged, pending:true };
    }
    const transient = response.status === 429 || response.status >= 500;
    const incompatible = !transient && ['SCHEMA_INVALID', 'INVALID_JSON', 'PAGE_ID_MISMATCH', 'METHOD_NOT_ALLOWED', 'INVALID_PAGE_SCHEMA'].includes(code);
    state = pageBound(page, (current) => ({ ...current, status:incompatible ? 'server-incompatible' : current.status, statusCode:code }));
    if (!state) return superseded();
    return { configured:true, ok:false, degraded:incompatible, status:transient ? 'deferred' : incompatible ? 'server-incompatible' : 'rejected', errorCode:code, httpStatus:response.status, next:state.next, pagesSent, acknowledged, pending:true };
  }
  return { configured:true, ok:true, status:'more-pending', next:state.next, pagesSent, acknowledged };
}

// Explicit operator action after divergence or journal replacement: start a new stream epoch from
// event 0. Portal still deduplicates facts by exact event identity.
export function resyncPortalMemory(cwd = process.cwd(), { coreRunner = null } = {}) {
  const config = readPortalConfig(cwd);
  if (!config?.enabled) return { configured:false, ok:false, status:'not-configured' };
  const binding = currentBinding(cwd, config);
  const source = readJournalPage(cwd, { after:0, limit:1, runner:coreRunner });
  if (source.status !== 'ok') return { configured:true, ok:false, status:'source-unavailable', errorCode:source.status, detail:source.detail };
  const journal = source.genesis ? `dwjrn_${source.genesis}` : null;
  if (source.events?.length && !journal) return { configured:true, ok:false, status:'source-unavailable', errorCode:'SOURCE_JOURNAL_IDENTITY_MISSING' };
  let applied = false;
  const state = updateState(cwd, (current) => {
    // A configuration replaced during the journal read wins: never restore the obsolete binding.
    if (!sameConfig(cwd, config)) return null;
    applied = true;
    const epoch = current && current.journal === journal && sameBinding(current, binding) ? current.epoch + 1 : 1;
    return { ...freshState(binding, journal, epoch), previous:current ? { journal:current.journal, epoch:current.epoch, next:current.next, status:current.status, statusCode:current.statusCode } : null };
  });
  if (!applied) return { configured:true, ok:false, status:'superseded', errorCode:'CONFIG_CHANGED' };
  return { configured:true, ok:true, status:'active', journal:state.journal, epoch:state.epoch, next:0 };
}

// Status describes the export to the Portal enrollment configured now. A cursor saved for another
// endpoint/token/repository (or after disconnect) is only reported as `retained`, never as progress.
export function portalMemoryStatus(cwd = process.cwd()) {
  const schema = 'idleproof.portal-memory-status.v1';
  let state = null;
  try { state = readPortalMemoryState(cwd); }
  catch (error) { return { schema, status:'corrupt', errorCode:error.code }; }
  let config;
  try { config = readPortalConfig(cwd); } catch (error) { return { schema, status:'config-invalid', errorCode:error.code, next:0, pending:false }; }
  const retained = state ? { journal:state.journal, epoch:state.epoch, next:state.next, status:state.status } : null;
  if (!config?.enabled) return { schema, status:'not-configured', next:0, pending:false, retained };
  if (!state) return { schema, status:'not-started', next:0, pending:false };
  if (!sameBinding(state, currentBinding(cwd, config))) {
    return { schema, status:'not-started', statusCode:'ENROLLMENT_CHANGED', next:0, pending:false, retained };
  }
  return { schema, status:state.status, statusCode:state.statusCode, journal:state.journal,
    epoch:state.epoch, next:state.next, headHash:state.headHash, pending:Boolean(state.pending), pendingPageId:state.pending?.pageId || null,
    lastAckAt:state.lastAckAt, previous:state.previous };
}
