import { normalizedProjectPath } from './project-path.mjs';
import { createHash } from 'node:crypto';
import { validContext, validContextIdentity } from './continuity-contract.mjs';

const FORBIDDEN_KEYS = new Set(['sourceCode','source_code','content','rawContent','raw_content','diff','patch','tool_input','toolInput','prompt','promptRaw','secret','token','credential']);
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const PROOF_CLAIMS = new Set(['causal','preservation','validation','not-required','inconclusive','unknown']);
const EPISTEMIC = new Set(['DECLARED','INFERRED','OBSERVED','VERIFIED','UNKNOWN']);
const REPOSITORY_FINGERPRINT_RE = /^dwrepo_[a-f0-9]{24}$/;
const SECRET_PATTERNS = [
  /ipd_[A-Za-z0-9_-]{20,}/gi,
  /(?<![\p{L}\p{N}\p{M}])sk-[A-Za-z0-9_-]{12,}/gu,
  /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_.-]{20,}/g,
  /gl(?:pat|oas|dt|rt|rtr|cbt|ptt|ft|imt|agent|wt|soat|ffct)-[A-Za-z0-9_.-]{16,}/g,
  /_gitlab_session=[^\s;]+/g,
  /(?:sb_secret_|sbp_|supabase_pat_)[A-Za-z0-9_-]{20,}/g,
  /[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /npm_[A-Za-z0-9]{36,}/g,
  /pypi-[A-Za-z0-9_-]{85,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*[^\s,;]+/gi
];
// Underscores and other word characters delimit opaque IDs too. A display-text
// word boundary must not allow credential bytes through the identity allowlist.
const IDENTITY_SECRET_PATTERNS=SECRET_PATTERNS.map(pattern=>new RegExp(pattern.source.replaceAll('\\b',''),pattern.flags.replace('g','')));

function digest(value = '') {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item)=>canonical(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function redact(value = '', max = 240) {
  let text=String(value || '').replace(/\s+/g,' ').trim();
  for (const pattern of SECRET_PATTERNS) text=text.replace(pattern,'[redacted]');
  return text.length<=max ? text : `${text.slice(0,max-1).trimEnd()}…`;
}

function cleanPath(value = '') {
  const projectPath=normalizedProjectPath(value);
  // A literal POSIX backslash cannot be a portable source path. Omit it,
  // including foreign Windows/UNC paths, instead of exporting an alias.
  if (projectPath.includes('\\')) return null;
  if (!projectPath || projectPath.length>300 || /[\u0000-\u001f\u007f-\u009f]/.test(projectPath) || projectPath.startsWith('/') || /^[A-Za-z]:\//.test(projectPath) || projectPath.split('/').includes('..')) return null;
  return projectPath;
}

function pathCoverageWarning(paths, rowLimited=[]) {
  const rejected=new Set(paths.map(normalizedProjectPath).filter(value=>value && cleanPath(value)===null));
  const limited=new Set(rowLimited.map(cleanPath).filter(Boolean));
  const omitted=new Set([...rejected,...limited]);
  if (!omitted.size) return null;
  const long=[...omitted].filter(value=>value.length>300).length;
  return `Portal path coverage incomplete: ${omitted.size} unique path(s) omitted (${long} exceed 300 characters; ${rejected.size-long} are not portable relative paths${limited.size ? `; ${limited.size} hit projection row limits` : ''}).`;
}

function pathsBeyondLimit(paths, limit) {
  const admitted=paths.map(cleanPath).filter(Boolean);
  const retained=new Set(admitted.slice(0,limit));
  return admitted.slice(limit).filter(value=>!retained.has(value));
}

function storyLimitedPaths(story) {
  const admitted=(story || []).filter(item=>item.type==='file' ? cleanPath(item.label) : redact(item.label,160));
  const retained=new Set(admitted.slice(0,12).filter(item=>item.type==='file').map(item=>cleanPath(item.label)));
  return admitted.slice(12).filter(item=>item.type==='file' && !retained.has(cleanPath(item.label))).map(item=>item.label);
}

function continuityLimitedPaths(value) {
  if (!value) return [];
  const components=(value.components || []).map(continuityComponent).filter(Boolean);
  const changes=(value.recentRelatedChanges || []).filter(item=>/^dwchg_[a-f0-9]{24}$/.test(item.changeId));
  return [...components.slice(12).map(item=>item.path),
    ...changes.slice(0,8).flatMap(item=>pathsBeyondLimit(item.files || [],8)),
    ...changes.slice(8).flatMap(item=>item.files || [])];
}

function continuityPaths(value) {
  return [...(value?.components || []).map(item=>item.path), ...(value?.recentRelatedChanges || []).flatMap(item=>item.files || [])];
}

function prependWarning(memory, warning) {
  if (warning) memory.warnings=unique([warning,...memory.warnings]).slice(0,8);
}

function unique(values) { return [...new Set((values || []).filter(Boolean))]; }
function cleanList(values,max=20) { return unique((values||[]).map((value)=>redact(value,160))).slice(0,max); }
function boundedInteger(value, label, max=2_147_483_647) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${label} must be a bounded non-negative integer.`);
  return value;
}

function epistemic(value) {
  const normalized=String(value || 'UNKNOWN').toUpperCase();
  return EPISTEMIC.has(normalized) ? normalized : 'UNKNOWN';
}

// Identity is never a display label: truncation/redaction would create aliases.
function continuityIdentity(value) {
  return validContextIdentity(value) && !IDENTITY_SECRET_PATTERNS.some(pattern=>pattern.test(value)) ? value : null;
}

function continuityEntity(item={}) {
  const id=continuityIdentity(item.id);
  const label=redact(item.label || item.title || '',240) || null;
  if (!id) return null;
  const lifecycle=item.lifecycle?.action==='confirmed' ? {
    action:'confirmed', active:true, status:'DECLARED', reason:redact(item.lifecycle.reason,240),
    sourceEventId:item.lifecycle.sourceEventId, assertionEventId:item.lifecycle.assertionEventId
  } : null;
  const source=item.source ? {kind:'project-event',eventId:item.source.eventId,eventHash:item.source.eventHash} : null;
  return { id, status:epistemic(item.epistemicStatus || item.epistemic_status), label, ...(source ? {source} : {}), ...(lifecycle ? {lifecycle} : {}) };
}

function continuityComponent(item={}) {
  const path=cleanPath(item.path || '');
  const id=continuityIdentity(item.id);
  if (!path || !id) return null;
  return {
    id,
    status:epistemic(item.epistemicStatus || item.epistemic_status),
    path,
    provider:redact(item.provider || '',60) || null
  };
}

function continuityRelation(item={}) {
  const predicate=continuityIdentity(item.predicate);
  const sourceId=continuityIdentity(item.source);
  const targetId=continuityIdentity(item.target);
  if (!predicate || !sourceId || !targetId) return null;
  return { predicate, sourceId, targetId, status:epistemic(item.epistemicStatus || item.epistemic_status) };
}

function continuityDebt(item={}) {
  const id=continuityIdentity(item.debt_id);
  if (!id) return null;
  return {
    id,
    status:redact(item.status || 'open',32),
    epistemicStatus:epistemic(item.epistemic_status || item.epistemicStatus),
    introducedChangeId:/^dwchg_[a-f0-9]{24}$/.test(String(item.introduced_change_id || item.introducedChangeId || '')) ? String(item.introduced_change_id || item.introducedChangeId) : null,
    lastChangeId:/^dwchg_[a-f0-9]{24}$/.test(String(item.last_change_id || item.lastChangeId || '')) ? String(item.last_change_id || item.lastChangeId) : null
  };
}

function continuityChange(item={}) {
  const changeId=String(item.changeId || item.change_id || '');
  if (!/^dwchg_[a-f0-9]{24}$/.test(changeId)) return null;
  const proof=item.proof && typeof item.proof==='object' ? item.proof : null;
  const debt=item.softwareDebt && typeof item.softwareDebt==='object' ? item.softwareDebt : null;
  return {
    changeId,
    files:(item.files || []).map(cleanPath).filter(Boolean).slice(0,8),
    proof:proof ? {
      claim:PROOF_CLAIMS.has(String(proof.claim || '')) ? String(proof.claim) : 'unknown',
      accepted:typeof proof.accepted==='boolean' ? proof.accepted : null,
      epistemicStatus:epistemic(proof.epistemicStatus || proof.epistemic_status)
    } : null,
    softwareDebt:debt ? {
      points:Number.isInteger(debt.points) && debt.points>=0 ? Math.min(debt.points,1_000_000_000) : null,
      obligations:Number.isInteger(debt.obligations) && debt.obligations>=0 ? Math.min(debt.obligations,1_000_000) : null,
      budgetPassed:[true,false,null].includes(debt.budgetPassed) ? debt.budgetPassed : null
    } : null
  };
}

function safeContinuityMemory(value) {
  if (!validContext(value)) return null;
  const contextId=String(value.context_id || '');
  if (!/^dwctx_[a-f0-9]{24}$/.test(contextId)) return null;
  const entities=(items,max)=> (Array.isArray(items)?items:[]).map(continuityEntity).filter(Boolean).slice(0,max);
  const identities=[...['objectives','tasks','decisions','invariants','failedApproaches','components'].flatMap(key=>(value[key] || []).map(item=>item.id)),
    ...value.knownDebt.map(item=>item.debt_id), ...value.relations.flatMap(item=>[item.source,item.target,item.predicate])];
  const omitted=identities.some(id=>continuityIdentity(id)===null);
  const warnings=value.warnings.slice(0,omitted ? 7 : 8).map(value=>redact(value,240));
  if (omitted) warnings.unshift('Some memory rows were omitted because their identities contain sensitive data.');
  const memory={
    schema:'idleproof.portal-continuity.v1',
    contextId,
    eventHead:/^[a-f0-9]{64}$/.test(String(value.state?.eventHead || '')) ? value.state.eventHead : null,
    structureTree:/^[a-f0-9]{40,64}$/.test(String(value.state?.structureTree || '')) ? value.state.structureTree : null,
    objectives:entities(value.objectives,8),
    tasks:entities(value.tasks,8),
    decisions:entities(value.decisions,8),
    invariants:entities(value.invariants,8),
    failedApproaches:entities(value.failedApproaches,8),
    components:(Array.isArray(value.components)?value.components:[]).map(continuityComponent).filter(Boolean).slice(0,12),
    relations:(Array.isArray(value.relations)?value.relations:[]).map(continuityRelation).filter(Boolean).slice(0,16),
    knownDebt:(Array.isArray(value.knownDebt)?value.knownDebt:[]).map(continuityDebt).filter(Boolean).slice(0,12),
    recentChanges:(Array.isArray(value.recentRelatedChanges)?value.recentRelatedChanges:[]).map(continuityChange).filter(Boolean).slice(0,8),
    warnings
  };
  // A locally known row that is omitted cannot remain a projected endpoint.
  // External citations absent from the input context are not invented rows.
  const sourceIds=new Set(['objectives','tasks','decisions','invariants','failedApproaches','components'].flatMap(key=>(value[key] || []).map(item=>item.id)));
  for (const item of value.knownDebt) sourceIds.add(item.debt_id);
  for (const item of value.recentRelatedChanges) sourceIds.add(item.changeId);
  const retainedIds=new Set(['objectives','tasks','decisions','invariants','failedApproaches','components','knownDebt'].flatMap(key=>memory[key].map(item=>item.id)));
  for (const item of memory.recentChanges) retainedIds.add(item.changeId);
  const removedIds=new Set([...sourceIds].filter(id=>!retainedIds.has(id)));
  memory.relations=memory.relations.filter(item=>!removedIds.has(item.sourceId)&&!removedIds.has(item.targetId));
  if (removedIds.size || memory.relations.length<value.relations.length) prependWarning(memory,'Some memory rows or relations were omitted by Portal privacy, path or row limits; coverage is incomplete.');
  prependWarning(memory,pathCoverageWarning(continuityPaths(value),continuityLimitedPaths(value)));
  return memory;
}

function safeTaskSummary(session=null, explanation=null) {
  const signals=session?.taskSignals || {};
  const file=cleanPath(signals.file || session?.currentResource || [...(session?.touchedFiles || [])].at(-1) || '');
  const symbol=redact(signals.symbol || '',100);
  const route=redact(signals.route || '',120);
  const table=redact(signals.table || '',120);
  const concept=redact(explanation?.concept?.name || explanation?.concept?.id || '',100);
  if (symbol && file && `Work around ${symbol} in ${file}`.length<=300) return `Work around ${symbol} in ${file}`;
  if (route && file && `Work around route ${route} in ${file}`.length<=300) return `Work around route ${route} in ${file}`;
  if (table && file && `Work around data surface ${table} in ${file}`.length<=300) return `Work around data surface ${table} in ${file}`;
  if (file) return `Work involving ${file}`.length<=300 ? `Work involving ${file}` : 'Work involving a file listed in this snapshot.';
  if (concept) return `Work involving ${concept}`;
  return null;
}

function stableSnapshotId(snapshot) {
  const stable={...snapshot};
  delete stable.generatedAt;
  delete stable.snapshotId;
  return `ipsnap_${digest(canonical(stable)).slice(0,24)}`;
}

function fitContinuitySnapshotBudget(snapshot) {
  const memory=snapshot.projectMemory?.continuity;
  if (!memory || Buffer.byteLength(JSON.stringify(snapshot),'utf8')<=MAX_SNAPSHOT_BYTES) return;
  memory.warnings=[...memory.warnings.slice(0,7),'Project memory was reduced to fit the Portal snapshot size limit.'];
  // Keep higher-ranked rows intact and prioritize current task/assertion memory
  // over ancillary rows. Budget the complete wire payload, including its ID.
  for(const key of ['relations','components','knownDebt','recentChanges','failedApproaches','invariants','decisions','objectives','tasks']) {
    while(memory[key].length && Buffer.byteLength(JSON.stringify(snapshot),'utf8')>MAX_SNAPSHOT_BYTES) memory[key].pop();
  }
  // If non-memory content alone is oversized, the existing safety gate rejects
  // it. Never drop Proof/Protect data or relax the wire-size limit to fit memory.
}

function promptMetadata(session=null) {
  const bounded=String(session?.prompt || '');
  const chars=Number.isInteger(session?.promptChars) && session.promptChars>=0 ? session.promptChars : bounded.length;
  const storedDigest=/^[a-f0-9]{64}$/.test(String(session?.promptSha256 || '')) ? session.promptSha256 : (bounded ? digest(bounded) : null);
  return { chars, digest:storedDigest ? `sha256:${storedDigest}` : null };
}

function assertAssuranceSafe(assurance) {
  if (assurance == null) return true;
  if (!assurance || typeof assurance !== 'object' || Array.isArray(assurance) || assurance.schema !== 'idleproof.change-assurance.v1') throw new Error('Portal assurance has an unsupported schema.');
  const allowedRoot=new Set(['schema','proof','softwareDebt']);
  for (const key of Object.keys(assurance)) if (!allowedRoot.has(key)) throw new Error(`Unexpected Portal assurance field: ${key}`);
  if (!assurance.proof && !assurance.softwareDebt) throw new Error('Portal assurance must contain Proof or Software Debt metadata.');
  if (assurance.proof) {
    const proof=assurance.proof;
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw new Error('Portal proof assurance is invalid.');
    if (!PROOF_CLAIMS.has(proof.claim) || typeof proof.accepted !== 'boolean') throw new Error('Portal proof assurance has invalid semantics.');
    if (typeof proof.certificateId !== 'string' || proof.certificateId.length < 6 || proof.certificateId.length > 128 || /[\u0000-\u001f\u007f\s]/.test(proof.certificateId)) throw new Error('Portal proof certificate id is invalid.');
  }
  if (assurance.softwareDebt) {
    const debt=assurance.softwareDebt;
    if (!debt || typeof debt !== 'object' || Array.isArray(debt)) throw new Error('Portal software-debt assurance is invalid.');
    boundedInteger(debt.points,'Software-debt points',1_000_000_000);
    boundedInteger(debt.obligations,'Software-debt obligations',1_000_000);
    if (![true,false,null].includes(debt.budgetPassed)) throw new Error('Portal software-debt budget state is invalid.');
  }
  return true;
}

export function assuranceFromChangeEnvelope(envelope, expectedChangeId) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Change envelope must be a JSON object.');
  if (envelope.schema_version !== 'change-envelope-1') throw new Error('Unsupported change-envelope schema.');
  const changeId=String(envelope.change_id || '');
  if (!/^dwchg_[a-f0-9]{24}$/.test(changeId)) throw new Error('Change envelope has an invalid change id.');
  if (!/^dwchg_[a-f0-9]{24}$/.test(String(expectedChangeId || '')) || changeId !== expectedChangeId) throw new Error('Change envelope does not match the current IdleProof change.');
  if (envelope.privacy?.code_uploaded === true || envelope.privacy?.contains_prompt_text === true) throw new Error('Change envelope privacy declaration is not safe for Portal sync.');

  let proof=null;
  if (envelope.proof != null) {
    const value=envelope.proof;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.tool !== 'diffwitness') throw new Error('Change envelope Proof metadata is invalid.');
    const claim=String(value.claim || '');
    if (!PROOF_CLAIMS.has(claim) || typeof value.accepted !== 'boolean') throw new Error('Change envelope Proof semantics are invalid.');
    const certificateId=String(value.certificate_id || '');
    if (certificateId.length < 6 || certificateId.length > 128 || /[\u0000-\u001f\u007f\s]/.test(certificateId)) throw new Error('Change envelope certificate id is invalid.');
    proof={ claim, accepted:value.accepted, certificateId };
  }

  let softwareDebt=null;
  if (envelope.debt != null) {
    const value=envelope.debt;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.report_schema !== 'debt-report-1') throw new Error('Change envelope Debt metadata is invalid.');
    const lineages=value.open_lineages;
    if (!Array.isArray(lineages) || lineages.length > 1_000_000 || lineages.some((id)=>!/^DW-[0-9A-F]{12}$/.test(String(id)))) throw new Error('Change envelope Debt lineages are invalid.');
    softwareDebt={
      points:boundedInteger(value.points,'Software-debt points',1_000_000_000),
      obligations:new Set(lineages).size,
      budgetPassed:value.budget_passed == null ? null : Boolean(value.budget_passed)
    };
  }

  if (!proof && !softwareDebt) throw new Error('Change envelope has no Portal-safe assurance metadata.');
  const assurance={ schema:'idleproof.change-assurance.v1', proof, softwareDebt };
  assertAssuranceSafe(assurance);
  return assurance;
}

export function projectLocalId(project = '', seed = '') {
  return createHash('sha256').update(`${project}|${seed}`).digest('hex').slice(0,24);
}

export function buildPortalSnapshot({ state={}, session=null, featureModel=null, projectModel=null, explanation=null, assurance=null }={}) {
  assertAssuranceSafe(assurance);
  const prompt=promptMetadata(session);
  const allFilePaths=unique([
    ...(session?.touchedFiles || []).map(cleanPath),
    ...(explanation?.files || []).map((item)=>cleanPath(item.path)),
    ...(featureModel?.story || []).filter((item)=>item.type==='file').map((item)=>cleanPath(item.label))
  ]);
  const filePaths=allFilePaths.slice(0,40);
  const surfaces=featureModel?.surfaces || {};
  const metrics=state.metrics || {};
  const continuity=safeContinuityMemory(projectModel?.continuity || null);
  const pathWarning=pathCoverageWarning([
    ...(session?.touchedFiles || []), session?.currentResource, session?.taskSignals?.file,
    ...(explanation?.files || []).map(item=>item.path),
    ...(featureModel?.story || []).filter(item=>item.type==='file').map(item=>item.label),
    ...(featureModel?.tests || []), ...(continuity ? continuityPaths(projectModel.continuity) : [])
  ], [
    ...allFilePaths.slice(40),
    ...pathsBeyondLimit((explanation?.files || []).map(item=>item.path),20),
    ...storyLimitedPaths(featureModel?.story),
    ...pathsBeyondLimit(featureModel?.tests || [],12),
    ...continuityLimitedPaths(continuity ? projectModel.continuity : null)
  ]);
  if (continuity) prependWarning(continuity,pathWarning);
  const taskSummary=safeTaskSummary(session,explanation);
  // Preserve existing v1 consumers: coverage is visible in their existing text
  // fields. Do not add an unsupported field or truncate a path into an alias.
  const compactTask=filePaths.length ? 'Work involving the files listed in this snapshot.' : 'Work with partial path coverage.';
  const summary=pathWarning ? `${taskSummary && `${taskSummary} ${pathWarning}`.length<=300 ? taskSummary : compactTask} ${pathWarning}` : taskSummary;
  const repositoryFingerprint=REPOSITORY_FINGERPRINT_RE.test(String(projectModel?.repositoryFingerprint || '')) ? String(projectModel.repositoryFingerprint) : null;
  const snapshot={
    schema:'idleproof.portal-snapshot.v1',
    snapshotId:null,
    generatedAt:new Date().toISOString(),
    project:{ name:redact(state.project || 'project',120), localId:projectLocalId(state.project || 'project', state.createdAt || ''), repositoryFingerprint },
    task:{
      summary,
      promptDigest:prompt.digest,
      promptChars:prompt.chars,
      source:redact(session?.source || 'agent',40),
      status:session?.status || null,
      changed:{
        added:Math.max(0,Number(session?.changed?.added || 0)),
        deleted:Math.max(0,Number(session?.changed?.deleted || 0))
      }
    },
    change:{ changeId:session?.proof?.changeId || null, diffSha256:session?.proof?.diffSha256 || null },
    assurance,
    explanation:explanation ? {
      concept:explanation.concept?.id || null,
      certainty:explanation.certainty?.level || null,
      files:(explanation.files || []).map((item)=>({ path:cleanPath(item.path), role:redact(item.role,60), confidence:redact(item.confidence,40) })).filter((item)=>item.path).slice(0,20)
    } : null,
    feature:featureModel ? {
      fingerprint:redact(featureModel.fingerprint || '',128) || null,
      surfaces:{ routes:cleanList(surfaces.routes,20), tables:cleanList(surfaces.tables,20), technologies:cleanList(surfaces.technologies,20) },
      story:(featureModel.story || []).map((item)=>({ type:redact(item.type,40), label:item.type==='file' ? cleanPath(item.label) : redact(item.label,160), role:redact(item.role,60) })).filter((item)=>item.label).slice(0,12),
      tests:(featureModel.tests || []).map(cleanPath).filter(Boolean).slice(0,12)
    } : null,
    understanding:{
      conceptsSeen:Math.max(0,Number(metrics.conceptsSeen || 0)),
      cognitiveCoverage:Math.min(100,Math.max(0,Number(metrics.coverage || 0))),
      knowledgeDebt:Math.max(0,Number(metrics.debt || 0)),
      featuresSeen:Math.max(0,Number(metrics.featuresSeen || 0)),
      featureCoverage:Math.min(100,Math.max(0,Number(metrics.featureCoverage || 0))),
      featureDebt:Math.max(0,Number(metrics.featureDebt || 0))
    },
    projectMemory:projectModel ? {
      stats:projectModel.stats ? {
        features:Math.max(0,Number(projectModel.stats.features || 0)),
        files:Math.max(0,Number(projectModel.stats.files || 0)),
        sharedFiles:Math.max(0,Number(projectModel.stats.sharedFiles || 0)),
        boundaryNodes:Math.max(0,Number(projectModel.stats.boundaryNodes || 0))
      } : null,
      impact:{ blastRadius:Math.max(0,Number(projectModel.impact?.blastRadius || 0)) },
      continuity
    } : null,
    files:filePaths,
    privacy:{ sourceCodeIncluded:false, rawDiffIncluded:false, rawAgentEventsIncluded:false, rawPromptIncluded:false, secretsRedacted:true }
  };
  snapshot.snapshotId=`ipsnap_${'0'.repeat(24)}`; // Reserve the exact final wire width.
  fitContinuitySnapshotBudget(snapshot);
  snapshot.snapshotId=stableSnapshotId(snapshot);
  return snapshot;
}

export function assertPortalSnapshotSafe(snapshot) {
  const visit=(value,key='root')=>{
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`Forbidden portal field: ${key}`);
    if (Array.isArray(value)) return value.forEach((item)=>visit(item,key));
    if (value && typeof value==='object') for (const [childKey,child] of Object.entries(value)) visit(child,childKey);
  };
  visit(snapshot);
  assertAssuranceSafe(snapshot?.assurance ?? null);
  if (!/^ipsnap_[a-f0-9]{24}$/.test(String(snapshot?.snapshotId || ''))) throw new Error('Portal snapshot has no valid idempotency key.');
  if (stableSnapshotId(snapshot)!==snapshot.snapshotId) throw new Error('Portal snapshot idempotency key does not match its payload.');
  if (snapshot?.project?.repositoryFingerprint != null && !REPOSITORY_FINGERPRINT_RE.test(String(snapshot.project.repositoryFingerprint))) throw new Error('Portal snapshot repository fingerprint is invalid.');
  if (
    snapshot?.privacy?.sourceCodeIncluded !== false ||
    snapshot?.privacy?.rawDiffIncluded !== false ||
    snapshot?.privacy?.rawAgentEventsIncluded !== false ||
    snapshot?.privacy?.rawPromptIncluded !== false
  ) throw new Error('Portal snapshot privacy declaration is not fail-closed.');
  const bytes=Buffer.byteLength(JSON.stringify(snapshot),'utf8');
  if (bytes>MAX_SNAPSHOT_BYTES) throw new Error(`Portal snapshot exceeds ${MAX_SNAPSHOT_BYTES} byte safety budget.`);
  return true;
}

export const __portalTest={stableSnapshotId,MAX_SNAPSHOT_BYTES,assertAssuranceSafe,safeContinuityMemory,REPOSITORY_FINGERPRINT_RE};
