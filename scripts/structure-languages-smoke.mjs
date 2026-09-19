import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {extractTaskSignals} from '../src/context.mjs';

const optional=!process.argv.includes('--without-grammars');
const fixtures=[
  ['service.ts','const bait = `function invented() {}`;\nexport function actual() {}\n','tree-sitter-typescript'],
  ['service.js','const bait = "function invented() {}";\nexport function actual() {}\n','tree-sitter-javascript'],
  ['service.go','package service\nvar bait = `func invented() {}`\nfunc actual() {}\n','tree-sitter-go'],
  ['service.rs','const BAIT: &str = r#"fn invented() {}"#;\npub fn actual() {}\n','tree-sitter-rust']
];
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-language-core-'));
try {
  for(const [file,text] of fixtures)fs.writeFileSync(path.join(cwd,file),text);
  const session={currentResource:'service.ts',currentCapabilities:['code.read'],
    touchedFiles:fixtures.map(([file])=>file),prompt:'Inspect invented'};
  const first=extractTaskSignals(cwd,session);
  assert.equal(first.symbol,optional?'actual':null);
  for(const [file,,provider]of fixtures){
    const item=first.relatedFiles.find(item=>item.file===file);
    assert.equal(item.structureCoverage.provider,provider);
    assert.equal(item.structureCoverage.canonical,true);
    assert.equal(item.structureCoverage.parsed,optional);
    assert.deepEqual(item.symbols,optional?['actual']:[]);
  }
  first.relatedFiles[0].symbols.push('cache pollution');
  assert.deepEqual(extractTaskSignals(cwd,session).relatedFiles[0].symbols,optional?['actual']:[]);
  if(optional){
    fs.writeFileSync(path.join(cwd,'service.ts'),'export function broken(');
    const invalid=extractTaskSignals(cwd,session);
    assert.equal(invalid.symbol,null);assert.equal(invalid.structureCoverage.parsed,false);
    assert.equal(invalid.structureCoverage.canonical,true);
    const stamp=new Date('2020-01-01T00:00:00Z');
    fs.writeFileSync(path.join(cwd,'service.ts'),'export function beforeEdit() {}');fs.utimesSync(path.join(cwd,'service.ts'),stamp,stamp);
    assert.equal(extractTaskSignals(cwd,session).symbol,'beforeEdit');
    fs.writeFileSync(path.join(cwd,'service.ts'),'export function after_Edit() {}');fs.utimesSync(path.join(cwd,'service.ts'),stamp,stamp);
    assert.equal(extractTaskSignals(cwd,session).symbol,'after_Edit');
  }
  assert.deepEqual(fs.readdirSync(cwd).sort(),fixtures.map(([file])=>file).sort());
  console.log(JSON.stringify({schema:'idleproof-structure-languages-smoke-1',passed:true,
    actual_optional_grammars:optional,classification:'MACHINE'}));
}finally{fs.rmSync(cwd,{recursive:true,force:true});}
