// Diagnostic only (MACHINE, never a qualification). Measures the first Core structure extraction
// after a fresh install, the condition of the original Windows gate failures, split by phase.
// Each observation uses its own fresh virtual environment so no measurement warms another; the
// authoritative gate runs in a different job and is never preceded by this. No retries: every
// outcome, fast or slow, is printed. No source text, paths, command lines or stderr are logged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadStructureExtractions } from '../src/structure-provider.mjs';

const coreIndex = process.argv.indexOf('--core');
const core = path.resolve(coreIndex > 0 ? process.argv[coreIndex + 1] : '');
if (!fs.existsSync(path.join(core, 'pyproject.toml'))) throw new Error('usage: structure-cold-start-diagnostics.mjs --core <Core checkout>');

// The exact four sources of the original JS/TS/Go/Rust gate invocation.
const FILES = [
  ['service.ts', 'const bait = `function invented() {}`;\nexport function actual() {}\n'],
  ['service.js', 'const bait = "function invented() {}";\nexport function actual() {}\n'],
  ['service.go', 'package service\nvar bait = `func invented() {}`\nfunc actual() {}\n'],
  ['service.rs', 'const BAIT: &str = r#"fn invented() {}"#;\npub fn actual() {}\n']
];
const PROVIDERS = [['tree_sitter_typescript', 'language_typescript', 'tree-sitter-typescript'], ['tree_sitter_javascript', 'language', 'tree-sitter-javascript'],
  ['tree_sitter_go', 'language', 'tree-sitter-go'], ['tree_sitter_rust', 'language', 'tree-sitter-rust']];
const windows = process.platform === 'win32';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-cold-start-'));
const project = path.join(root, 'project');
fs.mkdirSync(project);
const sources = FILES.map(([relative, text]) => {
  fs.writeFileSync(path.join(project, relative), text);
  return {relative, text, sha256:createHash('sha256').update(text).digest('hex')};
});
const emit = record => console.log(JSON.stringify({schema:'idleproof-cold-start-observation-1', classification:'MACHINE', qualification:false, ...record}));
const ms = start => Math.round((performance.now() - start) * 10) / 10;

function freshEnvironment(label) {
  const venv = path.join(root, label);
  let started = performance.now();
  const created = spawnSync(process.env.PYTHON || (windows ? 'python' : 'python3'), ['-m', 'venv', venv], {encoding:'utf8'});
  const venvMs = ms(started);
  const bin = path.join(venv, windows ? 'Scripts' : 'bin');
  const python = path.join(bin, windows ? 'python.exe' : 'python');
  started = performance.now();
  const installed = created.status === 0
    ? spawnSync(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', `${core}[structure]`], {encoding:'utf8'})
    : {status:null};
  emit({observation:'install', label, venvStatus:created.status, venvMs, installStatus:installed.status, installMs:ms(started)});
  return {python, dw:path.join(bin, windows ? 'dw.exe' : 'dw'), ok:created.status === 0 && installed.status === 0};
}

try {
  emit({observation:'environment', platform:process.platform, arch:process.arch, node:process.version, cpus:os.cpus().length});

  // A. The product call exactly as the gate makes it: first call after install, then repeats.
  const a = freshEnvironment('a');
  if (a.ok) for (let call = 1; call <= 11; call += 1) {
    const failures = [];
    const started = performance.now();
    const result = loadStructureExtractions(project, sources, {command:a.dw, onFailure:record => failures.push(record)});
    emit({observation:'product-call', label:'a', call, elapsedMs:ms(started), reason:result.reason, extracted:result.byPath.size,
      failure:failures[0] ? {stage:failures[0].stage, code:failures[0].code, signal:failures[0].signal, elapsedMs:failures[0].elapsedMs} : null});
  }

  // B. First real extraction in another fresh install, with CPython's own import timing.
  const b = freshEnvironment('b');
  if (b.ok) {
    const request = JSON.stringify({schema_version:'structure-request-1', files:sources.map(source => ({path:source.relative,
      content_base64:Buffer.from(source.text).toString('base64')}))});
    const started = performance.now();
    const result = spawnSync(b.python, ['-X', 'importtime', '-m', 'diffwitness.entry', 'state', 'extract', '--json'], {cwd:project, input:request, encoding:'utf8'});
    const wallMs = ms(started);
    const imports = [];
    for (const line of String(result.stderr).split(/\r?\n/)) {
      const match = /^import time:\s+(\d+) \|\s+(\d+) \| (\s*)(\S+)$/.exec(line);
      if (match) imports.push({module:match[4], cumulativeUs:Number(match[2]), depth:match[3].length});
    }
    const top = imports.filter(item => item.depth === 0).sort((x, y) => y.cumulativeUs - x.cumulativeUs).slice(0, 12)
      .map(item => ({module:item.module, ms:Math.round(item.cumulativeUs / 100) / 10}));
    const grammars = imports.filter(item => /^tree_sitter/.test(item.module)).map(item => ({module:item.module, ms:Math.round(item.cumulativeUs / 100) / 10}));
    const importMs = Math.round(imports.filter(item => item.depth === 0).reduce((sum, item) => sum + item.cumulativeUs, 0) / 100) / 10;
    emit({observation:'first-extraction-importtime', label:'b', status:result.status, wallMs, importMs, top, grammars});
  }

  // C. First in-process phase split in a third fresh install.
  const c = freshEnvironment('c');
  if (c.ok) {
    const probe = `
import json, time
t = time.perf_counter(); phases = {}
def mark(name):
    global t
    now = time.perf_counter(); phases[name] = round((now - t) * 1000, 1); t = now
import diffwitness.entry; mark('import_entry')
import diffwitness.structure_transport, diffwitness.structure_registry; mark('import_structure')
from importlib import metadata; mark('import_metadata')
for name in ['tree-sitter'] + ${JSON.stringify(PROVIDERS.map(item => item[2]))}: metadata.version(name)
mark('metadata_versions')
import importlib, tree_sitter; mark('import_tree_sitter')
for module, entry in ${JSON.stringify(PROVIDERS.map(item => [item[0], item[1]]))}:
    grammar = importlib.import_module(module); mark('import_' + module)
    tree_sitter.Parser(tree_sitter.Language(getattr(grammar, entry)())); mark('language_' + module)
print(json.dumps(phases))`;
    const started = performance.now();
    const result = spawnSync(c.python, ['-c', probe], {encoding:'utf8'});
    let phases = null;
    try { phases = JSON.parse(String(result.stdout).trim()); } catch {}
    emit({observation:'first-process-phases', label:'c', status:result.status, wallMs:ms(started), phases});
  }
} finally {
  fs.rmSync(root, {recursive:true, force:true});
}
