import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFeatureModel } from '../src/feature-model.mjs';

const LIMIT = 128 * 1024;
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-source-boundary-'));
  const cwd = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(cwd); fs.mkdirSync(outside);
  t.after(() => fs.rmSync(base, { recursive:true, force:true }));
  return { base, cwd, outside };
}
const linkDirectory = (target, alias) => fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
const modelFor = (cwd, file) => buildFeatureModel(cwd, { currentResource:file });

test('external directory aliases cannot contribute source text or import edges', (t) => {
  const { cwd, outside } = fixture(t);
  fs.writeFileSync(path.join(outside, 'private.js'), "export const route='/api/synthetic-external-marker';");
  linkDirectory(outside, path.join(cwd, 'linked'));
  fs.writeFileSync(path.join(cwd, 'entry.js'), "import './linked/private.js';");
  const imported = modelFor(cwd, 'entry.js');
  assert.deepEqual(imported.surfaces.routes, []);
  assert.deepEqual(imported.edges, []);
  assert.equal(imported.generatedFrom.filesInspected, 1);
  assert.equal(modelFor(cwd, 'linked/private.js').generatedFrom.filesInspected, 0);
});

test('internal source aliases and an aliased project root remain readable', (t) => {
  const { base, cwd } = fixture(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'ok.js'), "export const route='/api/local';");
  linkDirectory(path.join(cwd, 'src'), path.join(cwd, 'alias'));
  linkDirectory(cwd, path.join(base, 'root-alias'));
  assert.deepEqual(modelFor(cwd, 'alias/ok.js').surfaces.routes, ['/api/local']);
  assert.deepEqual(modelFor(path.join(base, 'root-alias'), 'alias/ok.js').surfaces.routes, ['/api/local']);
});

test('an alias cannot expose excluded local state', (t) => {
  const { cwd } = fixture(t);
  fs.mkdirSync(path.join(cwd, '.idleproof'));
  fs.writeFileSync(path.join(cwd, '.idleproof', 'state.js'), "export const route='/api/synthetic-state-marker';");
  linkDirectory(path.join(cwd, '.idleproof'), path.join(cwd, 'alias'));
  assert.equal(modelFor(cwd, 'alias/state.js').generatedFrom.filesInspected, 0);
});

test('invalid UTF-8 is not converted into apparently observed source', (t) => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'invalid.js'), Buffer.concat([Buffer.from("export const route='/api/invalid'; //"), Buffer.from([0xc3, 0x28])]));
  const model = modelFor(cwd, 'invalid.js');
  assert.equal(model.generatedFrom.filesInspected, 0);
  assert.deepEqual(model.surfaces.routes, []);
});

test('file byte boundary is inclusive and accounts the actual UTF-8 bytes', (t) => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'exact.js'), Buffer.from('é'.repeat(LIMIT / 2)));
  fs.writeFileSync(path.join(cwd, 'large.js'), Buffer.alloc(LIMIT + 1, 0x61));
  assert.equal(modelFor(cwd, 'exact.js').generatedFrom.bytesInspected, LIMIT);
  assert.equal(modelFor(cwd, 'large.js').generatedFrom.filesInspected, 0);
});

test('a file growing after stat cannot bypass the byte limit or undercount it', (t) => {
  const { cwd } = fixture(t);
  const file = path.join(cwd, 'growing.js');
  fs.writeFileSync(file, 'export const initial = true;');
  const originalStat = fs.statSync;
  let changed = false;
  t.mock.method(fs, 'statSync', function(candidate, ...args) {
    const result = originalStat.call(this, candidate, ...args);
    if (!changed && path.resolve(String(candidate)) === file) {
      changed = true;
      fs.appendFileSync(file, Buffer.alloc(LIMIT + 1, 0x61));
    }
    return result;
  });
  assert.equal(modelFor(cwd, 'growing.js').generatedFrom.filesInspected, 0);
  assert.equal(changed, true);
});

test('growth during descriptor reading is capped and the descriptor is closed', (t) => {
  const { cwd } = fixture(t);
  const file = path.join(cwd, 'race.js');
  fs.writeFileSync(file, 'export const initial = true;');
  const originalRead = fs.readSync, originalClose = fs.closeSync;
  let descriptor, readBytes = 0, closed = false;
  t.mock.method(fs, 'readSync', function(fd, buffer, offset, length, position) {
    if (descriptor === undefined) {
      fs.appendFileSync(file, Buffer.alloc(LIMIT * 2, 0x61));
      descriptor = fd;
    }
    assert.ok(length <= LIMIT + 1);
    const count = originalRead.call(this, fd, buffer, offset, length, position);
    readBytes += count;
    return count;
  });
  t.mock.method(fs, 'closeSync', function(fd) {
    if (fd === descriptor) closed = true;
    return originalClose.call(this, fd);
  });
  assert.equal(modelFor(cwd, 'race.js').generatedFrom.filesInspected, 0);
  assert.equal(readBytes, LIMIT + 1);
  assert.equal(closed, true);
});

test('short reads preserve all source bytes and combined admission stays bounded', (t) => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'short.js'), "export const route='/api/short-é';");
  const originalRead = fs.readSync;
  const mock = t.mock.method(fs, 'readSync', function(fd, buffer, offset, length, position) {
    return originalRead.call(this, fd, buffer, offset, Math.min(7, length), position);
  });
  assert.deepEqual(modelFor(cwd, 'short.js').surfaces.routes, ['/api/short-é']);
  mock.mock.restore();
  const files = Array.from({length:6}, (_, i) => `part-${i}.js`);
  for (const file of files) fs.writeFileSync(path.join(cwd, file), Buffer.alloc(LIMIT, 0x61));
  const model = buildFeatureModel(cwd, {touchedFiles:files});
  assert.equal(model.generatedFrom.filesInspected, 5);
  assert.equal(model.generatedFrom.bytesInspected, 640 * 1024);
});

test('an alias retargeted after admission cannot contribute observations', (t) => {
  const { cwd, outside } = fixture(t);
  const local = path.join(cwd, 'src'), alias = path.join(cwd, 'alias');
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'entry.js'), "export const route='/api/local';");
  fs.writeFileSync(path.join(outside, 'entry.js'), "export const route='/api/synthetic-external-marker';");
  linkDirectory(local, alias);
  const originalOpen = fs.openSync;
  let changed = false;
  t.mock.method(fs, 'openSync', function(candidate, ...args) {
    if (!changed && path.resolve(String(candidate)) === path.join(local, 'entry.js')) {
      changed = true;
      fs.unlinkSync(alias);
      linkDirectory(outside, alias);
    }
    return originalOpen.call(this, candidate, ...args);
  });
  assert.equal(modelFor(cwd, 'alias/entry.js').generatedFrom.filesInspected, 0);
  assert.equal(changed, true);
});
