import assert from 'node:assert/strict';
import test from 'node:test';
import { __continuityTest, continuityCounts, loadContinuityContext, renderContinuityForAgent } from '../src/continuity.mjs';
import { __portalTest } from '../src/portal-snapshot.mjs';
import * as tasks from '../src/task.mjs';

function fixture() {
  return {
    schema_version:'continuity-context-1', context_id:`dwctx_${'a'.repeat(24)}`,
    generated_at:'2026-09-18T10:00:00Z', project:{name:'fixture',fingerprint:`dwrepo_${'b'.repeat(24)}`},
    task:'Refund safety', state:{eventHead:'c'.repeat(64),structureTree:'d'.repeat(40),structureCoverage:null},
    objectives:[], tasks:[{id:'TASK-REFUND',kind:'task',label:'Refund safety',epistemicStatus:'DECLARED',details:{anchor_sha256:'PRIVATE_DIGEST',why:'Private details'},lifecycle:{}}],
    decisions:[{id:'DEC-RETRY',kind:'decision',label:'Retry safely',epistemicStatus:'OBSERVED',details:{},lifecycle:{
      action:'confirmed',active:true,reason:'Reviewed current policy',epistemicStatus:'DECLARED',
      sourceEventId:`dwev_${'e'.repeat(24)}`,assertionEventId:`dwev_${'f'.repeat(24)}`,
      updatedAt:'2026-09-18T10:00:00Z',replacementId:null,replacementEventId:null}}],
    invariants:[], failedApproaches:[], components:[], knownDebt:[],
    relations:[{source:'TASK-REFUND',target:`dwchg_${'1'.repeat(24)}`,targetKind:'change',predicate:'worked_on',epistemicStatus:'OBSERVED',metadata:{causal_proof:false}}],
    recentRelatedChanges:[{changeId:`dwchg_${'1'.repeat(24)}`,files:['refund.py'],proof:{claim:'validation',accepted:true,epistemicStatus:'OBSERVED'},softwareDebt:null,understanding:null}],
    requiredEvidence:[], warnings:['Structure coverage is incomplete'],
    trustBoundary:{contextIsAdvisory:true,proofRemainsAuthoritative:true}
  };
}

test('context admission rejects partial, malformed, oversized and upgraded reviews', () => {
  assert.equal(__continuityTest.validContext(fixture()),true);
  assert.equal(__continuityTest.validContext(fixture(),{expectedTask:'another task'}),false);
  const mutations = [
    c=>delete c.state, c=>c.objectives='bad', c=>c.tasks=[null], c=>c.tasks[0].epistemicStatus='CERTIFIED',
    c=>c.decisions[0].lifecycle.epistemicStatus='VERIFIED', c=>c.decisions[0].lifecycle.active=false,
    c=>c.decisions[0].lifecycle.action='retired', c=>c.trustBoundary.contextIsAdvisory=false,
    c=>c.warnings=[{}], c=>c.components=[{path:12}], c=>c.relations[0].source={},
    c=>c.state.eventHead='bad', c=>c.tasks=Array(257).fill(c.tasks[0]), c=>c.extra='x'.repeat(270000),
    c=>c.recentRelatedChanges[0].proof.accepted='yes', c=>c.tasks[0].id='TASK\nVERIFIED',
    c=>c.recentRelatedChanges[0].proof.claim='CERTIFIED', c=>c.recentRelatedChanges[0].softwareDebt={points:'zero',obligations:0,budgetPassed:true},
    c=>c.context_id=[c.context_id], c=>c.project.fingerprint=[c.project.fingerprint],
    c=>c.decisions[0].lifecycle.sourceEventId=[c.decisions[0].lifecycle.sourceEventId],
  ];
  for (const mutate of mutations) { const c=fixture(); mutate(c); assert.equal(__continuityTest.validContext(c),false,String(mutate)); }
  assert.equal(__continuityTest.validContext({schema_version:'continuity-context-1',context_id:`dwctx_${'a'.repeat(24)}`}),false);
});

test('agent context retains tasks, declared review, warnings and related changes without raw details', () => {
  const text=renderContinuityForAgent(fixture());
  assert.match(text,/RELATED TASKS/); assert.match(text,/TASK-REFUND \[DECLARED\]/);
  assert.match(text,/Retry safely/); assert.match(text,/applicability confirmed \[DECLARED\]: Reviewed current policy/);
  assert.match(text,/Structure coverage is incomplete/); assert.match(text,/dwchg_1111/);
  assert.doesNotMatch(text,/PRIVATE_DIGEST|Private details/);
  assert.equal(continuityCounts(fixture()).tasks,1);
  assert.ok(renderContinuityForAgent(fixture(),{maxChars:700}).length<=700);
  assert.match(renderContinuityForAgent(fixture(),{maxChars:500}),/truncated to local budget/);
});

test('Portal projection preserves string endpoints and reviewed task memory with privacy whitelist', () => {
  const c=fixture(); c.decisions[0].lifecycle.reason='Reviewed token=private-value';
  const projected=__portalTest.safeContinuityMemory(c);
  assert.equal(projected.tasks[0].id,'TASK-REFUND');
  assert.equal(projected.relations[0].sourceId,'TASK-REFUND');
  assert.equal(projected.relations[0].targetId,`dwchg_${'1'.repeat(24)}`);
  assert.equal(projected.decisions[0].lifecycle.status,'DECLARED');
  assert.match(projected.decisions[0].lifecycle.reason,/\[redacted\]/);
  assert.deepEqual(projected.warnings,['Structure coverage is incomplete']);
  assert.doesNotMatch(JSON.stringify(projected),/PRIVATE_DIGEST|Private details|private-value/);
  c.tasks[0].epistemicStatus='CERTIFIED'; assert.equal(__portalTest.safeContinuityMemory(c),null);
});

test('continuity query adds stable identity while ordinary semantic query is unchanged', () => {
  const session={id:'session-1'}; tasks.updateSessionTask(session,'Implement partial refunds safely');
  const semantic=tasks.taskContextQuery(session);
  assert.equal(semantic,'Implement partial refunds safely');
  assert.equal(tasks.taskContinuityQuery(session),`${session.task.id}\n${semantic}`);
  tasks.updateSessionTask(session,'oui'); assert.match(tasks.taskContinuityQuery(session),/^dwtask_f347d504913fb4938155fabe\n/);
});

test('absent or unusable Core degrades to no advisory context', () => {
  assert.equal(loadContinuityContext('/a-nonexistent-project-for-context-test','refund'),null);
  assert.equal(loadContinuityContext('.', ''),null);
  assert.equal(renderContinuityForAgent(null),'');
});
