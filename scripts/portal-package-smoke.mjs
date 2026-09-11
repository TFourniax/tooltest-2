import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const ROOT=process.cwd();
const PRIVATE_MARKER='PRIVATE_PORTAL_PACKAGE_SMOKE_PROMPT';

function exec(command,args,options={}) {
  return execFileSync(command,args,{
    cwd:options.cwd || ROOT,
    encoding:'utf8',
    stdio:['ignore','pipe','pipe'],
    timeout:options.timeout || 60000,
    env:{...process.env,...(options.env || {})},
    shell:Boolean(options.shell)
  });
}

function npm(args,options={}) {
  return exec('npm',args,{...options,shell:process.platform==='win32'});
}

function runNode(bin,cwd,args=[],env={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[bin,...args],{
      cwd,
      env:{...process.env,...env},
      windowsHide:true,
      stdio:['ignore','pipe','pipe']
    });
    let stdout=''; let stderr='';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data',(chunk)=>{stdout+=chunk;});
    child.stderr.on('data',(chunk)=>{stderr+=chunk;});
    child.once('error',reject);
    child.once('close',(code)=>resolve({code,stdout,stderr}));
  });
}

function listen(server) {
  return new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>resolve(server.address()));
  });
}

function close(server) { return new Promise((resolve)=>server.close(()=>resolve())); }

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-portal-package-'));
let tarball=null;
let server=null;
try {
  const packed=JSON.parse(npm(['pack','--json'],{cwd:ROOT}));
  if (!Array.isArray(packed) || !packed[0]?.filename) throw new Error('npm pack did not return an artifact filename');
  tarball=path.resolve(ROOT,packed[0].filename);

  const consumer=path.join(temp,'consumer');
  fs.mkdirSync(consumer,{recursive:true});
  npm(['init','-y'],{cwd:consumer});
  npm(['install','--ignore-scripts','--no-audit','--no-fund',tarball],{cwd:consumer});
  const bin=path.join(consumer,'node_modules','idleproof','bin','idleproof.mjs');
  if (!fs.existsSync(bin)) throw new Error('installed package missing IdleProof CLI');

  const project=path.join(temp,'project');
  fs.mkdirSync(path.join(project,'.idleproof'),{recursive:true});
  fs.writeFileSync(path.join(project,'.idleproof','state.json'),JSON.stringify({
    version:2,
    project:'portal-package-smoke',
    createdAt:'2026-08-21T20:00:00.000Z',
    updatedAt:'2026-08-21T20:01:00.000Z',
    preferences:{level:'adaptive',mode:'learn',sponsorCards:false},
    sessions:{
      smoke:{
        id:'smoke',source:'claude',status:'complete',startedAt:'2026-08-21T20:00:00.000Z',lastEventAt:'2026-08-21T20:01:00.000Z',completedAt:'2026-08-21T20:01:00.000Z',
        prompt:PRIVATE_MARKER,promptChars:PRIVATE_MARKER.length,promptSha256:'a'.repeat(64),
        touchedFiles:['src/auth.ts'],changed:{added:2,deleted:1},concepts:{},events:[],
        proof:{changeId:`dwchg_${'b'.repeat(24)}`,diffSha256:'c'.repeat(64)},taskSignals:{file:'src/auth.ts'}
      }
    },
    features:{},ledger:{}
  },null,2)+'\n',{encoding:'utf8',mode:0o600});

  const token=`ipd_${'p'.repeat(32)}`;
  const received=[];
  server=http.createServer((req,res)=>{
    const chunks=[];
    let bytes=0;
    req.on('data',(chunk)=>{
      bytes+=chunk.length;
      if (bytes>64*1024) req.destroy(new Error('request too large'));
      else chunks.push(chunk);
    });
    req.on('end',()=>{
      const bodyText=Buffer.concat(chunks).toString('utf8');
      if (req.method!=='POST' || req.url!=='/api/v1/snapshots') {
        res.writeHead(404,{'content-type':'application/json'}); res.end(JSON.stringify({error:{code:'NOT_FOUND'}})); return;
      }
      if (req.headers.authorization!==`Bearer ${token}`) {
        res.writeHead(401,{'content-type':'application/json'}); res.end(JSON.stringify({error:{code:'AUTH_FAILED'}})); return;
      }
      const body=JSON.parse(bodyText);
      received.push({headers:req.headers,body,bytes});
      if (body.schema!=='idleproof.portal-snapshot.v1') throw new Error(`unexpected snapshot schema ${body.schema}`);
      if (!/^ipsnap_[a-f0-9]{24}$/.test(body.snapshotId || '')) throw new Error(`invalid snapshot id ${body.snapshotId}`);
      if (bodyText.includes(PRIVATE_MARKER)) throw new Error('raw prompt leaked over Portal transport');
      if (body.privacy?.rawPromptIncluded!==false || body.privacy?.sourceCodeIncluded!==false || body.privacy?.rawDiffIncluded!==false || body.privacy?.rawAgentEventsIncluded!==false) throw new Error('Portal transport privacy boundary is not fail-closed');
      res.writeHead(202,{'content-type':'application/json'});
      res.end(JSON.stringify({schema:'idleproof.portal-ingest-ack.v1',status:'accepted',snapshotId:body.snapshotId}));
    });
  });
  const address=await listen(server);
  const endpoint=`http://127.0.0.1:${address.port}/api/v1/snapshots`;

  const configured=await runNode(bin,project,['portal','configure','--endpoint',endpoint,'--token-env','IDLEPROOF_TEST_PORTAL_TOKEN'],{IDLEPROOF_TEST_PORTAL_TOKEN:token});
  if (configured.code!==0) throw new Error(`installed Portal configure failed:\n${configured.stdout}\n${configured.stderr}`);
  if (configured.stdout.includes(token)) throw new Error('Portal configure printed the enrollment token');

  const synced=await runNode(bin,project,['portal','sync','--json']);
  if (synced.code!==0) throw new Error(`installed Portal sync failed:\n${synced.stdout}\n${synced.stderr}`);
  const sync=JSON.parse(synced.stdout);
  if (sync.ok!==true || sync.delivered!==1 || sync.pending!==0) throw new Error(`unexpected installed Portal sync result: ${synced.stdout}`);
  if (received.length!==1) throw new Error(`expected exactly one network delivery, received ${received.length}`);
  if (received[0].bytes>64*1024) throw new Error(`snapshot exceeded 64 KiB: ${received[0].bytes}`);

  const statusRun=await runNode(bin,project,['portal','status','--json']);
  if (statusRun.code!==0) throw new Error(`installed Portal status failed: ${statusRun.stderr}`);
  const status=JSON.parse(statusRun.stdout);
  if (!status.configured || !status.healthy || status.pending!==0 || status.skippedSnapshots!==0) throw new Error(`unexpected installed Portal status: ${statusRun.stdout}`);
  if (JSON.stringify(status).includes(token)) throw new Error('Portal status leaked the full enrollment token');
  if (fs.existsSync(path.join(project,'.idleproof','portal-queue.json'))) throw new Error('acknowledged installed snapshot remained queued');

  console.log(`IdleProof Portal package smoke passed on ${process.platform}/${process.version} · exact package -> HTTP -> strict ACK -> empty queue`);
} finally {
  if (server) { try { await close(server); } catch {} }
  if (tarball) { try { fs.rmSync(tarball,{force:true}); } catch {} }
  try { fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100}); } catch {}
}
