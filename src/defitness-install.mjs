import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installClaude, uninstallClaude, hasClaudeInstall } from './install.mjs';
import { installCodex, uninstallCodex, hasCodexInstall } from './install-codex.mjs';
import { installCursor, uninstallCursor, hasCursorInstall } from './install-cursor.mjs';
import { probeDiffWitness } from './diffwitness-bridge.mjs';
import { readDefitnessConfig, removeDefitnessConfig, writeDefitnessConfig } from './defitness-config.mjs';
import { projectPaths } from './paths.mjs';

const PACKAGE_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const BIN_PATH=path.join(PACKAGE_ROOT,'bin','idleproof.mjs');
const SUPPORTED=['claude','codex','cursor'];

function executableAvailable(name){
  try{
    execFileSync(process.platform==='win32'?'where':'which',[name],{stdio:'ignore',timeout:1200,windowsHide:true});
    return true;
  }catch{return false;}
}

function normalizeAgent(value='auto'){
  const raw=String(value||'auto').toLowerCase();
  if(raw==='all')return [...SUPPORTED];
  if(raw==='auto')return null;
  const items=raw.split(',').map((item)=>item.trim()).filter(Boolean);
  if(!items.length||items.some((item)=>!SUPPORTED.includes(item))) throw new Error('Agent must be auto, all, claude, codex, cursor, or a comma-separated combination.');
  return [...new Set(items)];
}

export function detectAdapters(cwd=process.cwd()){
  const detected=[];
  if(fs.existsSync(path.join(cwd,'.claude'))||hasClaudeInstall(cwd)||executableAvailable('claude'))detected.push('claude');
  if(fs.existsSync(path.join(cwd,'.codex'))||hasCodexInstall(cwd)||executableAvailable('codex'))detected.push('codex');
  if(fs.existsSync(path.join(cwd,'.cursor'))||hasCursorInstall(cwd)||executableAvailable('cursor'))detected.push('cursor');
  // A fresh repository may be configured before the developer opens an IDE. Installing all three
  // project-local adapters is safe: absent IDEs simply ignore their own config directories.
  return detected.length?[...new Set(detected)]:[...SUPPORTED];
}

function assertGitRepository(cwd){
  try{execFileSync('git',['rev-parse','--is-inside-work-tree'],{cwd,stdio:'ignore',timeout:1500,windowsHide:true});}
  catch{throw new Error('Defitness must be installed from inside a Git repository.');}
}

function snapshots(cwd){
  const paths=projectPaths(cwd);
  const candidates=[paths.claudeSettings,paths.codexHooks,paths.cursorHooks,paths.cursorRule,paths.defitnessConfig];
  return new Map(candidates.map((file)=>{
    try{return [file,{exists:true,content:fs.readFileSync(file)}];}catch(error){if(error.code==='ENOENT')return [file,{exists:false,content:null}];throw error;}
  }));
}

function restore(snapshot){
  for(const [file,state] of snapshot.entries()){
    if(!state.exists){try{fs.rmSync(file,{force:true});}catch{};continue;}
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,state.content,{mode:0o600});
  }
}

function installAdapter(cwd,adapter){
  if(adapter==='claude')return installClaude({cwd,binPath:BIN_PATH});
  if(adapter==='codex')return installCodex({cwd,binPath:BIN_PATH});
  if(adapter==='cursor')return installCursor({cwd,binPath:BIN_PATH});
  throw new Error(`Unsupported adapter: ${adapter}`);
}

function uninstallAdapter(cwd,adapter){
  if(adapter==='claude')return uninstallClaude({cwd});
  if(adapter==='codex')return uninstallCodex({cwd});
  if(adapter==='cursor')return uninstallCursor({cwd});
  return false;
}

export function installDefitness({cwd=process.cwd(),agent='auto',diffWitnessCommand='dw'}={}){
  assertGitRepository(cwd);
  const requested=normalizeAgent(agent);
  const adapters=requested||detectAdapters(cwd);
  const proof=probeDiffWitness(cwd,diffWitnessCommand);
  if(!proof.ok){
    throw new Error(`DiffWitness is required before Defitness can be armed. ${proof.message || proof.errorCode || 'Install a compatible diffwitness package first.'}`);
  }

  const before=snapshots(cwd);
  const installed=[];
  try{
    // Write the fail-closed requirement only after the DiffWitness capability probe passes. The
    // whole operation is rolled back if any adapter refuses an existing incompatible config.
    writeDefitnessConfig(cwd,{adapters,diffWitnessCommand:proof.command});
    for(const adapter of adapters){
      installAdapter(cwd,adapter);
      installed.push(adapter);
    }
  }catch(error){
    restore(before);
    throw error;
  }
  return {schema:'defitness.install-result.v1',installed:true,adapters:installed,diffWitnessCommand:proof.command,config:projectPaths(cwd).defitnessConfig};
}

export function uninstallDefitness({cwd=process.cwd()}={}){
  const existing=readDefitnessConfig(cwd);
  const adapters=existing?.adapters?.length?existing.adapters:[...SUPPORTED];
  const removed=[];
  for(const adapter of adapters){if(uninstallAdapter(cwd,adapter))removed.push(adapter);}
  removeDefitnessConfig(cwd);
  return {schema:'defitness.uninstall-result.v1',installed:false,removed};
}

export function defitnessStatus(cwd=process.cwd()){
  let config=null;
  let configError=null;
  try{config=readDefitnessConfig(cwd);}catch(error){configError=String(error.message||error);}
  const adapters={claude:hasClaudeInstall(cwd),codex:hasCodexInstall(cwd),cursor:hasCursorInstall(cwd)};
  const proof=config&&!configError?probeDiffWitness(cwd,config.diffWitnessCommand):{ok:false,command:config?.diffWitnessCommand||null};
  const configured=Boolean(config)&&!configError;
  const adapterReady=configured&&config.adapters.every((name)=>adapters[name]===true);
  return {
    schema:'defitness.status.v1',
    configured,
    healthy:configured&&adapterReady&&proof.ok,
    configError,
    adapters,
    expectedAdapters:config?.adapters||[],
    diffWitness:{ok:Boolean(proof.ok),command:proof.command||config?.diffWitnessCommand||null,errorCode:proof.errorCode||null}
  };
}

export const __defitnessInstallTest={SUPPORTED,normalizeAgent,snapshots,restore};
