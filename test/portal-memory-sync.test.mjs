// Client-side rules of the paged Portal memory export. Core and Portal are test doubles here;
// the real Core CLI and the real Portal HTTP/DB stack are exercised by separate integration gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { freshState, saveState } from '../src/state.mjs';
import { writePortalConfig } from '../src/portal-client.mjs';
import { projectPaths } from '../src/paths.mjs';
import {
  assertPortalMemoryPageSafe,
  buildMemoryPage,
  portalMemoryStatus,
  projectJournalEvents,
  readJournalPage,
  resyncPortalMemory,
  sealMemoryPage,
  syncPortalMemory
} from '../src/portal-memory-sync.mjs';

const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
const ENDPOINT = 'http://127.0.0.1:8787/functions/v1/idleproof-ingest';

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-memory-sync-'));
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root'], { cwd });
  saveState(cwd, freshState(cwd));
  writePortalConfig(cwd, { endpoint:ENDPOINT, token:`ipd_${'x'.repeat(32)}` });
  return cwd;
}

function journal(specs, salt = 'j') {
  const events = [];
  let prev = null;
  specs.forEach((spec, index) => {
    const hash = sha(`${salt}:${index}:${JSON.stringify(spec)}`);
    events.push({ event_id:`dwev_${sha(`id:${salt}:${index}`).slice(0, 24)}`, event_hash:hash, prev_hash:prev,
      event_type:spec.type || 'decision.recorded', timestamp:`2026-09-01T10:${String(index % 60).padStart(2, '0')}:00Z`,
      epistemic_status:spec.status || 'DECLARED', subject:{ id:spec.id || `decision:${index}`, kind:spec.kind || 'decision', label:spec.label ?? `Decision ${index}` },
      relations:spec.relations || [], payload:spec.payload || { why:'PRIVATE RATIONALE TEXT' }, provenance:{ producer:'fixture' }, actor:{ kind:'human', id:'fixture' } });
    prev = hash;
  });
  return events;
}

// Mirrors `dw state events --after N --expect-head H --limit L --json` (project-event-page-1).
function core(events, { legacy = false } = {}) {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
    const current = typeof events === 'function' ? events() : events;
    if (args.includes('--after')) {
      if (legacy) return { ok:false, stderr:'dw state: error: unrecognized arguments: --after', code:2 };
      const after = Number(value('--after')); const limit = Number(value('--limit'));
      const head = value('--expect-head');
      if (after > current.length || (after > 0 && current[after - 1].event_hash !== head)) return { ok:false, stderr:'Memory navigation rejected: journal prefix does not match this page cursor; restart the export from event 0', code:2 };
      const page = current.slice(after, after + limit).map((event, i) => ({ sequence:after + i + 1, event }));
      const next = after + page.length;
      return { ok:true, stdout:JSON.stringify({ schema_version:'project-event-page-1', journal:{ genesisHash:current[0]?.event_hash ?? null, eventCount:current.length },
        after, events:page, next, head:next ? current[next - 1].event_hash : null, hasMore:next < current.length }) };
    }
    return { ok:true, stdout:JSON.stringify(current.slice(-Number(value('--limit') || 20))) };
  };
  runner.calls = calls;
  return runner;
}

// In-process double of the Portal page RPC cursor rules (accept / duplicate / mismatch / diverged).
function portal({ incompatible = false } = {}) {
  const streams = new Map();
  const received = [];
  const facts = new Map();
  const state = { failNext:null, loseNextResponse:false, conflictOn:null };
  const fetchImpl = async (url, init = {}) => {
    const reply = (status, body) => ({ status, ok:status < 300, text:async () => JSON.stringify(body) });
    if (init.method === 'GET') return reply(200, incompatible ? { schema:'idleproof.portal-ingest-capabilities.v1' }
      : { schema:'idleproof.portal-ingest-capabilities.v1', memoryPages:'idleproof.portal-memory-page.v1', memoryAck:'idleproof.portal-memory-ack.v1' });
    const page = JSON.parse(init.body);
    received.push(init.body);
    if (incompatible) return reply(422, { error:{ code:'SCHEMA_INVALID' } });
    if (state.failNext) { const status = state.failNext; state.failNext = null; return reply(status, { error:{ code:status === 503 ? 'PAGE_NOT_PERSISTED' : 'X' } }); }
    assert.equal(sealMemoryPage(page).pageId, page.pageId, 'client sent a page whose id matches its content');
    const key = `${page.stream.journal}:${page.stream.epoch}`;
    const stream = streams.get(key) || { next:0, head:null, pages:new Map() };
    streams.set(key, stream);
    const prior = stream.pages.get(page.range.from);
    let response;
    if (prior) {
      response = prior.pageId === page.pageId && prior.to === page.range.to
        ? reply(200, { schema:'idleproof.portal-memory-ack.v1', status:'duplicate', pageId:page.pageId, stream:page.stream && { journal:page.stream.journal, epoch:page.stream.epoch }, range:{ from:page.range.from, to:page.range.to }, cursor:{ next:stream.next, headHash:stream.head }, admitted:{ new:0, observed:0 } })
        : reply(409, { error:{ code:'CURSOR_MISMATCH', cursor:{ next:stream.next, headHash:stream.head, stream:{ journal:page.stream.journal, epoch:page.stream.epoch } } } });
    } else if (page.range.from !== stream.next) {
      response = reply(409, { error:{ code:'CURSOR_MISMATCH', cursor:{ next:stream.next, headHash:stream.head, stream:{ journal:page.stream.journal, epoch:page.stream.epoch } } } });
    } else if ((page.range.prefixHash ?? null) !== stream.head) {
      response = reply(409, { error:{ code:'PREFIX_DIVERGED', cursor:{ next:stream.next, headHash:stream.head, stream:{ journal:page.stream.journal, epoch:page.stream.epoch } } } });
    } else if (state.conflictOn && page.items.some((item) => item.eventId === state.conflictOn)) {
      response = reply(409, { error:{ code:'IDENTITY_CONFLICT' } });
    } else {
      stream.pages.set(page.range.from, { pageId:page.pageId, to:page.range.to });
      stream.next = page.range.to; stream.head = page.range.headHash;
      for (const item of page.items) facts.set(`${item.type}:${item.eventId}:${item.predicate || ''}:${item.targetId || ''}`, item);
      response = reply(202, { schema:'idleproof.portal-memory-ack.v1', status:'accepted', pageId:page.pageId, stream:{ journal:page.stream.journal, epoch:page.stream.epoch }, range:{ from:page.range.from, to:page.range.to }, cursor:{ next:stream.next, headHash:stream.head }, admitted:{ new:page.items.length, observed:0 } });
    }
    if (state.loseNextResponse) { state.loseNextResponse = false; throw Object.assign(new Error('socket hang up'), { name:'Error' }); }
    return response;
  };
  return { fetchImpl, streams, received, facts, state };
}

const cleanup = (cwd) => { try { fs.rmSync(cwd, { recursive:true, force:true }); } catch {} };

test('exports the complete retained journal in bounded pages, then only new events', async () => {
  const cwd = fixture();
  try {
    const events = journal(Array.from({ length:10 }, (_, i) => ({ id:`decision:${i}` })));
    const server = portal();
    const result = await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core(events), pageEvents:3 });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'up-to-date');
    assert.equal(result.next, 10);
    assert.equal(server.received.length, 4);
    assert.equal(server.facts.size, 10);
    assert.ok(server.received.every((body) => !body.includes('PRIVATE RATIONALE TEXT')), 'event payload text never leaves the machine');
    events.push(...journal([{ id:'decision:late' }], 'late').map((event, i) => ({ ...event, prev_hash:i === 0 ? events.at(-1).event_hash : event.prev_hash })));
    const again = await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core(events), pageEvents:3 });
    assert.equal(again.next, 11);
    assert.equal(server.received.length, 5);
    assert.equal(JSON.parse(server.received.at(-1)).range.from, 10);
  } finally { cleanup(cwd); }
});

test('a response lost after commit, a stop before send and a stop before cursor save never duplicate or skip', async () => {
  const cwd = fixture();
  try {
    const events = journal(Array.from({ length:6 }, (_, i) => ({ id:`decision:${i}` })));
    const server = portal();
    const runner = core(events);
    server.state.loseNextResponse = true;
    const lost = await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:runner, pageEvents:2 });
    assert.equal(lost.ok, false);
    assert.equal(lost.status, 'deferred');
    assert.equal(portalMemoryStatus(cwd).next, 0, 'cursor not advanced without an ack');
    assert.equal(portalMemoryStatus(cwd).pending, true);
    await assert.rejects(syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:runner, pageEvents:2, failpoint:'after-ack-before-cursor' }), /failpoint/);
    assert.equal(portalMemoryStatus(cwd).next, 0);
    const resumed = await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:runner, pageEvents:2 });
    assert.equal(resumed.next, 6);
    assert.equal(server.received[0], server.received[1], 'retransmission is byte-identical');
    assert.equal(server.received[1], server.received[2]);
    assert.equal(server.facts.size, 6, 'no logical duplicate or gap');
    await assert.rejects(syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core([...events, ...journal([{ id:'x' }], 'y').map((e) => ({ ...e, prev_hash:events.at(-1).event_hash }))]), failpoint:'before-send' }), /failpoint/);
    assert.equal(portalMemoryStatus(cwd).pending, true, 'the unsent page is durable');
  } finally { cleanup(cwd); }
});

test('transient failures, incompatible servers and identity conflicts keep unacknowledged work', async () => {
  const cwd = fixture();
  try {
    const events = journal([{ id:'decision:a' }, { id:'decision:b' }]);
    const old = portal({ incompatible:true });
    const degraded = await syncPortalMemory(cwd, { fetchImpl:old.fetchImpl, coreRunner:core(events) });
    assert.equal(degraded.status, 'server-incompatible');
    assert.equal(degraded.degraded, true);
    assert.equal(old.received.length, 0, 'no page is posted to a server that does not advertise memory pages');
    const server = portal();
    server.state.failNext = 503;
    const deferred = await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core(events) });
    assert.equal(deferred.status, 'deferred');
    assert.equal(portalMemoryStatus(cwd).next, 0);
    server.state.conflictOn = events[1].event_id;
    const conflict = await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core(events) });
    assert.equal(conflict.status, 'identity-conflict');
    const blocked = await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core(events) });
    assert.equal(blocked.status, 'identity-conflict', 'explicit state until an operator resyncs');
    assert.equal(portalMemoryStatus(cwd).pending, true);
  } finally { cleanup(cwd); }
});

test('prefix divergence and journal replacement become explicit reset states; resync starts a new epoch', async () => {
  const cwd = fixture();
  try {
    const events = journal([{ id:'decision:a' }, { id:'decision:b' }, { id:'decision:c' }]);
    const server = portal();
    await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core(events) });
    assert.equal(portalMemoryStatus(cwd).next, 3);
    const rewritten = [...events.slice(0, 2), ...journal([{ id:'decision:c2' }], 'rewrite').map((e) => ({ ...e, prev_hash:events[1].event_hash }))];
    const diverged = await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core(rewritten) });
    assert.equal(diverged.status, 'reset-required');
    assert.equal(diverged.errorCode, 'LOCAL_PREFIX_DIVERGED');
    const replaced = journal([{ id:'decision:z' }], 'other-journal');
    const resync = resyncPortalMemory(cwd, { coreRunner:core(rewritten) });
    assert.equal(resync.epoch, 2);
    const after = await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core(rewritten) });
    assert.equal(after.next, 3);
    assert.equal(portalMemoryStatus(cwd).previous.next, 3);
    const changed = await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core([...replaced, ...journal([{}], 'q').map((e) => ({ ...e, prev_hash:replaced[0].event_hash }))]) });
    assert.equal(changed.errorCode, 'JOURNAL_IDENTITY_CHANGED');
  } finally { cleanup(cwd); }
});

test('a verified server cursor is adopted after local cursor loss; an unverifiable one is not', async () => {
  const cwd = fixture();
  try {
    const events = journal(Array.from({ length:5 }, (_, i) => ({ id:`decision:${i}` })));
    const server = portal();
    await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core(events), pageEvents:2 });
    fs.rmSync(projectPaths(cwd).portalMemoryState);
    const recovered = await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core(events), pageEvents:3 });
    assert.equal(recovered.next, 5);
    assert.equal(portalMemoryStatus(cwd).statusCode, null);
    assert.equal(server.facts.size, 5);
  } finally { cleanup(cwd); }
});

test('a new enrollment never reuses a caught-up cursor from another enrollment', async () => {
  const cwd = fixture();
  try {
    const events = journal([{ id:'decision:a' }, { id:'decision:b' }]);
    const first = portal();
    assert.equal((await syncPortalMemory(cwd, { fetchImpl:first.fetchImpl, coreRunner:core(events) })).next, 2);
    writePortalConfig(cwd, { endpoint:ENDPOINT, token:`ipd_${'y'.repeat(32)}` });
    const second = portal();
    const result = await syncPortalMemory(cwd, { fetchImpl:second.fetchImpl, coreRunner:core(events) });
    assert.equal(result.next, 2);
    assert.equal(second.facts.size, 2, 'the new enrollment receives the full retained history');
    assert.ok(portalMemoryStatus(cwd).previous.enrollment.startsWith('dwenr_'));
    assert.ok(!fs.readFileSync(projectPaths(cwd).portalMemoryState, 'utf8').includes('y'.repeat(32)), 'the cursor file holds no token');
  } finally { cleanup(cwd); }
});

test('a late ack from a superseded enrollment never advances the new enrollment cursor', async () => {
  const cwd = fixture();
  try {
    const events = journal([{ id:'decision:a' }, { id:'decision:b' }]);
    const oldServer = portal();
    const newServer = portal();
    const racing = async (url, init) => {
      if (init?.method === 'POST') {
        // While the old request is in flight, the user re-enrolls and a concurrent sync prepares
        // the byte-identical page for the new enrollment, then stops before sending it.
        writePortalConfig(cwd, { endpoint:ENDPOINT, token:`ipd_${'n'.repeat(32)}` });
        await assert.rejects(syncPortalMemory(cwd, { fetchImpl:newServer.fetchImpl, coreRunner:core(events), failpoint:'before-send' }), /failpoint/);
      }
      return oldServer.fetchImpl(url, init);
    };
    const late = await syncPortalMemory(cwd, { fetchImpl:racing, coreRunner:core(events) });
    assert.equal(late.status, 'superseded');
    const status = portalMemoryStatus(cwd);
    assert.equal(status.next, 0, 'the old ack did not advance the new cursor');
    assert.equal(status.pending, true, 'the new enrollment keeps its unsent page');
    assert.equal(newServer.facts.size, 0);
    const delivered = await syncPortalMemory(cwd, { fetchImpl:newServer.fetchImpl, coreRunner:core(events) });
    assert.equal(delivered.next, 2);
    assert.equal(newServer.facts.size, 2, 'the new project receives the history');
  } finally { cleanup(cwd); }
});

test('a transient capability failure is deferred, not incompatible', async () => {
  const cwd = fixture();
  try {
    for (const status of [429, 503]) {
      const result = await syncPortalMemory(cwd, { coreRunner:core(journal([{}])), fetchImpl:async () => ({ status, ok:false, text:async () => '{}' }) });
      assert.equal(result.status, 'deferred', `HTTP ${status}`);
      assert.notEqual(portalMemoryStatus(cwd).status, 'server-incompatible');
    }
  } finally { cleanup(cwd); }
});

test('a tampered or mismatched pending page is never sent', async () => {
  const cwd = fixture();
  try {
    const events = journal([{ id:'decision:a' }, { id:'decision:b' }]);
    const server = portal();
    await assert.rejects(syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core(events), failpoint:'before-send' }), /failpoint/);
    const file = projectPaths(cwd).portalMemoryState;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.pending.items[0].entity.label = 'token=supersecretvalue1234';
    fs.writeFileSync(file, JSON.stringify(saved));
    const result = await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core(events) });
    assert.equal(result.errorCode, 'PENDING_PAGE_INVALID');
    assert.equal(server.received.length, 0);
    resyncPortalMemory(cwd, { coreRunner:core(events) });
    assert.equal((await syncPortalMemory(cwd, { fetchImpl:server.fetchImpl, coreRunner:core(events) })).next, 2, 'resync recovers explicitly');
  } finally { cleanup(cwd); }
});

test('projection keeps the allowlist: labels redacted, secret identities omitted and counted, other events counted', () => {
  const events = journal([
    { id:'decision:a', label:'Use token=supersecretvalue123 carefully', relations:[{ predicate:'motivated_by', target:{ id:'objective:x', kind:'objective' } }] },
    { id:'decision:ghp_abcdefghijklmnopqrstuvwxyz0123' },
    { type:'change.observed', kind:'change', id:'change:1' },
    { type:'decision.confirmed', id:'decision:a', payload:{ source_event_id:'dwev_'.padEnd(29, '0'), reason:'Still applies' } },
    { type:'objective.declared', kind:'objective', id:'objective:東京-🚀', label:'Unicode' }
  ]);
  const { items, omitted, partial } = projectJournalEvents(events.map((event, i) => ({ sequence:i + 1, event })));
  assert.equal(items[0].entity.label.includes('supersecret'), false);
  assert.deepEqual(items.map((item) => item.type), ['assertion', 'relation', 'confirmation', 'assertion']);
  assert.equal(items[3].entity.id, 'objective:東京-🚀');
  assert.deepEqual(omitted, { total:2, byReason:{ 'sensitive-identity':1, 'unsupported-change':1 } });
  assert.deepEqual(partial, { total:0, byReason:{} });
  // Every event is represented or counted exactly once.
  assert.equal(new Set(items.map((item) => item.sequence)).size + omitted.total, events.length);
  assert.ok(!JSON.stringify(items).includes('why'));
});

test('pages respect the 256-item and 64 KiB bounds without changing the wire limit', () => {
  const relations = Array.from({ length:200 }, (_, i) => ({ predicate:'related_to', target:{ id:`objective:${'x'.repeat(200)}:${i}`, kind:'objective' } }));
  const events = journal([{ id:'decision:big', relations }, { id:'decision:next', relations }]);
  const page = buildMemoryPage({ binding:{ localProjectId:'0'.repeat(24), repositoryFingerprint:`dwrepo_${'1'.repeat(24)}` }, journal:`dwjrn_${'a'.repeat(64)}`, epoch:1,
    after:0, prefixHash:null, events:events.map((event, i) => ({ sequence:i + 1, event })) });
  assert.equal(page.range.to, 1, 'only the event that fits is consumed');
  assert.ok(page.items.length <= 256);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 64 * 1024);
  assert.ok(page.partial.byReason['page-limit'] > 0, 'items that did not fit are counted, not silently dropped');
  assert.equal(page.omitted.total, 0, 'the consumed event is still represented');
  assertPortalMemoryPageSafe(page);
});

test('relations with a sensitive endpoint are partial drops; a wholly unrepresentable event is one omission', () => {
  const events = journal([
    { id:'decision:a', relations:[{ predicate:'affects', target:{ id:'component:ok', kind:'component' } }, { predicate:'affects', target:{ id:'ghp_abcdefghijklmnopqrstuvwxyz0123', kind:'component' } }] },
    { type:'relation.declared', id:'decision:a', relations:[{ predicate:'affects', target:{ id:'ghp_abcdefghijklmnopqrstuvwxyz0123', kind:'component' } }] }
  ]);
  const { items, omitted, partial } = projectJournalEvents(events.map((event, i) => ({ sequence:i + 1, event })));
  assert.deepEqual(items.map((item) => item.type), ['assertion', 'relation']);
  assert.deepEqual(partial, { total:1, byReason:{ 'sensitive-identity':1 } });
  assert.deepEqual(omitted, { total:1, byReason:{ 'sensitive-identity':1 } });
  const page = buildMemoryPage({ binding:{ localProjectId:'0'.repeat(24), repositoryFingerprint:`dwrepo_${'1'.repeat(24)}` }, journal:`dwjrn_${'a'.repeat(64)}`, epoch:1,
    after:0, prefixHash:null, events:events.map((event, i) => ({ sequence:i + 1, event })) });
  assertPortalMemoryPageSafe(page);
  const uncovered = sealMemoryPage({ ...page, omitted:{ total:0, byReason:{} } });
  assert.throws(() => assertPortalMemoryPageSafe(uncovered), /every source event/);
});

test('legacy Core without paging is used only when it proves the complete journal', () => {
  const cwd = fixture();
  try {
    const small = journal([{ id:'decision:a' }, { id:'decision:b' }]);
    const page = readJournalPage(cwd, { after:0, runner:core(small, { legacy:true }) });
    assert.equal(page.status, 'ok');
    assert.equal(page.events.length, 2);
    const tail = journal(Array.from({ length:3 }, () => ({}))).map((event, i) => i === 0 ? { ...event, prev_hash:'f'.repeat(64) } : event);
    assert.equal(readJournalPage(cwd, { after:0, runner:core(tail, { legacy:true }) }).status, 'unsupported');
    const broken = small.map((event, i) => i === 1 ? { ...event, prev_hash:'0'.repeat(64) } : event);
    assert.equal(readJournalPage(cwd, { after:0, runner:core(broken) }).status, 'unavailable');
  } finally { cleanup(cwd); }
});
