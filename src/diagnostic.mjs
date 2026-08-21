import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PACKAGE_ROOT, projectPaths } from './paths.mjs';
import { CURRENT_STATE_VERSION } from './state.mjs';
import { hasClaudeInstall } from './install.mjs';
import { hasCodexInstall } from './install-codex.mjs';
import { loadPolicy } from './policy.mjs';
import { verifyProvenanceChain } from './provenance.mjs';

const FORBIDDEN_KEYS = new Set([
  'prompt','promptRaw','content','sourceCode','source_code','diff','patch','tool_input','toolInput',
  'cwd','path','file','filename','absolutePath','secret','token','credential','privateKey','publicKey'
]);

function sha256(value='') {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT,'package.json'),'utf8')).version || 'unknown';
  } catch { return 'unknown'; }
}

function fileMeta(file) {
  try {
    const stat=fs.statSync(file);
    return { present:true, bytes:stat.isFile() ? stat.size : 0 };
  } catch { return { present:false, bytes:0 }; }
}

function jsonHealth(file) {
  const meta=fileMeta(file);
  if (!meta.present) return { ...meta, parseable:null, version:null };
  try {
    const parsed=JSON.parse(fs.readFileSync(file,'utf8'));
    const version=Number.isInteger(parsed?.version) ? parsed.version : null;
    return { ...meta, parseable:true, version };
  } catch {
    return { ...meta, parseable:false, version:null };
  }
}

function git(cwd,args) {
  try {
    return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:1500,maxBuffer:512*1024}).trim();
  } catch { return null; }
}

function gitSummary(cwd) {
  const inside=git(cwd,['rev-parse','--is-inside-work-tree'])==='true';
  if (!inside) return { repository:false, hasHead:false, dirty:null, changedEntries:null, nestedWorkingDirectory:null, repositoryId:null };
  const head=git(cwd,['rev-parse','--verify','HEAD']);
  const root=git(cwd,['rev-parse','--show-toplevel']);
  const status=git(cwd,['status','--porcelain=v1','--untracked-files=all']);
  const rootCommit=git(cwd,['rev-list','--max-parents=0','HEAD']);
  const entries=status ? status.split(/\r?\n/).filter(Boolean).length : 0;
  return {
    repository:true,
    hasHead:Boolean(head),
    dirty:entries>0,
    changedEntries:entries,
    nestedWorkingDirectory:root ? path.resolve(root)!==path.resolve(cwd) : null,
    repositoryId:rootCommit ? `repo_${sha256(rootCommit).slice(0,16)}` : null
  };
}

function identitySummary(cwd) {
  try {
    const parsed=JSON.parse(fs.readFileSync(projectPaths(cwd).identity,'utf8'));
    return { present:true, fingerprint:typeof parsed?.fingerprint==='string' ? parsed.fingerprint : null, keyType:typeof parsed?.keyType==='string' ? parsed.keyType : null };
  } catch { return { present:false, fingerprint:null, keyType:null }; }
}

function serverSummary(cwd) {
  try {
    const parsed=JSON.parse(fs.readFileSync(projectPaths(cwd).server,'utf8'));
    let pidAlive=false;
    try { if (Number.isInteger(parsed?.pid) && parsed.pid>0) { process.kill(parsed.pid,0); pidAlive=true; } } catch {}
    return {
      recordPresent:true,
      pidAlive,
      port:Number.isInteger(parsed?.port) ? parsed.port : null,
      instanceRecorded:typeof parsed?.instanceId==='string' && parsed.instanceId.length>0
    };
  } catch {
    return { recordPresent:false, pidAlive:false, port:null, instanceRecorded:false };
  }
}

function safePolicy(cwd) {
  try { return { readable:true, profile:loadPolicy(cwd).profile || null }; }
  catch { return { readable:false, profile:null }; }
}

function provenanceSummary(cwd) {
  try {
    const chain=verifyProvenanceChain(cwd);
    return { valid:Boolean(chain.ok), events:Number(chain.length || 0), errors:Array.isArray(chain.errors) ? chain.errors.length : 0 };
  } catch { return { valid:false, events:0, errors:1 }; }
}

export function buildSupportDiagnostic(cwd=process.cwd()) {
  const paths=projectPaths(cwd);
  const state=jsonHealth(paths.state);
  const backup=jsonHealth(paths.stateBackup);
  const events=fileMeta(paths.events);
  const report={
    schema:'idleproof.support-diagnostic.v1',
    generatedAt:new Date().toISOString(),
    product:{ version:packageVersion(), runtime:`node-${process.versions.node}` },
    system:{ platform:process.platform, arch:process.arch },
    git:gitSummary(cwd),
    adapters:{ claude:hasClaudeInstall(cwd), codex:hasCodexInstall(cwd) },
    policy:safePolicy(cwd),
    state:{
      currentVersion:CURRENT_STATE_VERSION,
      primary:state,
      backup,
      recoverable:state.parseable===true || backup.parseable===true
    },
    server:serverSummary(cwd),
    provenance:provenanceSummary(cwd),
    recorder:identitySummary(cwd),
    storage:{ eventsPresent:events.present, eventsBytes:events.bytes },
    privacy:{
      sourceCodeIncluded:false,
      rawPromptIncluded:false,
      rawDiffIncluded:false,
      rawAgentEventsIncluded:false,
      absoluteProjectPathIncluded:false,
      secretsIncluded:false
    }
  };
  assertSupportDiagnosticSafe(report);
  return report;
}

export function assertSupportDiagnosticSafe(report) {
  const visit=(value,key='root')=>{
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`Forbidden support diagnostic field: ${key}`);
    if (Array.isArray(value)) return value.forEach((item)=>visit(item,key));
    if (value && typeof value==='object') for (const [childKey,child] of Object.entries(value)) visit(child,childKey);
  };
  visit(report);
  const privacy=report?.privacy || {};
  for (const key of ['sourceCodeIncluded','rawPromptIncluded','rawDiffIncluded','rawAgentEventsIncluded','absoluteProjectPathIncluded','secretsIncluded']) {
    if (privacy[key]!==false) throw new Error(`Support diagnostic privacy boundary is not fail-closed: ${key}`);
  }
  if (Buffer.byteLength(JSON.stringify(report),'utf8')>32*1024) throw new Error('Support diagnostic exceeds 32 KiB safety budget.');
  return true;
}
