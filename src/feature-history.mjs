// Immutable local observation storage. The hot state keeps its existing eight-row
// view; this archive carries no score, assertion authority, source code or prompt.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validFeatureObservation,validFeatureObservations} from './feature-observations.mjs';

const pending=new WeakMap(), pendingProjects=new Map(), MAX_BYTES=16*1024+1, MAX_PENDING_BYTES=4*1024*1024;
export const ARCHIVE_CHECKPOINT='idleproof.feature-observation-archive.v1';
const featureKey=value=>typeof value==='string'&&/^[a-f0-9]{24}$/.test(value);
const observationId=value=>typeof value==='string'&&/^ipfo_[a-f0-9]{64}$/.test(value);

export function stageFeatureObservations(state,key,log) {
  if(!validFeatureObservations(log,key)) throw new Error('Invalid feature observations for archive.');
  const current=pending.get(state)||new Map(), next=new Map(current);
  for(const item of log.items) next.set(item.id,structuredClone(item));
  if([...next.values()].reduce((sum,item)=>sum+Buffer.byteLength(JSON.stringify(item)),0)>MAX_PENDING_BYTES)
    throw new Error('Save feature history before recording more observations.');
  pending.set(state,next);
}

function directory(cwd,key,create=false) {
  if(!featureKey(key)) throw new Error('Invalid feature key.');
  let current=fs.realpathSync(cwd);
  for(const part of ['.idleproof','feature-observations',key]) {
    current=path.join(current,part);
    if(create) {try {fs.mkdirSync(current,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}}
    let info;
    try {info=fs.lstatSync(current);}catch(error){if(!create&&error.code==='ENOENT')return null;throw error;}
    if(!info.isDirectory()||info.isSymbolicLink()) throw new Error('Feature history requires real local directories.');
  }
  return current;
}

function readFile(file,key,id) {
  const before=fs.lstatSync(file);
  if(!before.isFile()||before.isSymbolicLink()||before.size>MAX_BYTES) throw new Error('Invalid feature observation file.');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try {
    const info=fs.fstatSync(fd);
    if(!info.isFile()||info.size>MAX_BYTES||info.dev!==before.dev||info.ino!==before.ino) throw new Error('Feature observation changed during admission.');
    const bytes=Buffer.alloc(MAX_BYTES+1), count=fs.readSync(fd,bytes,0,bytes.length,0);
    if(count>MAX_BYTES)throw new Error('Oversized feature observation.');
    const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count));
    const value=JSON.parse(raw);
    // Archive encoding is exact: reject duplicate keys, edits and extra fields.
    if(raw!==JSON.stringify(value)+'\n'||!validFeatureObservation(value,key)||value.id!==id)
      throw new Error('Corrupt feature observation; original file retained.');
    return value;
  } finally {fs.closeSync(fd);}
}

export function readFeatureObservation(cwd,key,id) {
  if(!observationId(id))throw new Error('Invalid observation ID.');
  const dir=directory(cwd,key);
  if(!dir)throw new Error('Feature observation archive unavailable.');
  return readFile(path.join(dir,id+'.json'),key,id);
}

function writeObservation(cwd,value) {
  const key=value.featureKey, dir=directory(cwd,key,true), file=path.join(dir,value.id+'.json');
  try {const prior=readFile(file,key,value.id);if(JSON.stringify(prior)!==JSON.stringify(value))throw new Error('Conflicting observation.');return;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const temp=path.join(dir,randomUUID()+'.tmp');
  let fd;
  try {
    fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    // Atomic publication without replacing an existing historical record.
    try {fs.linkSync(temp,file);}catch(error){if(error.code!=='EEXIST')throw error;
      if(JSON.stringify(readFile(file,key,value.id))!==JSON.stringify(value))throw new Error('Conflicting observation.');}
  } finally {if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temp,{force:true});}
}

export function persistFeatureObservations(cwd,state) {
  const project=fs.realpathSync(cwd);
  const items=new Map([...(pendingProjects.get(project)||[]),...(pending.get(state)||[])]);
  const seeded=[];
  // Seed only actually retained legacy observations. Never infer lost history
  // from current files or reset the historical discarded counter.
  for(const [key,entry]of Object.entries(state.features||{})) {
    const log=entry?.lineageObservations;if(log===undefined)continue;
    if(entry.lineageArchive===ARCHIVE_CHECKPOINT)continue;
    if(!validFeatureObservations(log,key))throw new Error('Invalid retained feature observation history.');
    seeded.push(entry);
  }
  if([...items.values()].reduce((sum,item)=>sum+Buffer.byteLength(JSON.stringify(item)),0)>MAX_PENDING_BYTES)
    throw new Error('Pending feature history exceeds its write batch; save smaller batches.');
  // A failed mutateState call discards its transient state object. Retain only
  // the source-bound observations by project, not that failed state or scores.
  pendingProjects.set(project,items);
  for(const item of items.values())writeObservation(cwd,item);
  // Stream legacy rows separately: an existing archive migration must not
  // require all features to fit the new-observation staging memory budget.
  for(const entry of seeded){
    for(const item of entry.lineageObservations.items)writeObservation(cwd,item);
    entry.lineageArchive=ARCHIVE_CHECKPOINT;
  }
  pending.delete(state);
  pendingProjects.delete(project);
}

export function readFeatureHistory(cwd,key,{after=null,limit=20}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>100||after!==null&&!observationId(after))throw new Error('Invalid history cursor or limit.');
  const dir=directory(cwd,key), candidates=[];let total=0,scanned=0;
  if(dir){const handle=fs.opendirSync(dir);try {let entry;
    while((entry=handle.readSync())!==null){
      if(++scanned>100000)throw new Error('Feature history directory exceeds the bounded reader; no partial page returned.');
      if(!/^ipfo_[a-f0-9]{64}\.json$/.test(entry.name))continue;
      total++;
      const id=entry.name.slice(0,-5);
      if(after!==null&&id<=after)continue;
      candidates.push(id);candidates.sort();if(candidates.length>limit+1)candidates.pop();
    }
  } finally {handle.closeSync();}}
  const hasMore=candidates.length>limit, ids=candidates.slice(0,limit);
  return {schema:'idleproof.feature-history.v1',featureKey:key,status:dir?'available':'unavailable',
    order:'observation-id',olderHistory:'unknown',totalFiles:total,items:ids.map(id=>readFeatureObservation(cwd,key,id)),
    next:hasMore?ids.at(-1):null,transfersScores:false,transfersAssertionAuthority:false};
}

export function featureHistoryCli(cwd,args) {
  const opts={language:'en'},seen=new Set();
  for(let i=0;i<args.length;i++){
    const arg=args[i];if(seen.has(arg))throw new Error('Duplicate history option.');seen.add(arg);
    if(arg==='--json'){opts.json=true;continue;}
    if(!['--feature','--after','--limit','--language'].includes(arg)||args[i+1]===undefined)throw new Error('Usage: feature-history --feature KEY [--after ID] [--limit 1..100] [--json] [--language en|fr]');
    opts[arg.slice(2)]=args[++i];
  }
  if(!['en','fr'].includes(opts.language)||opts.limit!==undefined&&!/^[1-9][0-9]{0,2}$/.test(opts.limit))throw new Error('Invalid history language or limit.');
  const result=readFeatureHistory(cwd,opts.feature,{after:opts.after??null,limit:opts.limit===undefined?20:Number(opts.limit)});
  if(opts.json)console.log(JSON.stringify(result,null,2));
  else {
    console.log(opts.language==='fr'?'Observations locales conservées (ordre des identifiants, pas chronologique)':'Retained local observations (ID order, not chronology)');
    for(const item of result.items)console.log(`${item.id} · ${item.anchor.entry} · sha256:${item.anchor.source_sha256}`);
    console.log(opts.language==='fr'?'Historique antérieur inconnu ; aucune autorité ou note transférée.':'Earlier history unknown; no authority or score transferred.');
    if(result.next)console.log(`--after ${result.next}`);
  }
  if(result.status!=='available')process.exitCode=2;
}
