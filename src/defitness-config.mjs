import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './paths.mjs';

const SCHEMA='defitness.project-config.v1';

function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try{
    fs.writeFileSync(temp,`${JSON.stringify(value,null,2)}\n`,{encoding:'utf8',mode:0o600});
    fs.renameSync(temp,file);
  } finally { try{fs.rmSync(temp,{force:true});}catch{} }
}

export function readDefitnessConfig(cwd=process.cwd()){
  const file=projectPaths(cwd).defitnessConfig;
  try{
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!value||value.schema!==SCHEMA||typeof value!=='object'||Array.isArray(value)) throw new Error('unsupported schema');
    const adapters=Array.isArray(value.adapters)?value.adapters.filter((item)=>['claude','codex','cursor'].includes(item)):[];
    return {schema:SCHEMA,requireDiffWitness:value.requireDiffWitness===true,diffWitnessCommand:typeof value.diffWitnessCommand==='string'&&value.diffWitnessCommand.trim()?value.diffWitnessCommand.trim():'dw',adapters:[...new Set(adapters)],installedAt:typeof value.installedAt==='string'?value.installedAt:null};
  } catch(error){
    if(error?.code==='ENOENT') return null;
    const wrapped=new Error(`Defitness integration config is invalid: ${error.message}`);
    wrapped.code='DEFITNESS_CONFIG_INVALID';
    throw wrapped;
  }
}

export function writeDefitnessConfig(cwd=process.cwd(),{adapters=[],diffWitnessCommand='dw'}={}){
  const normalized=[...new Set(adapters.map((item)=>String(item).toLowerCase()).filter((item)=>['claude','codex','cursor'].includes(item)))];
  if(!normalized.length) throw new Error('Defitness requires at least one coding-agent adapter.');
  const command=String(diffWitnessCommand||'dw').trim();
  if(!command||/[\u0000-\u001f\u007f]/.test(command)) throw new Error('DiffWitness command is invalid.');
  const value={schema:SCHEMA,requireDiffWitness:true,diffWitnessCommand:command,adapters:normalized,installedAt:new Date().toISOString()};
  atomicJson(projectPaths(cwd).defitnessConfig,value);
  return value;
}

export function removeDefitnessConfig(cwd=process.cwd()){
  try{fs.rmSync(projectPaths(cwd).defitnessConfig,{force:true});return true;}catch{return false;}
}

export const __defitnessConfigTest={SCHEMA};
