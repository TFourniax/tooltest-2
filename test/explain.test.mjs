import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlainExplanation } from '../src/explain.mjs';

function explain({ prompt='Do the thing', file='src/odd_name.ts', symbol='doThing', route=null, table=null, technologies=[], dependencies=[], relatedFiles=[], touched=[file], concept=null, phase='implement' }={}) {
  return buildPlainExplanation({
    phase,
    concept,
    session:{ prompt, currentResource:file, touchedFiles:touched, taskSignals:{ file, symbol, route, table, technologies, dependencies, relatedFiles } }
  });
}

test('keeps the exact project filename instead of replacing it with a generic product label', () => {
  const out=explain({ file:'src/payments/weird_invoice_orchestrator_v7.py', symbol:'settle_pending_invoice' });
  assert.match(out.doing,/weird_invoice_orchestrator_v7\.py/);
  assert.match(out.project,/weird_invoice_orchestrator_v7\.py/);
  assert.equal(out.files[0].path,'src/payments/weird_invoice_orchestrator_v7.py');
});

test('falls back without inventing a responsibility for arbitrary nomenclature', () => {
  const out=explain({ file:'src/x7/frobnicator.zzz', symbol:null });
  assert.match(out.files[0].explanation,/instead of inventing a business role/i);
  assert.equal(out.files[0].role,'core');
});

test('explains route and data surfaces using their real names', () => {
  const out=explain({ file:'backend/handlers/receive.mjs', symbol:'receiveThing', route:'/hooks/acme-v3', table:'event_inbox' });
  assert.match(out.doing,/receiveThing/);
  assert.match(out.doing,/\/hooks\/acme-v3/);
  assert.match(out.doing,/event_inbox/);
});

test('unknown libraries stay exact instead of requiring a hard-coded technology catalog', () => {
  const out=explain({ file:'src/bridge.mjs', dependencies:['@mystery/payments-v9','odd-sdk'] });
  assert.match(out.project,/@mystery\/payments-v9/);
  assert.match(out.project,/odd-sdk/);
});

test('questions are explicitly optional and explanation stands alone', () => {
  const out=explain({ concept:{ id:'concurrency' }, prompt:'Prevent two buyers from reserving the same seat', file:'src/booking/reserve.ts', symbol:'reserveSeat' });
  assert.equal(out.optionalCheck,true);
  assert.match(out.why,/same time|sequential|overlap|timing/i);
  assert.match(out.doing,/reserveSeat/);
  assert.ok(out.watch.length>0);
});

test('explains each observed touched file from its own facts', () => {
  const out=explain({
    prompt:'Receive a widget and store its event',
    file:'src/odd/entry.go', symbol:'ReceiveWidget', touched:['src/odd/entry.go','src/odd/storage.py'],
    relatedFiles:[
      {file:'src/odd/entry.go',symbol:'ReceiveWidget',route:null,table:null,technologies:[],dependencies:[]},
      {file:'src/odd/storage.py',symbol:'save_widget',route:null,table:'widget_events',technologies:[],dependencies:[]}
    ]
  });
  assert.match(out.project,/src\/odd\/entry\.go/);
  assert.match(out.project,/ReceiveWidget/);
  assert.match(out.project,/src\/odd\/storage\.py/);
  assert.match(out.project,/save_widget/);
  assert.match(out.project,/widget_events/);
});

const CASES = [
  ['auth','src/security/permit.ts'], ['sql','src/db/customer_repo.py'], ['migration','db/migrations/2026_add_org.sql'],
  ['async','src/jobs/reconcile-worker.ts'], ['react-state','src/screens/CheckoutPanel.tsx'], ['typescript','src/contracts/order.types.ts'],
  ['testing','tests/test_checkout.py'], ['secrets','src/config/runtime-config.ts'], ['http','src/routes/incoming-event.ts'],
  ['packages','package.json'], ['git','src/core/feature.ts'], ['ci','.github/workflows/release.yml'],
  ['concurrency','src/booking/reserve.ts'], ['accessibility','src/components/Dialog.tsx'], ['cache','src/cache/profile-store.ts']
];
for (const [id,file] of CASES) {
  test(`plain explanation covers ${id} without depending on a bespoke business template`, () => {
    const out=explain({ concept:{id}, file, prompt:`Change behavior for ${file.split('/').at(-1)}` });
    assert.equal(out.schema,'idleproof.explanation.v1');
    assert.ok(out.doing.length>40);
    assert.ok(out.project.includes(`\`${file}\``));
    assert.ok(out.why.length>40);
    assert.ok(out.certainty.limitations.length>=3);
  });
}
