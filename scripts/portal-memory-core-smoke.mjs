// Real public-CLI interoperability of the paged Portal memory export. Requires DiffWitness Core on
// PATH. MACHINE only; it exercises the real journal source, not a Portal server.
//   node scripts/portal-memory-core-smoke.mjs            # Core with `dw state events --after`
//   node scripts/portal-memory-core-smoke.mjs --legacy   # older Core: complete-journal fallback only
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadContinuityContext } from '../src/continuity.mjs';
import { __portalTest } from '../src/portal-snapshot.mjs';
import { buildMemoryPage, projectJournalEvents, readJournalPage } from '../src/portal-memory-sync.mjs';

const legacy = process.argv.includes('--legacy');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-memory-core-'));
const run = (command, args) => execFileSync(command, args, { cwd:root, encoding:'utf8', windowsHide:true, timeout:30000, stdio:['ignore', 'pipe', 'pipe'] });
try {
  run('git', ['init', '-q']); run('git', ['config', 'user.name', 'Memory Smoke']); run('git', ['config', 'user.email', 'memory@example.test']);
  fs.writeFileSync(path.join(root, 'refund.py'), 'def refund(value):\n    return value\n');
  run('git', ['add', '.']); run('git', ['commit', '-qm', 'base']);
  run('dw', ['task', 'add', 'Refund safety', '--id', 'TASK-REFUND', '--why', 'PRIVATE WHY TEXT']);
  run('dw', ['objective', 'add', 'Refunds are idempotent', '--id', 'OBJ-IDEMPOTENT']);
  run('dw', ['decision', 'record', 'Retry with a key', '--id', 'DEC-RETRY', '--why', 'PRIVATE WHY TEXT']);
  run('dw', ['decision', 'confirm', 'DEC-RETRY', '--reason', 'Reviewed current refund policy']);
  run('dw', ['invariant', 'add', 'Never refund twice', '--id', 'INV-ONCE']);
  run('dw', ['failed-approach', 'record', 'Client-side dedupe', '--id', 'FA-CLIENT', '--reason', 'Races across tabs']);
  run('dw', ['relation', 'add', 'DEC-RETRY', 'motivated_by', 'OBJ-IDEMPOTENT']);
  for (let index = 0; index < 7; index += 1) run('dw', ['decision', 'record', `Historic choice ${index}`, '--id', `DEC-HIST-${index}`]);

  const whole = readJournalPage(root, { after:0, limit:500 });
  assert.equal(whole.status, 'ok', `real Core journal page: ${whole.detail || ''}`);
  if (legacy) assert.equal(whole.legacy, true, 'older Core must be detected and used only as a complete journal');
  const total = whole.events.length;
  assert.ok(total >= 13);

  // Page through with a tiny page size: every event exactly once, contiguous, anchored.
  const seen = [];
  let after = 0; let head = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = readJournalPage(root, { after, expectHead:head, limit:2 });
    assert.equal(page.status, 'ok');
    if (!page.events.length) break;
    seen.push(...page.events.map((item) => item.event.event_id));
    after = page.next; head = page.head;
  }
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total);
  const wrong = readJournalPage(root, { after:2, expectHead:'0'.repeat(64), limit:2 });
  assert.equal(wrong.status, 'prefix-mismatch', 'a different prefix fails closed');

  const { items, omitted } = projectJournalEvents(whole.events);
  const serialized = JSON.stringify(items);
  assert.ok(!serialized.includes('PRIVATE WHY TEXT'), 'payload text is never projected');
  const assertionIds = new Map(items.filter((item) => item.type === 'assertion').map((item) => [item.eventId, item.entity]));
  for (const id of ['TASK-REFUND', 'OBJ-IDEMPOTENT', 'DEC-RETRY', 'INV-ONCE', 'FA-CLIENT', 'DEC-HIST-6']) {
    assert.ok([...assertionIds.values()].some((entity) => entity.id === id), `${id} is exported`);
  }
  const confirmation = items.find((item) => item.type === 'confirmation');
  assert.ok(confirmation, 'DECLARED confirmation is exported');
  assert.equal(assertionIds.get(confirmation.assertionEventId)?.id, 'DEC-RETRY', 'confirmation cites the exact assertion event');
  assert.ok(items.some((item) => item.type === 'relation' && item.predicate === 'motivated_by' && item.sourceId === 'DEC-RETRY' && item.sourceKind === 'decision' && item.targetId === 'OBJ-IDEMPOTENT' && item.targetKind === 'objective'));
  assert.equal(new Set(items.map((item) => item.sequence)).size + omitted.total, total, 'every event is represented or counted exactly once');

  // Cross-path identity: a snapshot citation and the page occurrence share event identity, kind and status.
  const context = loadContinuityContext(root, 'TASK-REFUND refund retry', { timeoutMs:5000 });
  assert.ok(context, 'real Core context admitted');
  const snapshotMemory = __portalTest.safeContinuityMemory(context);
  const kinds = { tasks:'task', objectives:'objective', decisions:'decision', invariants:'invariant', failedApproaches:'failed-approach' };
  let checked = 0;
  for (const [key, kind] of Object.entries(kinds)) for (const row of snapshotMemory[key]) {
    if (!row.source) continue;
    const entity = assertionIds.get(row.source.eventId);
    assert.ok(entity, `snapshot citation ${row.source.eventId} is present in the paged export`);
    assert.equal(entity.kind, kind); assert.equal(entity.id, row.id); assert.equal(entity.status, row.status);
    assert.equal(items.find((item) => item.eventId === row.source.eventId).eventHash, row.source.eventHash);
    checked += 1;
  }
  assert.ok(checked >= 2, 'at least two cited snapshot rows were cross-checked');

  const page = buildMemoryPage({ binding:{ localProjectId:'0'.repeat(24), repositoryFingerprint:`dwrepo_${'1'.repeat(24)}` },
    journal:`dwjrn_${whole.genesis}`, epoch:1, after:0, prefixHash:null, events:whole.events });
  assert.equal(page.range.to, total);
  console.log(JSON.stringify({ schema:'idleproof-portal-memory-core-smoke-1', classification:'MACHINE', legacy, events:total,
    items:items.length, omitted, crossCheckedCitations:checked, pageId:page.pageId }));
} finally {
  try { fs.rmSync(root, { recursive:true, force:true }); } catch {}
}
