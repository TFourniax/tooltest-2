import assert from 'node:assert/strict';
import test from 'node:test';
import { isExplicitTaskPivot, isWeakFollowup, stableTaskId, taskContextQuery, taskDisplayText, updateSessionTask } from '../src/task.mjs';

function session(id='session-1') {
  return { id, task:null, taskHistory:[], prompt:'' };
}

test('first substantive prompt creates a stable deterministic task id', () => {
  const value=session();
  const first=updateSessionTask(value,'Implement partial refunds safely',{sessionId:value.id,now:'2026-08-23T10:00:00Z'});
  assert.equal(first.boundary,'started');
  assert.match(value.task.id,/^dwtask_[a-f0-9]{24}$/);
  assert.equal(value.task.anchor,'Implement partial refunds safely');
  assert.equal(value.task.id,stableTaskId(value.id,1,'Implement partial refunds safely'));
  assert.equal(taskDisplayText(value),'Implement partial refunds safely');
});

test('weak confirmations cannot replace the active task', () => {
  const value=session();
  updateSessionTask(value,'Implement partial refunds safely',{sessionId:value.id});
  const id=value.task.id;
  const anchor=value.task.anchor;
  const result=updateSessionTask(value,'yes, continue',{sessionId:value.id});
  assert.equal(result.boundary,'continued');
  assert.equal(result.weakFollowup,true);
  assert.equal(value.task.id,id);
  assert.equal(value.task.anchor,anchor);
  assert.equal(value.task.latestFocus,anchor);
  assert.equal(value.task.prompts,2);
  assert.equal(taskContextQuery(value),anchor);
});

test('substantive follow-up becomes focus without silently creating another task', () => {
  const value=session();
  updateSessionTask(value,'Implement partial refunds safely',{sessionId:value.id});
  const id=value.task.id;
  const result=updateSessionTask(value,'Now make the refund retry path idempotent in payments',{sessionId:value.id});
  assert.equal(result.boundary,'focused');
  assert.equal(value.task.id,id);
  assert.equal(value.task.anchor,'Implement partial refunds safely');
  assert.match(taskContextQuery(value),/Primary task: Implement partial refunds safely/);
  assert.match(taskContextQuery(value),/Current focus: Now make the refund retry path idempotent in payments/);
});

test('explicit task pivot closes the old task and creates a new identity', () => {
  const value=session();
  updateSessionTask(value,'Implement partial refunds safely',{sessionId:value.id,now:'2026-08-23T10:00:00Z'});
  const first=value.task.id;
  const result=updateSessionTask(value,'New task: add export CSV support',{sessionId:value.id,now:'2026-08-23T10:05:00Z'});
  assert.equal(result.boundary,'pivoted');
  assert.notEqual(value.task.id,first);
  assert.equal(value.task.ordinal,2);
  assert.equal(value.taskHistory.length,1);
  assert.equal(value.taskHistory[0].id,first);
  assert.equal(value.taskHistory[0].completedAt,'2026-08-23T10:05:00Z');
});

test('task boundary classifier is conservative in French and English', () => {
  assert.equal(isWeakFollowup('oui'),true);
  assert.equal(isWeakFollowup('corrige ça'),true);
  assert.equal(isWeakFollowup('please change the payments retry algorithm'),false);
  assert.equal(isExplicitTaskPivot('Passons à la page de facturation'),true);
  assert.equal(isExplicitTaskPivot('New task: add CSV export'),true);
  assert.equal(isExplicitTaskPivot('Continue with the refund tests'),false);
});
