import assert from 'node:assert/strict';
import test from 'node:test';
import { detectConcepts } from '../src/analyze.mjs';
import { inferFileRole } from '../src/semantics.mjs';
import { buildPlainExplanation } from '../src/explain.mjs';
import { buildLearningJourney, selectLearningCard, sqlLessonSupported } from '../src/learning.mjs';
import { CONCEPT_BY_ID } from '../src/catalog.mjs';

function discountSession() {
  return {
    id:'codex-human-discount',
    source:'codex',
    status:'complete',
    prompt:'Implement a 10% discount for orders of 100 or more in src/cart.py. Add pytest tests for 50, 100 and 150. Do not commit.',
    currentResource:'tests/test_cart.py',
    touchedFiles:['tests/test_cart.py','src/cart.py'],
    concepts:{sql:{events:5},testing:{events:2},git:{events:1}},
    taskSignals:{
      file:'tests/test_cart.py',
      symbol:'test_order_at_discount_threshold',
      technologies:['Pytest'],
      dependencies:[],
      relatedFiles:[{
        file:'src/cart.py',symbol:'apply_discount',technologies:['Pytest'],
        dependencies:[],importReferences:[]
      }]
    }
  };
}

test('human alpha discount must never be described as SQL, persistent data, or an external integration', () => {
  const session=discountSession();
  assert.equal(sqlLessonSupported(session),false);
  assert.equal(inferFileRole('src/cart.py',{technologies:['Pytest']}).role,'core');
  assert.equal(inferFileRole('tests/test_cart.py',{technologies:['Pytest']}).role,'test');
  assert.equal(selectLearningCard({ledger:{
    sql:{exposures:8,confidence:0.1}, testing:{exposures:2,confidence:0.1},git:{exposures:1,confidence:0.2}
  }},session,'sql'),'testing');
  const journey=buildLearningJourney({ledger:{
    sql:{exposures:5,confidence:0},testing:{exposures:2,confidence:0}
  }},session);
  assert.ok(journey.concepts.some(x=>x.id==='testing'));
  assert.ok(!journey.concepts.some(x=>x.id==='sql'));

  const explanation=buildPlainExplanation({session,concept:CONCEPT_BY_ID.testing,phase:'handoff'});
  const textValue=[explanation.project,explanation.why,...explanation.watch].join(' ');
  for(const phrase of ['SQL', 'persistent data', 'transaction', 'stored data', 'another service or library', 'executable query']) {
    assert.ok(!textValue.toLowerCase().includes(phrase.toLowerCase()),`Invented ${phrase}: ${textValue}`);
  }
  assert.match(textValue,/src\/cart\.py/);
  assert.match(textValue,/apply_discount/);
  assert.match(textValue,/Pytest/);
  assert.match(textValue,/testing|test/i);
  const src=explanation.files.find(x=>x.path==='src/cart.py');
  assert.equal(src?.role,'core');
  assert.equal(src?.confidence,'low');
  assert.match(src.explanation,/responsibility is not established/);
});

test('a mere language instruction to select or update an option is not evidence of SQL', () => {
  for (const value of ['Please select the best price', 'Update the discount display', 'Insert a unit test', 'select your answer']) {
    assert.ok(!detectConcepts(value).includes('sql'),`Bad SQL inference for ${value}`);
  }
  for (const value of ['SELECT id FROM orders', 'INSERT INTO orders(id) VALUES (1)', 'UPDATE orders SET total=90', 'DELETE FROM orders', 'PostgreSQL transaction']) {
    assert.ok(detectConcepts(value).includes('sql'),`Missing SQL evidence for ${value}`);
  }
});

test('explicit SQL task remains eligible for an appropriate SQL lesson', () => {
  for(const session of [
    {prompt:'Use SQL to query orders',touchedFiles:['src/order.py'],taskSignals:{}},
    {prompt:'Fix the transaction rollback on insert',touchedFiles:['src/service.py'],taskSignals:{}},
    {prompt:'Fix the reported discount',touchedFiles:['db/migrations/2026_create_orders.sql'],taskSignals:{}},
    {prompt:'Edit schema',touchedFiles:['src/repository.py'],taskSignals:{table:'orders'}},
  ]) {
    assert.equal(sqlLessonSupported(session),true,JSON.stringify(session));
    assert.equal(selectLearningCard({ledger:{sql:{exposures:2,confidence:0.1}}},{...session,concepts:{sql:{events:2}}},'testing'),'sql');
  }
});

test('unrelated past SQL exposure is not reused for a pure Python task', () => {
  const session=discountSession(); session.concepts={};
  const selected=selectLearningCard({ledger:{sql:{exposures:9,confidence:0}}},session,'testing');
  assert.equal(selected,'testing');
});
