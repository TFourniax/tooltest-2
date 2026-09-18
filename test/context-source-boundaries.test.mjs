import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractTaskSignals } from '../src/context.mjs';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-context-source-')));
  const cwd = path.join(base, 'project'), outside = path.join(base, 'outside');
  fs.mkdirSync(cwd); fs.mkdirSync(outside);
  t.after(() => fs.rmSync(base, {recursive:true, force:true}));
  return {cwd, outside};
}
const link = (target, alias) => fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
const inspect = (cwd, file) => extractTaskSignals(cwd, {currentResource:file, prompt:'Inspect source'});

test('task signals reject external and excluded-state source aliases', (t) => {
  const {cwd, outside} = fixture(t);
  fs.writeFileSync(path.join(outside, 'source.js'), "export function privateOutside() {}\nexport const route='/api/private-outside';");
  link(outside, path.join(cwd, 'linked'));
  assert.equal(inspect(cwd, 'linked/source.js').symbol, null);
  assert.equal(inspect(cwd, 'linked/source.js').route, null);
  fs.mkdirSync(path.join(cwd, '.idleproof'));
  fs.writeFileSync(path.join(cwd, '.idleproof', 'state.js'), 'export function privateState() {}');
  link(path.join(cwd, '.idleproof'), path.join(cwd, 'state-alias'));
  assert.equal(inspect(cwd, 'state-alias/state.js').symbol, null);
});

test('invalid UTF-8 cannot produce task symbols', (t) => {
  const {cwd} = fixture(t);
  fs.writeFileSync(path.join(cwd, 'invalid.js'), Buffer.concat([Buffer.from('export function invalidSource() {} //'), Buffer.from([0xff])]));
  assert.equal(inspect(cwd, 'invalid.js').symbol, null);
});

test('same size and mtime cannot reuse facts from different source bytes', (t) => {
  const {cwd} = fixture(t);
  const file = path.join(cwd, 'changed.js');
  const stamp = new Date('2020-01-01T00:00:00Z');
  fs.writeFileSync(file, 'export function beforeEdit() {}');
  fs.utimesSync(file, stamp, stamp);
  assert.equal(inspect(cwd, 'changed.js').symbol, 'beforeEdit');
  fs.writeFileSync(file, 'export function after_Edit() {}');
  fs.utimesSync(file, stamp, stamp);
  assert.equal(inspect(cwd, 'changed.js').symbol, 'after_Edit');
});

test('caller mutation cannot poison later cached signal extraction', (t) => {
  const {cwd} = fixture(t);
  fs.writeFileSync(path.join(cwd, 'source.js'), 'export function realSymbol() {}');
  const first = inspect(cwd, 'source.js');
  first.symbols.push('inventedSymbol');
  first.relatedFiles[0].symbol = 'inventedSymbol';
  const next = inspect(cwd, 'source.js');
  assert.equal(next.symbol, 'realSymbol');
  assert.deepEqual(next.symbols, ['realSymbol']);
  assert.equal(next.relatedFiles[0].symbol, 'realSymbol');
});

test('internal aliases stay valid and admitted labels are relative', (t) => {
  const {cwd} = fixture(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'source.js'), 'export function localSymbol() {}');
  link(path.join(cwd, 'src'), path.join(cwd, 'alias'));
  const signals = inspect(cwd, path.join(cwd, 'alias', 'source.js'));
  assert.equal(signals.file, 'alias/source.js');
  assert.equal(signals.symbol, 'localSymbol');
});

test('retargeting a cached internal alias outside the project discards its facts', (t) => {
  const {cwd, outside} = fixture(t);
  const src = path.join(cwd, 'src'), alias = path.join(cwd, 'alias');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'source.js'), 'export function inside() {}');
  fs.writeFileSync(path.join(outside, 'source.js'), 'export function outside() {}');
  link(src, alias);
  assert.equal(inspect(cwd, 'alias/source.js').symbol, 'inside');
  fs.unlinkSync(alias);
  link(outside, alias);
  assert.equal(inspect(cwd, 'alias/source.js').symbol, null);
  assert.deepEqual(inspect(cwd, 'alias/source.js').symbols, []);
});
