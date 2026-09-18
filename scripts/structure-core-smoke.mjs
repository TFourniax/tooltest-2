import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { extractTaskSignals } from '../src/context.mjs';

const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-structure-core-'));
try {
  const file=path.join(cwd,'source.py');
  fs.writeFileSync(file, 'bait = """\ndef invented(): pass\n"""\n\ndef actual():\n    return 1\n');
  const start=performance.now();
  const first=extractTaskSignals(cwd,{currentResource:'source.py',prompt:'Inspect invented'});
  assert.equal(first.symbol,'actual','a string must not invent an AST declaration');
  assert.equal(first.structureCoverage.provider,'python-ast');
  assert.equal(first.structureCoverage.parsed,true);
  assert.equal(first.structureCoverage.canonical,true);
  first.symbols.push('cache pollution');
  const second=extractTaskSignals(cwd,{currentResource:'source.py',prompt:'Inspect invented'});
  assert.deepEqual(second.symbols,['actual']);
  fs.writeFileSync(file,'def unfinished(');
  const invalid=extractTaskSignals(cwd,{currentResource:'source.py',prompt:'Inspect unfinished'});
  assert.equal(invalid.symbol,null);
  assert.equal(invalid.structureCoverage.parsed,false);
  assert.equal(invalid.structureCoverage.canonical,true);
  const stamp=new Date('2020-01-01T00:00:00Z');
  fs.writeFileSync(file,'def beforeEdit(): pass');fs.utimesSync(file,stamp,stamp);
  assert.equal(extractTaskSignals(cwd,{currentResource:'source.py',prompt:'Inspect'}).symbol,'beforeEdit');
  fs.writeFileSync(file,'def after_Edit(): pass');fs.utimesSync(file,stamp,stamp);
  assert.equal(extractTaskSignals(cwd,{currentResource:'source.py',prompt:'Inspect'}).symbol,'after_Edit');
  assert.deepEqual(fs.readdirSync(cwd),['source.py']);
  console.log(JSON.stringify({schema:'idleproof-structure-core-smoke-1',passed:true,
    elapsed_ms:Math.round((performance.now()-start)*1000)/1000,classification:'MACHINE'}));
} finally { fs.rmSync(cwd,{recursive:true,force:true}); }
