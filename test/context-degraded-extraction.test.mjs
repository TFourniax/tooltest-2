import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { extractTaskSignals } from '../src/context.mjs';
import { buildPlainExplanation } from '../src/explain.mjs';
import { buildPortalSnapshot } from '../src/portal-snapshot.mjs';
import { canonicalCore, failingCore } from './support/canonical-core.mjs';

// Each file declares `actual` and quotes a decoy declaration `invented` in a string literal and in
// a trailing comment. Only a parser can tell them apart.
const FILES = {
  'service.ts':'const bait = `function invented() {}`;\nexport function actual() {} // function invented() {}\n',
  'service.js':'const bait = "function invented() {}";\nexport function actual() {} // function invented() {}\n',
  'service.go':'package service\nvar bait = `func invented() {}`\nfunc actual() {} // func invented() {}\n',
  'service.rs':'const BAIT: &str = r#"fn invented() {}"#;\npub fn actual() {} // fn invented() {}\n',
  'service.py':'BAIT = "def invented():"\ndef actual():  # def invented():\n    return 1\n'
};
const SESSION = {currentResource:'service.ts',currentCapabilities:['code.read'],touchedFiles:Object.keys(FILES),prompt:'Inspect invented'};

function project(t, files=FILES) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-degraded-extraction-'));
  t.after(() => fs.rmSync(cwd, {recursive:true, force:true}));
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(cwd, file), text);
  return cwd;
}
const declared = canonicalCore(Object.fromEntries(Object.keys(FILES).map(file => [file, {symbols:['actual']}])));
const everyFile = signals => [signals, ...signals.relatedFiles];

function assertDegraded(signals, reason) {
  for (const item of everyFile(signals)) {
    assert.equal(item.symbol, null, item.file);
    assert.deepEqual(item.symbols, [], item.file);
    assert.equal(item.symbolCount, 0, item.file);
    assert.deepEqual(item.dependencies, [], item.file);
    assert.deepEqual(item.importReferences, [], item.file);
    assert.equal(item.structureCoverage.provider, 'unavailable', item.file);
    assert.equal(item.structureCoverage.canonical, false, item.file);
    assert.equal(item.structureCoverage.parsed, null, item.file);
    assert.equal(item.structureCoverage.reason, reason, item.file);
    assert.equal(item.structureCoverage.sourceSha256, createHash('sha256').update(FILES[item.file]).digest('hex'), item.file);
  }
}

test('an unavailable or rejected provider yields no structural facts, never a quoted decoy', (t) => {
  const cwd = project(t);
  const cases = [['timeout', 'core-extraction-unavailable'], ['missing', 'core-extraction-unavailable'],
    ['exit', 'core-extraction-unavailable'], ['garbage', 'core-extraction-rejected']];
  for (const [mode, reason] of cases) {
    const records = [];
    const signals = extractTaskSignals(cwd, SESSION, {structureOptions:failingCore[mode], onStructureFailure:record => records.push(record)});
    assertDegraded(signals, reason);
    assert.equal(records.length, 1, mode);
    assert.equal(records[0].reason, reason, mode);
    const explanation = buildPlainExplanation({session:{...SESSION, taskSignals:signals}});
    const rendered = JSON.stringify(explanation);
    // The prompt may be quoted as the task; the decoy must never be presented as a code identifier.
    assert.ok(!rendered.includes('`invented`'), `${mode}: the decoy never reaches the explanation`);
    assert.ok(!/observed symbol/.test(rendered), mode);
    assert.equal(explanation.certainty.level, 'bounded-inference', mode);
    const snapshot = buildPortalSnapshot({session:{...SESSION, taskSignals:signals}, explanation});
    assert.equal(snapshot.task.summary, 'Work involving service.ts', mode);
    assert.ok(!JSON.stringify(snapshot).includes('invented'), `${mode}: the decoy never reaches Portal`);
  }
});

test('a response bound to other bytes is rejected instead of attributed to this source', (t) => {
  const cwd = project(t);
  const forged = {command:'fixture-core', run:(command, args, options) => {
    const result = declared.run(command, args, options);
    const response = JSON.parse(result.stdout);
    response.files[0].source_sha256 = '0'.repeat(64);
    return {...result, stdout:Buffer.from(JSON.stringify(response))};
  }};
  assertDegraded(extractTaskSignals(cwd, SESSION, {structureOptions:forged}), 'core-extraction-rejected');
});

test('the nominal provider still extracts the actual symbols in every supported language', (t) => {
  const cwd = project(t);
  const signals = extractTaskSignals(cwd, SESSION, {structureOptions:declared});
  for (const item of everyFile(signals)) {
    assert.equal(item.symbol, 'actual', item.file);
    assert.deepEqual(item.symbols, ['actual'], item.file);
    assert.equal(item.structureCoverage.canonical, true, item.file);
    assert.equal(item.structureCoverage.parsed, true, item.file);
  }
  const explanation = buildPlainExplanation({session:{...SESSION, taskSignals:signals}});
  assert.match(JSON.stringify(explanation), /the observed symbol is `actual`/);
  assert.equal(explanation.certainty.level, 'observed-plus-inferred');
});

test('recovery after an incident returns fresh facts and a later failure never reuses them', (t) => {
  const cwd = project(t);
  assertDegraded(extractTaskSignals(cwd, SESSION, {structureOptions:failingCore.timeout}), 'core-extraction-unavailable');
  assert.equal(extractTaskSignals(cwd, SESSION, {structureOptions:declared}).symbol, 'actual', 'not stuck in a cached failure');
  // The same bytes with a failing provider: the earlier extraction is not silently reused.
  assertDegraded(extractTaskSignals(cwd, SESSION, {structureOptions:failingCore.exit}), 'core-extraction-unavailable');
  // Edited bytes: the provider's facts describe the new content only.
  const edited = canonicalCore({'service.ts':{symbols:['actual', 'renamed']}});
  fs.writeFileSync(path.join(cwd, 'service.ts'), 'export function renamed() {}\n');
  const fresh = extractTaskSignals(cwd, {...SESSION, touchedFiles:['service.ts'], prompt:'Inspect renamed'}, {structureOptions:edited});
  assert.equal(fresh.symbol, 'renamed');
  assert.deepEqual(fresh.symbols, ['renamed']);
  const failed = extractTaskSignals(cwd, {...SESSION, touchedFiles:['service.ts'], prompt:'Inspect renamed'}, {structureOptions:failingCore.timeout});
  assert.equal(failed.symbol, null);
  assert.equal(failed.structureCoverage.sourceSha256, createHash('sha256').update('export function renamed() {}\n').digest('hex'));
});

test('a valid unparsed response stays distinct from an unavailable provider', (t) => {
  const cwd = project(t, {'service.rs':FILES['service.rs']});
  const signals = extractTaskSignals(cwd, {currentResource:'service.rs', prompt:'Inspect invented'},
    {structureOptions:canonicalCore({'service.rs':{parsed:false}})});
  assert.equal(signals.symbol, null);
  assert.deepEqual(signals.symbols, []);
  assert.deepEqual(signals.structureCoverage, {provider:'tree-sitter-rust', sourceSha256:signals.structureCoverage.sourceSha256, parsed:false, canonical:true});
});

test('a language without a provider keeps its labelled heuristic, presented as a candidate', (t) => {
  const cwd = project(t, {'widget.vue':'<script>\nexport function mountWidget() {}\n</script>\n'});
  const signals = extractTaskSignals(cwd, {currentResource:'widget.vue', prompt:'Change mountWidget'}, {structureOptions:failingCore.timeout});
  assert.equal(signals.symbol, 'mountWidget');
  assert.equal(signals.structureCoverage.provider, 'legacy-heuristic');
  assert.equal(signals.structureCoverage.reason, 'language-adapter-pending');
  const explanation = buildPlainExplanation({session:{currentResource:'widget.vue', prompt:'Change mountWidget', taskSignals:signals}});
  assert.match(JSON.stringify(explanation), /a text-matched symbol candidate \(not parsed\) is `mountWidget`/);
  // The summary never presents the candidate as the active symbol either.
  assert.match(explanation.doing, /around the text-matched candidate `mountWidget` \(not parsed\)/);
  assert.match(explanation.doing, /centered on the text-matched candidate `mountWidget` \(not parsed\)/);
  assert.ok(!/around `mountWidget`|centered on `mountWidget`/.test(explanation.doing));
  assert.ok(!/observed symbol/.test(JSON.stringify(explanation)));
  assert.equal(explanation.certainty.level, 'bounded-inference');
});

test('learning context names a heuristic symbol as a candidate and a canonical one as active', async () => {
  const { buildContextualCard } = await import('../src/learning.mjs');
  const concept = {id:'testing', question:'What must be tested?', options:['a','b'], answer:0, lesson:'Test it.', review:'Review it.', why:'It matters.'};
  const card = coverage => buildContextualCard(concept, {}, {prompt:'Change mountWidget', touchedFiles:['widget.vue'],
    taskSignals:{file:'widget.vue', symbol:'mountWidget', structureCoverage:coverage}});
  assert.match(card({provider:'legacy-heuristic', canonical:false, parsed:null, reason:'language-adapter-pending'}).why,
    /text-matched symbol candidate mountWidget \(not parsed\)/);
  assert.ok(!/active symbol/.test(card({provider:'legacy-heuristic', canonical:false, parsed:null}).why));
  assert.match(card({provider:'tree-sitter-typescript', canonical:true, parsed:true}).why, /active symbol mountWidget/);
  // A candidate is never used as a code location in the question, lesson or review.
  const heuristic = card({provider:'legacy-heuristic', canonical:false, parsed:null, reason:'language-adapter-pending'});
  for (const field of ['question', 'lesson', 'review'])
    assert.ok(!/mountWidget in widget\.vue/.test(heuristic[field]), `${field}: ${heuristic[field]}`);
  assert.match(heuristic.lesson, /Open widget\.vue/);
  assert.match(card({provider:'tree-sitter-typescript', canonical:true, parsed:true}).lesson, /Open mountWidget in widget\.vue/);
});

test('a candidate symbol never anchors the Portal task summary', () => {
  const summary = coverage => buildPortalSnapshot({session:{prompt:'Change mountWidget', currentResource:'widget.vue', touchedFiles:['widget.vue'],
    taskSignals:{file:'widget.vue', symbol:'mountWidget', structureCoverage:coverage}}}).task.summary;
  assert.equal(summary({provider:'legacy-heuristic', canonical:false, parsed:null, reason:'language-adapter-pending'}), 'Work involving widget.vue');
  assert.equal(summary({provider:'tree-sitter-typescript', canonical:true, parsed:true}), 'Work around mountWidget in widget.vue');
});
