import { createHash } from 'node:crypto';

export const OBSERVATION_LIMIT=8;
const MAX_BYTES=16*1024;
const GROUPS=['story','routes','tables','technologies','tests'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,expected)=>object(value)&&Object.keys(value).sort().join('|')===[...expected].sort().join('|');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const label=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);
export const lineagePath=value=>label(value)&&value.length<=500&&Buffer.byteLength(JSON.stringify(value),'utf8')<=512
  &&!/[\\:]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&part.toLowerCase()!=='.git');

export function featureAnchor(model={}) {
  const files=(model.story||[]).filter(step=>step.type==='file');
  const entry=files.find(step=>['ui','api','core'].includes(step.role))||files[0]||null;
  const route=model.surfaces?.routes?.[0]||null;
  return {entry:entry?.label||null,route,technology:!entry&&!route?(model.surfaces?.technologies?.[0]||null):null};
}

export const anchorFeatureKey=anchor=>digest({entry:anchor.entry,route:anchor.route,technology:anchor.technology}).slice(0,24);

function canonical(value) {
  return {schema:'idleproof.feature-observation.v1',featureKey:value.featureKey,
    anchor:{entry:value.anchor.entry,route:value.anchor.route,technology:value.anchor.technology,source_sha256:value.anchor.source_sha256},
    snapshot:Object.fromEntries(GROUPS.map(key=>[key,[...value.snapshot[key]]]))};
}

export function validFeatureObservation(value,expectedKey) {
  if(!keys(value,['schema','featureKey','anchor','snapshot','id'])||value.schema!=='idleproof.feature-observation.v1'
      ||typeof value.featureKey!=='string'||!/^[a-f0-9]{24}$/.test(value.featureKey)||value.featureKey!==expectedKey
      ||!keys(value.anchor,['entry','route','technology','source_sha256'])||!lineagePath(value.anchor.entry)
      ||!(value.anchor.route===null||label(value.anchor.route))||value.anchor.technology!==null||!sha(value.anchor.source_sha256)
      ||anchorFeatureKey(value.anchor)!==expectedKey||!keys(value.snapshot,GROUPS)) return false;
  for(const group of GROUPS) {
    const list=value.snapshot[group];
    if(!Array.isArray(list)||list.length>128||!list.every(label)||new Set(list).size!==list.length
        ||JSON.stringify(list)!==JSON.stringify([...list].sort())) return false;
  }
  return Buffer.byteLength(JSON.stringify(value),'utf8')<=MAX_BYTES&&value.id==='ipfo_'+digest(canonical(value));
}

export function validFeatureObservations(log,key) {
  return keys(log,['schema','items','discarded'])&&log.schema==='idleproof.feature-observations.v1'
    &&Number.isSafeInteger(log.discarded)&&log.discarded>=0&&Array.isArray(log.items)&&log.items.length<=OBSERVATION_LIMIT
    &&log.items.every(item=>validFeatureObservation(item,key))&&new Set(log.items.map(item=>item.id)).size===log.items.length;
}

export function observeFeature(previous,model,snapshot) {
  const key=model.featureKey||anchorFeatureKey(featureAnchor(model));
  if(previous!==undefined&&!validFeatureObservations(previous,key)) throw new Error('Invalid retained feature observation history.');
  const anchor=featureAnchor(model);
  const nodes=(model.nodes||[]).filter(node=>node.type==='file'&&node.label===anchor.entry);
  const coverage=(model.generatedFrom?.coverage||[]).filter(item=>item.path===anchor.entry);
  if(!lineagePath(anchor.entry)||nodes.length!==1||coverage.length!==1||coverage[0].canonical!==true||coverage[0].parsed!==true
      ||nodes[0].source?.path!==anchor.entry||nodes[0].source?.source_sha256!==coverage[0].source_sha256) return previous;
  const value={schema:'idleproof.feature-observation.v1',featureKey:key,
    anchor:{...anchor,source_sha256:coverage[0].source_sha256},snapshot};
  value.id='ipfo_'+digest(canonical(value));
  if(!validFeatureObservation(value,key)) return previous;
  const items=previous?.items||[];
  if(items.some(item=>item.id===value.id)) return previous;
  if(items.length===OBSERVATION_LIMIT&&previous.discarded===Number.MAX_SAFE_INTEGER)
    throw new Error('Feature observation history exceeds its counter limit.');
  return {schema:'idleproof.feature-observations.v1',items:[...items,structuredClone(value)].slice(-OBSERVATION_LIMIT),
    discarded:(previous?.discarded||0)+Number(items.length===OBSERVATION_LIMIT)};
}
