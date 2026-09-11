import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installClaude, uninstallClaude, hasClaudeInstall } from './install.mjs';
import { installCodex, uninstallCodex, hasCodexInstall } from './install-codex.mjs';
import { installCursor, uninstallCursor, hasCursorInstall } from './install-cursor.mjs';
import { probeDiffWitness } from './diffwitness-bridge.mjs';
import { readIntegrationConfig, removeIntegrationConfig, writeIntegrationConfig } from './diffwitness-integration-config.mjs';
import { projectPaths } from './paths.mjs';

const PACKAGE_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const BIN_PATH=path.join(PACKAGE_ROOT,'bin','idleproof.mjs');
const SUPPORTED=['claude','codex','cursor'];

function executableAvailable(name){
  try{
    execFileSync(process.platform==='win32'?'where':'which',[name],{stdio:'ignore',timeout:2000,windowsHide:true});
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
  // A fresh repository may be configured before the developer opens an IDE. Project-local
  // adapters are inert until their IDE reads them, so arming all supported adapters is safe.
  return detected.length?[...new Set(detected)]:[...SUPPORTED];
}

function assertGitRepository(cwd){
  try{execFileSync('git',['rev-parse','--is-inside-work-tree'],{cwd,stdio:'ignore',timeout:3000,windowsHide:true});}
  catch{throw new Error('DiffWitness integration must be installed from inside a Git repository.');}
}

function snapshots(cwd){
  const paths=projectPaths(cwd);
  const candidates=[
    paths.claudeSettings,
    paths.codexHooks,
    paths.cursorHooks,
    paths.cursorRule,
    paths.diffwitnessConfig,
    paths.defitnessConfigLegacy,
    path.join(cwd,'.git','info','exclude')
  ];
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

export function installDiffWitnessIntegration({cwd=process.cwd(),agent='auto',diffWitnessCommand='dw',probe=probeDiffWitness}={}){
  assertGitRepository(cwd);
  const requested=normalizeAgent(agent);
  const adapters=requested||detectAdapters(cwd);
  const proof=probe(cwd,diffWitnessCommand);
  if(!proof?.ok){
    throw new Error(`DiffWitness is required before its IDE integration can be armed. ${proof?.message || proof?.errorCode || 'Install a compatible DiffWitness package first.'}`);
  }

  const before=snapshots(cwd);
  const installed=[];
  try{
    writeIntegrationConfig(cwd,{adapters,diffWitnessCommand:proof.command || diffWitnessCommand});
    for(const adapter of adapters){
      installAdapter(cwd,adapter);
      installed.push(adapter);
    }
  }catch(error){
    restore(before);
    throw error;
  }
  return {schema:'diffwitness.integration-install-result.v1',installed:true,adapters:installed,diffWitnessCommand:proof.command || diffWitnessCommand,config:projectPaths(cwd).diffwitnessConfig};
}

export function uninstallDiffWitnessIntegration({cwd=process.cwd()}={}){
  const existing=readIntegrationConfig(cwd);
  const adapters=existing?.adapters?.length?existing.adapters:[...SUPPORTED];
  const removed=[];
  for(const adapter of adapters){if(uninstallAdapter(cwd,adapter))removed.push(adapter);}
  removeIntegrationConfig(cwd);
  return {schema:'diffwitness.integration-uninstall-result.v1',installed:false,removed};
}

export function diffWitnessIntegrationStatus(cwd=process.cwd(),{probe=probeDiffWitness}={}){
  let config=null;
  let configError=null;
  try{config=readIntegrationConfig(cwd);}catch(error){configError=String(error.message||error);}
  const adapters={claude:hasClaudeInstall(cwd),codex:hasCodexInstall(cwd),cursor:hasCursorInstall(cwd)};
  const proof=config&&!configError?probe(cwd,config.diffWitnessCommand):{ok:false,command:config?.diffWitnessCommand||null};
  const configured=Boolean(config)&&!configError;
  const adapterReady=configured&&config.adapters.length>0&&config.adapters.every((name)=>adapters[name]===true);
  return {
    schema:'diffwitness.integration-status.v1',
    configured,
    healthy:configured&&adapterReady&&Boolean(proof?.ok),
    configError,
    adapters,
    expectedAdapters:config?.adapters||[],
    diffWitness:{ok:Boolean(proof?.ok),command:proof?.command||config?.diffWitnessCommand||null,errorCode:proof?.errorCode||null}
  };
}

export const __integrationInstallTest={SUPPORTED,normalizeAgent,snapshots,restore};
