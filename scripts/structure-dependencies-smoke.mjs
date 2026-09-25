import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {extractTaskSignals} from '../src/context.mjs';
import {loadStructureExtractions} from '../src/structure-provider.mjs';
import {readProjectSource} from '../src/project-source.mjs';

const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-module-origin-'));
const fixtures=[
  ['plain.ts',"import './local.js';\nimport fs from 'node:fs';\nimport path from 'path';\nimport '#internal';\nexport function actual() {}\n",
    "import sdk from '@odd/sdk';\n",'@odd/sdk'],
  ['plain.rs','use std::collections::HashMap;\nuse ::core::fmt;\nuse crate::local;\nuse self::value;\nuse super::other;\nextern crate alloc;\nfn actual() {}\n',
    'use serde::Serialize;\n','serde::Serialize'],
  ['plain.go','package p\nimport (\n "fmt"\n "net/http"\n)\nfunc actual() {}\n',
    null,'example.com/sdk']
];
try{
  for(const [file,source,extra,target]of fixtures){
    fs.writeFileSync(path.join(cwd,file),source);
    const value=extractTaskSignals(cwd,{currentResource:file});
    assert.equal(value.structureCoverage.canonical,true);
    assert.equal(value.structureCoverage.parsed,true);
    assert.deepEqual(value.dependencies,[],`${file}: local/platform imports are not third-party dependencies`);
    assert.equal(value.fileRole.role,'core');
    const raw=loadStructureExtractions(cwd,[readProjectSource(cwd,file)]);
    assert.ok(raw.byPath.get(file).imports.length>0,'raw canonical imports must be preserved');
    const external=extra?source+extra:source.replace('"fmt"','"fmt"\n "example.com/sdk"');
    fs.writeFileSync(path.join(cwd,file),external);
    assert.deepEqual(extractTaskSignals(cwd,{currentResource:file}).dependencies,[target]);
  }
  // Complete mode of the Rust task-context unit case: the actual provider yields the live symbol and
  // the full external target, never the standard library.
  fs.writeFileSync(path.join(cwd,'queue_worker.rs'),'use mystery_bus::Client;\nuse std::sync::Arc;\nfn drain_pending_jobs() {}');
  const rust=extractTaskSignals(cwd,{currentResource:'queue_worker.rs',currentCapabilities:['code.modify'],prompt:'Make drain_pending_jobs safe'});
  assert.equal(rust.structureCoverage.provider,'tree-sitter-rust');
  assert.equal(rust.structureCoverage.parsed,true);
  assert.equal(rust.symbol,'drain_pending_jobs');
  assert.deepEqual(rust.dependencies,['mystery_bus::Client']);
  console.log('ACTUAL MODULE ORIGIN FILTER PASS: raw imports retained, local/platform excluded, candidate external targets preserved; MACHINE');
}finally{fs.rmSync(cwd,{recursive:true,force:true});}
