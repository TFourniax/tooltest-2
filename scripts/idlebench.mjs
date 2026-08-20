import assert from 'node:assert/strict';
import { presentLearningCard } from '../src/presentation.mjs';

const BASE = {
  title:'Applied concept',
  why:'This boundary matters to the change being built now.',
  lesson:'Understand the concrete failure mode before accepting the change.',
  review:'Verify the behavior with a focused test.',
  options:['Correct boundary','Unrelated styling detail','Build artifact size'],
  answer:0,
  seconds:20
};

const cases = [
  {
    name:'Stripe webhook implementation stays task-specific',
    card:{ ...BASE, id:'http', question:'fallback HTTP question', context:{ phase:'implement', target:'handleStripeWebhook', signals:{ symbol:'handleStripeWebhook', route:'/api/webhooks/stripe', technologies:['Stripe'] } } },
    session:{ status:'active', estimatedWindow:24 },
    require:[/Stripe retries/i,/webhooks\/stripe/i,/handleStripeWebhook/i,/property/i]
  },
  {
    name:'OAuth verification separates authentication from authorization',
    card:{ ...BASE, id:'auth', question:'fallback auth question', context:{ phase:'verify', target:'authorizeAdmin', signals:{ symbol:'authorizeAdmin', technologies:['OAuth'] } } },
    session:{ status:'active', estimatedWindow:20 },
    require:[/OAuth flow/i,/authentication/i,/authorization/i]
  },
  {
    name:'Migration handoff names the actual table and partial-failure concern',
    card:{ ...BASE, id:'migration', question:'fallback migration question', context:{ phase:'handoff', target:'subscriptions', signals:{ table:'subscriptions', technologies:['PostgreSQL'] } } },
    session:{ status:'complete', estimatedWindow:30 },
    require:[/subscriptions/i,/deploy|rollback/i,/halfway/i]
  },
  {
    name:'Secret handling ties the prompt to the observed stack',
    card:{ ...BASE, id:'secrets', question:'fallback secret question', context:{ phase:'implement', target:'stripeClient', signals:{ symbol:'stripeClient', technologies:['Stripe'] } } },
    session:{ status:'active', estimatedWindow:18 },
    require:[/Stripe credential/i,/secret safely exist/i]
  },
  {
    name:'Unrecognized context does not invent specialization',
    card:{ ...BASE, id:'testing', question:'Which behavior should this test demonstrate?', context:{ phase:'verify', target:'checkout', signals:{ symbol:'checkout', technologies:['UnknownStack'] } } },
    session:{ status:'active', estimatedWindow:20 },
    exact:'Which behavior should this test demonstrate?'
  }
];

let passed = 0;
for (const item of cases) {
  const presented = presentLearningCard(item.card, item.session);
  assert.ok(presented, `${item.name}: no card returned`);
  if (item.exact) assert.equal(presented.question, item.exact, `${item.name}: fallback question changed unexpectedly`);
  for (const pattern of item.require || []) assert.match(presented.question, pattern, `${item.name}: missing ${pattern}`);
  assert.ok(presented.question.length <= 240, `${item.name}: question is too long for a wait-window interaction`);
  assert.ok(presented.presentation?.depth, `${item.name}: presentation depth missing`);
  passed += 1;
}

const glance = presentLearningCard({ ...BASE, id:'testing', question:'Quick check?', context:{ phase:'verify', signals:{} } }, { status:'active', estimatedWindow:8 });
assert.equal(glance.presentation.depth, 'glance');
assert.ok(glance.seconds <= 12);

const deep = presentLearningCard({ ...BASE, id:'testing', question:'Deep check?', context:{ phase:'verify', signals:{} } }, { status:'active', estimatedWindow:50 });
assert.equal(deep.presentation.depth, 'deep');
assert.match(deep.lesson, /Next,/);

console.log(`IdleBench PASS · ${passed} contextual quality cases + wait-window depth contracts`);
