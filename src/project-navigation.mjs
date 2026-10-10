const testPathCache=new WeakMap();
const testPaths=model=>{if(!testPathCache.has(model))testPathCache.set(model,new Set(model.files.filter(f=>f.role==='test').map(f=>f.path)));return testPathCache.get(model);};
// Advisory joins of a captured structure and admitted Core context. No event writer.
const candidates=(paths,model)=>model.edges.filter(e=>e.to&&paths.has(e.to)&&testPaths(model).has(e.from)).map(e=>({path:e.from,line:e.line,authority:'INFERRED',basis:'static test import; execution and coverage UNKNOWN'}));
const unique=values=>[...new Map(values.map(v=>[v.path,v])).values()];

export function declaredIntentMap(model) {
  const components=model.files.filter(f=>f.sourceSha256&&f.role!=='declared-document');
  const statements=model.files.flatMap(f=>(f.extraction?.description?.intent||[]).map(item=>({file:f,...item})));
  return {authority:'INFERRED',statements:statements.slice(0,160).map(statement=>{
    // Only exact captured path mentions nominate components. No semantic fulfillment claim.
    const mentioned=components.filter(f=>statement.text.includes(f.path)).slice(0,16);
    const paths=new Set(mentioned.map(f=>f.path));
    return {declaration:statement.text,authority:'DECLARED',source:{snapshotId:model.header.snapshotId,path:statement.file.path,line:statement.line,sourceSha256:statement.file.sourceSha256},
      components:mentioned.map(f=>({id:f.componentId,path:f.path,authority:'INFERRED',basis:'exact path mentioned in selected document'})),
      testCandidates:unique(candidates(paths,model)).slice(0,16),implementation:'UNKNOWN',verification:'UNKNOWN',
      nextAction:mentioned.length?'Inspect these source references; record a supported Core relation and run a discriminating test.':'No exact captured component path is mentioned. Record the intended relationship in Core; names alone do not establish implementation.'};
  }),statementsOmitted:Math.max(0,statements.length-160),meaning:'Owner declarations, component candidates and test references are separate from fulfilled requirements.'};
}

export function projectNavigation(model,memory,task) {
  if(!model)return {status:'NO_BASELINE',requirements:[],recordedItems:[],activeTask:null};
  const components=new Map(model.files.filter(f=>f.componentId).map(f=>[f.componentId,f]));
  const entities=memory?[...(memory.objectives||[]),...(memory.tasks||[]),...(memory.decisions||[]),...(memory.invariants||[]),...(memory.failedApproaches||[])]:[];
  const recordedItems=entities.map(entity=>{
    const relations=(memory.relations||[]).filter(r=>r.source===entity.id&&components.has(r.target));
    const paths=new Set(relations.map(r=>components.get(r.target).path));
    return {id:entity.id,kind:entity.kind,label:entity.label,authority:entity.epistemicStatus,source:entity.source||null,lifecycle:entity.lifecycle||null,
      components:relations.map(r=>({id:r.target,path:components.get(r.target).path,predicate:r.predicate,authority:r.epistemicStatus})),
      testCandidates:unique(candidates(paths,model)).slice(0,16),
      changes:(memory.recentRelatedChanges||[]).filter(c=>c.files.some(p=>paths.has(p))).map(c=>({...c,meaning:'Recorded historical assurance for this exact change; not verification of the current snapshot or declaration.'})),
      verification:'No transitive promotion from historical Proof to this declaration.'};
  });
  const paths=new Set(task?.matchedFiles||[]);
  return {status:memory?'BOUNDED_CORE_CONTEXT':'STRUCTURE_ONLY_MEMORY_UNAVAILABLE',contextId:memory?.context_id||null,
    eventHead:memory?.state?.eventHead||null,requirements:model.intentMap||declaredIntentMap(model),recordedItems,
    knownDebt:memory?.knownDebt||[],requiredEvidence:memory?.requiredEvidence||[],warnings:memory?.warnings||[],
    activeTask:task?{...task,components:model.files.filter(f=>paths.has(f.path)).map(f=>({id:f.componentId,path:f.path,sourceSha256:f.sourceSha256})),testCandidates:unique(candidates(paths,model)).slice(0,16)}:null,
    limitations:'Only received Core relations and exact captured paths are joined. Test imports are candidates; missing rationale, coverage and current verification remain UNKNOWN.'};
}
