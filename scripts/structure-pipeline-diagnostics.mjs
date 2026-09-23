// Fixed, non-qualifying observations of the complete source-reader/CLI consumer.
// Builtin instrumentation is confined to this diagnostic process and restored.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {performance} from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {extractTaskSignals} from '../src/context.mjs';

const original={spawn:childProcess.spawnSync,stat:fs.statSync,fstat:fs.fstatSync,open:fs.openSync,close:fs.closeSync};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-pipeline-diagnostic-'));
const canonicalRoot=fs.realpathSync(root);
const descriptors=new Set();
let active=null;
const code=value=>typeof value==='string'&&/^[A-Z0-9_]{1,40}$/.test(value)?value:null;
const stats=(stage,value)=>({stage,file:value.isFile(),dev:value.dev,ino:value.ino,size:value.size,
  mtimeMs:value.mtimeMs,ctimeMs:value.ctimeMs});
const fixturePath=value=>typeof value==='string'&&(value.startsWith(root+path.sep)||value.startsWith(canonicalRoot+path.sep));
const samples=[];
try {
  fs.statSync=function(file,...args){
    try {
      const value=original.stat(file,...args);
      if(active&&fixturePath(file)) active.sourceReads.push(stats('stat',value));
      return value;
    } catch(error) {if(active&&fixturePath(file))active.sourceReads.push({stage:'stat',errorCode:code(error.code)});throw error;}
  };
  fs.openSync=function(file,...args){
    const descriptor=original.open(file,...args);
    if(fixturePath(file)) descriptors.add(descriptor);
    return descriptor;
  };
  fs.fstatSync=function(descriptor,...args){
    const value=original.fstat(descriptor,...args);
    if(active&&descriptors.has(descriptor))active.sourceReads.push(stats('fstat',value));
    return value;
  };
  fs.closeSync=function(descriptor,...args){descriptors.delete(descriptor);return original.close(descriptor,...args);};
  childProcess.spawnSync=function(command,args,options){
    const started=performance.now();
    const value=original.spawn(command,args,options);
    if(active&&Array.isArray(args)&&args.join('|')==='state|extract|--json') {
      active.invocations.push({durationMs:performance.now()-started,timeoutMs:options.timeout,
        status:value.status,signal:value.signal||null,errorCode:code(value.error?.code),
        stdoutBytes:Buffer.isBuffer(value.stdout)?value.stdout.length:null,
        stderrBytes:Buffer.isBuffer(value.stderr)?value.stderr.length:null});
    }
    return value;
  };
  syncBuiltinESMExports();
  const fixtures=[
    ['settings.json',JSON.stringify({'a.b':'function invented() {} CREATE TABLE fake (id int); Stripe',route:'/api/private-value'}),'tree-sitter-json','/a.b',2],
    ['settings.toml','"a.b" = "function invented() {} CREATE TABLE fake (id int); Stripe"\n','tree-sitter-toml','/a.b',2],
    ['settings.yaml','a.b: "function invented() {} CREATE TABLE fake (id int); Stripe"\n','tree-sitter-yaml','/@0/a.b',1]
  ];
  // Exactly 100 fresh synthetic directories and 500 observations, independent of
  // success/failure. This mirrors the sequence before the historical assertion.
  for(let round=1;round<=100;round++) {
    const cwd=path.join(root,String(round));fs.mkdirSync(cwd);
    for(const [file,source,provider,symbol,count]of fixtures) {
      fs.writeFileSync(path.join(cwd,file),source);
      for(let call=1;call<=count;call++) {
        active={round,fixture:file,call,sourceReads:[],invocations:[]};
        const started=performance.now();
        try {
          const value=extractTaskSignals(cwd,{currentResource:file,prompt:'Inspect invented'});
          Object.assign(active,{elapsedMs:performance.now()-started,reason:value.structureCoverage.reason??null,
            canonical:value.structureCoverage.canonical,parsed:value.structureCoverage.parsed,
            expectedProvider:value.structureCoverage.provider===provider,expectedSymbol:value.symbol===symbol});
        } catch(error) {
          // Only a bounded error class; never emit its arbitrary message/stack.
          Object.assign(active,{elapsedMs:performance.now()-started,exception:
            typeof error?.name==='string'&&/^[A-Za-z]{1,40}$/.test(error.name)?error.name:'Error'});
        }
        samples.push(active);active=null;
      }
    }
    fs.rmSync(cwd,{recursive:true,force:true});
  }
} finally {
  active=null;fs.statSync=original.stat;fs.fstatSync=original.fstat;fs.openSync=original.open;fs.closeSync=original.close;
  childProcess.spawnSync=original.spawn;syncBuiltinESMExports();
  fs.rmSync(root,{recursive:true,force:true});
}
console.log(JSON.stringify({schema:'idleproof-source-pipeline-diagnostic-1',classification:'MACHINE',qualification:false,
  note:'Fixed 100 synthetic sequences / 500 complete pipeline observations. All outcomes retained. Instrumentation overhead is included. No retries, raw source/response, command, path, stderr or exception message. The original gate remains authoritative.',
  platform:process.platform,arch:process.arch,node:process.version,expectedSamples:500}));
// Separate lines avoid truncating a single oversized CI log line.
for(const sample of samples) console.log(JSON.stringify({schema:'idleproof-source-pipeline-sample-1',...sample}));
console.log(JSON.stringify({schema:'idleproof-source-pipeline-summary-1',classification:'MACHINE',qualification:false,
  samples:samples.length,canonical:samples.filter(value=>value.canonical).length,
  expectedSymbol:samples.filter(value=>value.expectedSymbol).length,
  timeouts:samples.filter(value=>value.invocations.some(call=>call.errorCode==='ETIMEDOUT')).length,
  maxElapsedMs:Math.max(0,...samples.map(value=>value.elapsedMs))}));
