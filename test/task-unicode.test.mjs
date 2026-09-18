import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { updateSessionTask, isWeakFollowup, __taskTest } from '../src/task.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

test('native identity and digest describe the Core 12000-code-point prefix', () => {
  const prefix = '🧪'.repeat(11999) + 'é';
  const session = { id:'unicode-long' };
  updateSessionTask(session, prefix + 'excluded private suffix');
  assert.equal(session.task.anchorChars, 12000);
  assert.equal(session.task.anchorSha256, sha(prefix));
  assert.equal(session.task.id, `dwtask_${sha(`task-v1\0unicode-long\0${1}\0${sha(prefix)}`).slice(0,24)}`);
  assert.equal([...session.task.anchor].length, 1200);
  assert.equal(session.task.anchor, '🧪'.repeat(1199) + '…');
});

test('compact anchors retain whole Unicode scalars and Core whitespace semantics', () => {
  assert.equal(__taskTest.compact('a'.repeat(1198) + '🧪' + 'bc'), 'a'.repeat(1198) + '🧪…');
  assert.equal(__taskTest.compact('\u0085A\u001cB\u001fC\ufeff'), 'A B C\ufeff');
  assert.equal(isWeakFollowup('𐐀'.repeat(20)), true);
});

test('followups keep historical anchor identity while new pivots use bounded input', () => {
  const session = { id:'persisted', task:{id:'historical-task', ordinal:1, anchor:'old anchor', anchorChars:99999, anchorSha256:'old-digest', prompts:1} };
  updateSessionTask(session, 'continue');
  assert.equal(session.task.id, 'historical-task');
  assert.equal(session.task.anchorChars, 99999);
  assert.equal(session.task.anchorSha256, 'old-digest');
  updateSessionTask(session, 'Investigate ' + '🧪'.repeat(1500));
  assert.equal(session.task.latestFocusChars, 1512);
  assert.equal([...session.task.latestFocus].length, 1200);
  updateSessionTask(session, 'New task: ' + '🧪'.repeat(13000));
  assert.equal(session.task.ordinal, 2);
  assert.equal(session.task.anchorChars, 12000);
  assert.equal(session.taskHistory[0].id, 'historical-task');
});
