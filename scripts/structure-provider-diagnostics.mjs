// Non-qualifying observations of independent synthetic requests; never a retry gate.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadStructureExtractions} from '../src/structure-provider.mjs';

const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-provider-diagnostic-'));
const source={relative:'settings.yaml',text:'a.b: "function invented() {} CREATE TABLE fake (id int); Stripe"\n'};
source.sha256=createHash('sha256').update(source.text).digest('hex');
const samples=[];
try {
  for(let index=0;index<20;index++) {
    let invocation=null;
    const started=performance.now();
    const result=loadStructureExtractions(cwd,[source],{run:(command,args,options)=>{
      const before=performance.now();
      const value=spawnSync(command,args,options);
      invocation={durationMs:performance.now()-before,timeoutMs:options.timeout,
        status:value.status,signal:value.signal||null,
        errorCode:typeof value.error?.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(value.error.code)?value.error.code:null,
        stdoutBytes:Buffer.isBuffer(value.stdout)?value.stdout.length:null,
        stderrBytes:Buffer.isBuffer(value.stderr)?value.stderr.length:null};
      return value;
    }});
    const extracted=result.byPath.get(source.relative);
    samples.push({index:index+1,elapsedMs:performance.now()-started,invocation,
      reason:result.reason,canonical:Boolean(extracted),parsed:extracted?.parsed??null,
      expectedSymbol:extracted?.symbols.some(item=>item.qualified_name==='settings.yaml::/@0/a.b')??false});
  }
  console.log(JSON.stringify({schema:'idleproof-provider-diagnostic-1',classification:'MACHINE',qualification:false,
    note:'20 independent synthetic YAML requests; all outcomes retained. Original gate result is authoritative. No raw source, response, command or stderr is logged.',
    platform:process.platform,arch:process.arch,node:process.version,samples}));
} finally {fs.rmSync(cwd,{recursive:true,force:true});}
