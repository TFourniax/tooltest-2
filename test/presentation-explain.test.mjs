import test from 'node:test';
import assert from 'node:assert/strict';
import { presentLearningCard } from '../src/presentation.mjs';

const card={
  id:'http', title:'HTTP & API contracts', risk:3, seconds:31,
  why:'old generic why', lesson:'old generic lesson', question:'What property matters?', options:['Idempotency','Other'], answer:0,
  context:{ task:'Make receiveAcmeEvent safe when Acme retries it', phase:'implement', file:'src/odd/acme_receiver_v2.ts', target:'receiveAcmeEvent in src/odd/acme_receiver_v2.ts', signals:{ file:'src/odd/acme_receiver_v2.ts', symbol:'receiveAcmeEvent', route:'/hooks/acme-v2', table:'incoming_events', technologies:[], dependencies:['@acme/events-sdk'] } }
};

test('presentation is explanation-first and preserves an optional check',()=>{
  const out=presentLearningCard(card,{status:'active',estimatedWindow:24,touchedFiles:['src/odd/acme_receiver_v2.ts']});
  assert.equal(out.presentation.explainFirst,true);
  assert.equal(out.presentation.checkOptional,true);
  assert.match(out.why,/acme_receiver_v2\.ts/);
  assert.match(out.lesson,/incoming_events|@acme\/events-sdk/);
  assert.equal(out.explanation.optionalCheck,true);
  assert.ok(out.question);
});

test('short windows still explain before asking',()=>{
  const out=presentLearningCard(card,{status:'active',estimatedWindow:8,touchedFiles:['src/odd/acme_receiver_v2.ts']});
  assert.equal(out.presentation.depth,'glance');
  assert.match(out.why,/agent is changing/i);
  assert.ok(out.lesson.length>40);
});
