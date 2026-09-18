import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mutateState, loadState } from '../src/state.mjs';
import { projectPaths } from '../src/paths.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-lock-contention-'));
  t.after(() => fs.rmSync(cwd, {recursive:true, force:true}));
  return {cwd, paths:projectPaths(cwd)};
}

test('transient lock errors retry even after the previous lock entry disappeared', (t) => {
  const {cwd, paths} = fixture(t);
  const original = fs.mkdirSync;
  const codes = ['EPERM', 'EACCES', 'EBUSY'];
  let attempts = 0, mutations = 0;
  t.mock.method(fs, 'mkdirSync', function(file, ...args) {
    if (file === paths.lock && attempts++ < codes.length) {
      assert.equal(fs.existsSync(paths.lock), false);
      throw Object.assign(new Error('synthetic released-lock race'), {code:codes[attempts-1]});
    }
    return original.call(this, file, ...args);
  });
  mutateState(cwd, (state) => { mutations++; state.sessions.kept = {id:'kept'}; });
  assert.equal(attempts, 4);
  assert.equal(mutations, 1);
  assert.equal(loadState(cwd).sessions.kept.id, 'kept');
  assert.equal(fs.existsSync(paths.lock), false);
});

test('permanent lock denial fails at the unchanged deadline without mutating state', (t) => {
  const {cwd, paths} = fixture(t);
  const original = fs.mkdirSync;
  let now = 100000, mutations = 0;
  t.mock.method(Date, 'now', () => now += 1000);
  t.mock.method(fs, 'mkdirSync', function(file, ...args) {
    if (file === paths.lock) throw Object.assign(new Error('synthetic permission denial'), {code:'EACCES'});
    return original.call(this, file, ...args);
  });
  assert.throws(() => mutateState(cwd, () => { mutations++; }), /stayed busy for 15s/);
  assert.equal(mutations, 0);
  assert.equal(fs.existsSync(paths.state), false);
});

test('non-contention storage errors are not retried or turned into success', (t) => {
  const {cwd, paths} = fixture(t);
  const original = fs.mkdirSync;
  let attempts = 0;
  t.mock.method(fs, 'mkdirSync', function(file, ...args) {
    if (file === paths.lock) { attempts++; throw Object.assign(new Error('synthetic disk failure'), {code:'ENOSPC'}); }
    return original.call(this, file, ...args);
  });
  assert.throws(() => mutateState(cwd, () => assert.fail('must not mutate')), {code:'ENOSPC'});
  assert.equal(attempts, 1);
});
