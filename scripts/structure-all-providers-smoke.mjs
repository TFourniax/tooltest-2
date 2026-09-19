import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {extractTaskSignals} from '../src/context.mjs';

const optional=!process.argv.includes('--without-grammars');
const fixtures=[
 ['settings.json',JSON.stringify({'a.b':'function invented() {} CREATE TABLE fake (id int); Stripe',route:'/api/private-value'}),'tree-sitter-json','/a.b'],
 ['settings.toml','"a.b" = "function invented() {} CREATE TABLE fake (id int); Stripe"\n','tree-sitter-toml','/a.b'],
 ['settings.yaml','a.b: "function invented() {} CREATE TABLE fake (id int); Stripe"\n','tree-sitter-yaml','/@0/a.b'],
 ['schema.sql',"CREATE TABLE public.actual (id int); SELECT 'CREATE TABLE invented (id int)';",'tree-sitter-sql','public.actual'],
 ['A.java','import java.util.List; class Actual { String bait="class Invented {}"; }','tree-sitter-java','Actual'],
 ['A.cs','using System; class Actual { string bait="class Invented {}"; }','tree-sitter-c-sharp','Actual'],
 ['a.kt','import kotlin.collections.List\nclass Actual {\n val bait = "class Invented {}"\n}\n','tree-sitter-kotlin','Actual'],
 ['a.rb','require "json"\nrequire_relative "local"\nclass Actual\n bait="class Invented; end"\nend\n','tree-sitter-ruby','Actual'],
 ['a.php',"<?php use Vendor\\Client; require('local.php'); class Actual {} $bait='function invented() {}';",'tree-sitter-php','Actual']
];
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-all-providers-'));
try{
 for(const [file,source,provider,expected]of fixtures){
  fs.writeFileSync(path.join(cwd,file),source);
  const session={currentResource:file,prompt:'Inspect invented'};
  const value=extractTaskSignals(cwd,session);
  assert.equal(value.structureCoverage.canonical,true,file);
  assert.equal(value.structureCoverage.provider,provider,file);
  assert.equal(value.structureCoverage.parsed,optional,file);
  assert.equal(value.symbol,optional?expected:null,file);
  assert.deepEqual(value.dependencies,[],`${file}: origin is unresolved, not third-party proof`);
  if(file.startsWith('settings.')){
   assert.equal(value.route,null);assert.equal(value.table,null);assert.deepEqual(value.technologies,[]);
   assert.ok(!JSON.stringify(value).includes('private-value'));
  }
  if(file==='schema.sql')assert.equal(value.table,optional?'public.actual':null);
  if(optional&&file==='a.php')assert.deepEqual(value.importReferences,['Vendor\\Client','local.php']);
  value.importReferences.push('cache pollution');
  assert.ok(!extractTaskSignals(cwd,session).importReferences.includes('cache pollution'));
 }
 const jsonPath=path.join(cwd,'settings.json');
 const stamp=fs.statSync(jsonPath);
 const oldSource=fs.readFileSync(jsonPath,'utf8');
 fs.writeFileSync(jsonPath,oldSource.replace('a.b','c.d'));
 fs.utimesSync(jsonPath,stamp.atime,stamp.mtime);
 assert.equal(fs.statSync(jsonPath).size,stamp.size);
 const changed=extractTaskSignals(cwd,{currentResource:'settings.json',prompt:'Inspect invented'});
 assert.equal(changed.symbol,optional?'/c.d':null,'same-size source edit must invalidate cached keys');
 const previousCommand=process.env.DIFFWITNESS_BIN;
 try{
  process.env.DIFFWITNESS_BIN=path.join(cwd,'missing-dw');
  const missing=extractTaskSignals(cwd,{currentResource:'settings.json'});
  assert.equal(missing.structureCoverage.canonical,false);
  assert.equal(missing.symbol,null);assert.equal(missing.route,null);assert.equal(missing.table,null);
  assert.deepEqual(missing.technologies,[]);assert.deepEqual(missing.dependencies,[]);
 }finally{
  if(previousCommand===undefined)delete process.env.DIFFWITNESS_BIN;
  else process.env.DIFFWITNESS_BIN=previousCommand;
 }
 fs.writeFileSync(jsonPath,'{"broken":');
 const broken=extractTaskSignals(cwd,{currentResource:'settings.json'});
 assert.equal(broken.structureCoverage.canonical,true);assert.equal(broken.structureCoverage.parsed,false);
 assert.equal(broken.symbol,null);assert.equal(broken.table,null);assert.equal(broken.route,null);
 assert.equal(fs.readdirSync(cwd).length,fixtures.length,'no source persistence');
 console.log(JSON.stringify({schema:'idleproof-all-task-providers-smoke-1',passed:true,actual_optional_grammars:optional,classification:'MACHINE'}));
}finally{fs.rmSync(cwd,{recursive:true,force:true});}
