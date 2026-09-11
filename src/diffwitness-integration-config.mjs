import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './paths.mjs';

const SCHEMA='diffwitness.integration-config.v1';
const LEGACY_SCHEMA='defitness.project-config.v1';

function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try{
    fs.writeFileSync(temp,`${JSON.stringify(value,null,2)}\n`,{encoding:'utf8',mode:0o600});
    fs.renameSync(temp,file);
  } finally { try{fs.rmSync(temp,{force:true});}catch{} }
}

function normalize(value){
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('unsupported schema');
  if(![SCHEMA,LEGACY_SCHEMA].includes(value.schema)) throw new Error('unsupported schema');
  const adapters=Array.isArray(value.adapters)?value.adapters.filter((item)=>['claude','codex','cursor'].includes(item)):[];
  return {
    schema:SCHEMA,
    requireDiffWitness:value.requireDiffWitness===true,
    diffWitnessCommand:typeof value.diffWitnessCommand==='string'&&value.diffWitnessCommand.trim()?value.diffWitnessCommand.trim():'dw',
    adapters:[...new Set(adapters)],
    installedAt:typeof value.installedAt==='string'?value.installedAt:null,
    migratedFrom:value.schema===LEGACY_SCHEMA?LEGACY_SCHEMA:null
  };
}

function readJson(file){
  return normalize(JSON.parse(fs.readFileSync(file,'utf8')));
}

export function readIntegrationConfig(cwd=process.cwd()){
  const paths=projectPaths(cwd);
  try{return readJson(paths.diffwitnessConfig);}catch(error){
    if(error?.code!=='ENOENT'){
      const wrapped=new Error(`DiffWitness integration config is invalid: ${error.message}`);
      wrapped.code='DIFFWITNESS_INTEGRATION_CONFIG_INVALID';
      throw wrapped;
    }
  }
  try{
    const legacy=readJson(paths.defitnessConfigLegacy);
    // The experimental pre-alpha name was never public. Migrate it in-place once so upgraded
    // worktrees keep their adapter selection without carrying the wrong product name forward.
    const migrated={...legacy,schema:SCHEMA,migratedFrom:LEGACY_SCHEMA};
    atomicJson(paths.diffwitnessConfig,migrated);
    try{fs.rmSync(paths.defitnessConfigLegacy,{force:true});}catch{}
    return migrated;
  }catch(error){
    if(error?.code==='ENOENT')return null;
    const wrapped=new Error(`DiffWitness integration config is invalid: ${error.message}`);
    wrapped.code='DIFFWITNESS_INTEGRATION_CONFIG_INVALID';
    throw wrapped;
  }
}

export function writeIntegrationConfig(cwd=process.cwd(),{adapters=[],diffWitnessCommand='dw'}={}){
  const normalized=[...new Set(adapters.map((item)=>String(item).toLowerCase()).filter((item)=>['claude','codex','cursor'].includes(item)))];
  if(!normalized.length) throw new Error('DiffWitness integration requires at least one coding-agent adapter.');
  const command=String(diffWitnessCommand||'dw').trim();
  if(!command||/[\u0000-\u001f\u007f]/.test(command)) throw new Error('DiffWitness command is invalid.');
  const value={schema:SCHEMA,requireDiffWitness:true,diffWitnessCommand:command,adapters:normalized,installedAt:new Date().toISOString()};
  const paths=projectPaths(cwd);
  atomicJson(paths.diffwitnessConfig,value);
  try{fs.rmSync(paths.defitnessConfigLegacy,{force:true});}catch{}
  return value;
}

export function removeIntegrationConfig(cwd=process.cwd()){
  const paths=projectPaths(cwd);
  let removed=false;
  for(const file of [paths.diffwitnessConfig,paths.defitnessConfigLegacy]){
    try{if(fs.existsSync(file))removed=true;fs.rmSync(file,{force:true});}catch{}
  }
  return removed;
}

export const __integrationConfigTest={SCHEMA,LEGACY_SCHEMA};
