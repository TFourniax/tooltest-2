import { spawnSync } from 'node:child_process';
import { readIntegrationConfig } from './diffwitness-integration-config.mjs';
import { lineagePath, validFeatureObservations } from './feature-observations.mjs';
import { compareFeatureSnapshots } from './feature-memory.mjs';

const RESPONSE_BYTES=512*1024, CORE_LIMIT=100, LINK_LIMIT=32;
const METHOD='unique-exact-regular-blob-first-parent-1';
const SCOPE='imported exact-blob relocation hypotheses; no identity or authority transfer';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,wanted)=>object(v)&&Object.keys(v).sort().join('|')===[...wanted].sort().join('|');
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const oid=v=>typeof v==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
const featureKey=v=>typeof v==='string'&&/^[a-f0-9]{24}$/.test(v);
const COUNTS=['before_files','after_files','excluded_before','excluded_after','removed','added',
  'ambiguous_removed','ambiguous_added','unmatched_removed','unmatched_added'];

export function validFileLineage(value,path) {
  if(!keys(value,['schema_version','path','items','matches','omitted','assessments','scope'])
      ||value.schema_version!=='git-file-lineage-1'||value.path!==path||!lineagePath(path)||value.scope!==SCOPE
      ||![value.matches,value.omitted,value.assessments].every(integer)||!Array.isArray(value.items)
      ||value.items.length!==Math.min(value.matches,CORE_LIMIT)||value.omitted!==value.matches-value.items.length) return false;
  const seen=new Set(),events=new Map();
  for(const item of value.items) {
    if(!keys(item,['from','to','mode','blob','blob_sha256','blob_bytes','event_id','event_hash','commit','parent','tree','epistemic_status','method','coverage'])
        ||!lineagePath(item.from)||!lineagePath(item.to)||item.from===item.to||![item.from,item.to].includes(path)
        ||!['100644','100755'].includes(item.mode)||!oid(item.blob)||!oid(item.commit)||!oid(item.parent)||!oid(item.tree)
        ||item.commit===item.parent||![item.blob,item.parent,item.tree].every(v=>v.length===item.commit.length)
        ||!sha(item.blob_sha256)||!integer(item.blob_bytes)||item.blob_bytes>2*1024*1024
        ||typeof item.event_id!=='string'||!/^dwev_[a-f0-9]{24}$/.test(item.event_id)||!sha(item.event_hash)
        ||item.epistemic_status!=='INFERRED'||item.method!==METHOD||!keys(item.coverage,[...COUNTS,'complete'])) return false;
    const c=item.coverage;
    if(!COUNTS.every(k=>integer(c[k])&&c[k]<=32768)||typeof c.complete!=='boolean'
        ||c.complete!==(c.excluded_before===0&&c.excluded_after===0)||c.removed>c.before_files||c.added>c.after_files) return false;
    const pairs=c.removed-c.ambiguous_removed-c.unmatched_removed;
    if(pairs<1||pairs>32||pairs!==c.added-c.ambiguous_added-c.unmatched_added) return false;
    const identity=JSON.stringify([item.event_id,item.from,item.to]);
    if(seen.has(identity)) return false;
    seen.add(identity);
    const binding=JSON.stringify([item.event_hash,item.commit,item.parent,item.tree,COUNTS.map(k=>c[k]),c.complete]);
    if(events.has(item.event_id)&&events.get(item.event_id)!==binding) return false;
    events.set(item.event_id,binding);
  }
  return value.assessments>=events.size&&value.matches<=value.assessments*32;
}

export function queryFeatureLineage(cwd,state,fromKey,toKey,{command=null,run=spawnSync,timeoutMs=3000}={}) {
  if(!featureKey(fromKey)||!featureKey(toKey)||fromKey===toKey) throw new Error('Two distinct feature keys are required.');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>3000) throw new Error('Invalid lineage timeout.');
  const base={schema:'idleproof.feature-lineage.v1',fromFeature:fromKey,toFeature:toKey,epistemic_status:'INFERRED',
    scope:'links between retained observations, not current applicability or proven feature identity',
    transfersScores:false,transfersAssertionAuthority:false};
  const unavailable=reason=>({...base,status:'unavailable',reason,links:[]});
  const before=state.features?.[fromKey]?.lineageObservations,after=state.features?.[toKey]?.lineageObservations;
  if(before===undefined||after===undefined) return unavailable('missing-source-bound-observations');
  if(!validFeatureObservations(before,fromKey)||!validFeatureObservations(after,toKey)) return unavailable('invalid-feature-observations');
  if(!before.items.length||!after.items.length) return unavailable('missing-source-bound-observations');
  const paths=new Set(after.items.map(item=>item.anchor.entry));
  if(paths.size!==1) return unavailable('ambiguous-destination-anchor');
  const destination=[...paths][0];
  if(!command) {
    try { command=readIntegrationConfig(cwd,{migrateLegacy:false})?.diffWitnessCommand||process.env.DIFFWITNESS_BIN||process.env.DEFITNESS_DIFFWITNESS_BIN||'dw'; }
    catch { return unavailable('invalid-integration-configuration'); }
  }
  let response;
  try {
    const result=run(command,['state','lineage',`--path=${destination}`,'--limit',String(CORE_LIMIT),'--json'],
      {cwd,windowsHide:true,timeout:timeoutMs,maxBuffer:RESPONSE_BYTES,stdio:['ignore','pipe','pipe']});
    if(result.error||result.status!==0) return unavailable('core-lineage-unavailable');
    if(!Buffer.isBuffer(result.stdout)||result.stdout.length>RESPONSE_BYTES) return unavailable('core-lineage-rejected');
    const raw=new TextDecoder('utf-8',{fatal:true}).decode(result.stdout);
    response=JSON.parse(raw);
    const compact=raw.replace(/("(?:\\.|[^"\\])*")|\s+/g,(match,string)=>string??'');
    if(JSON.stringify(response)!==compact||!validFileLineage(response,destination)) return unavailable('core-lineage-rejected');
  } catch { return unavailable('core-lineage-rejected'); }
  const links=[];let matches=0;
  for(const relocation of response.items) for(const old of before.items) for(const next of after.items) {
    if(old.anchor.entry!==relocation.from||next.anchor.entry!==relocation.to
        ||old.anchor.source_sha256!==relocation.blob_sha256||next.anchor.source_sha256!==relocation.blob_sha256) continue;
    matches+=1;
    if(links.length<LINK_LIMIT) links.push({fromObservation:old.id,toObservation:next.id,epistemic_status:'INFERRED',
      from:relocation.from,to:relocation.to,source_sha256:relocation.blob_sha256,
      source:{event_id:relocation.event_id,event_hash:relocation.event_hash,commit:relocation.commit,parent:relocation.parent,tree:relocation.tree,method:relocation.method},
      inventoryComplete:relocation.coverage.complete,snapshotDifference:compareFeatureSnapshots(old.snapshot,next.snapshot)});
  }
  return {...base,status:'available',reason:null,links,matches,omitted:matches-links.length,
    coverage:{coreAssessments:response.assessments,coreMatches:response.matches,coreOmitted:response.omitted,
      fromObservations:before.items.length,toObservations:after.items.length,
      fromDiscarded:before.discarded,toDiscarded:after.discarded,
      completeRetainedView:response.omitted===0&&before.discarded===0&&after.discarded===0&&matches===links.length
        &&response.items.every(item=>item.coverage.complete)}};
}

export function renderFeatureLineage(result,language='en') {
  if(!['en','fr'].includes(language)) throw new Error('Language must be en or fr.');
  const tr=(en,fr)=>language==='fr'?fr:en;
  const lines=[tr('Feature lineage: ','Filiation de fonctionnalités : ')+result.fromFeature+' → '+result.toFeature];
  if(result.status!=='available') lines.push(tr('Unavailable: ','Indisponible : ')+result.reason);
  else {
    for(const link of result.links) lines.push(`[INFERRED] ${link.from} → ${link.to}`,
      `  ${link.source.event_id} · ${link.source.event_hash} · commit ${link.source.commit}`,
      `  ${link.fromObservation} → ${link.toObservation}`);
    if(!result.links.length) lines.push(tr('No matching hypothesis in retained observations.','Aucune hypothèse correspondante dans les observations conservées.'));
    if(!result.coverage.completeRetainedView) lines.push(tr('Limited retained history or result coverage; inspect --json.','Historique conservé ou résultats limités ; consulter --json.'));
  }
  lines.push(tr('Inferred links between recorded snapshots. Current applicability requires confirmation; scores and authority remain separate.',
    'Liens déduits entre observations enregistrées. Applicabilité actuelle à confirmer ; scores et autorité restent distincts.'));
  return lines.join('\n');
}

export function featureLineageCli(cwd,state,args) {
  if(args.includes('--list')) {
    if(args.filter(arg=>arg==='--list').length!==1||args.filter(arg=>arg==='--json').length>1
        ||args.some(arg=>!['--list','--json'].includes(arg))) throw new Error('Usage: feature-lineage --list [--json]');
    const entries=Object.entries(state.features||{}).sort(([a],[b])=>a.localeCompare(b));
    const items=entries.slice(0,100).map(([key,entry])=>{
      const log=entry?.lineageObservations,valid=log!==undefined&&validFeatureObservations(log,key);
      return {featureKey:key,anchor:valid?(log.items.at(-1)?.anchor.entry||null):null,
        observations:valid?log.items.length:0,discarded:valid?log.discarded:null,
        status:log===undefined?'unavailable':valid?'available':'invalid'};
    });
    const result={schema:'idleproof.feature-lineage-index.v1',items,omitted:Math.max(0,entries.length-items.length)};
    if(args.includes('--json')) console.log(JSON.stringify(result,null,2));
    else { for(const item of items) console.log(`${item.featureKey} · ${item.anchor||item.status} · ${item.observations}`);
      if(result.omitted) console.log(`${result.omitted} more retained feature memories outside this list.`); }
    return;
  }
  const options={language:'en'};
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg==='--json') { if(options.json) throw new Error('Duplicate --json.');options.json=true;continue; }
    if(!['--from','--to','--language'].includes(arg)||args[i+1]===undefined) throw new Error('Usage: feature-lineage --from KEY --to KEY [--json] [--language en|fr]');
    const key=arg.slice(2);
    if(options[key]!==undefined&&key!=='language') throw new Error('Duplicate lineage option.');
    if(key==='language'&&options.languageSeen) throw new Error('Duplicate language option.');
    options[key]=args[++i];if(key==='language') options.languageSeen=true;
  }
  if(!['en','fr'].includes(options.language)) throw new Error('Language must be en or fr.');
  const result=queryFeatureLineage(cwd,state,options.from,options.to);
  console.log(options.json?JSON.stringify(result,null,2):renderFeatureLineage(result,options.language));
  if(result.status!=='available') process.exitCode=2;
}
