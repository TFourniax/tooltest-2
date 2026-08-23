import { createHash } from 'node:crypto';

const FORBIDDEN_KEYS = new Set(['sourceCode','source_code','content','rawContent','raw_content','diff','patch','tool_input','toolInput','prompt','promptRaw','secret','token','credential']);
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const PROOF_CLAIMS = new Set(['causal','preservation','validation','not-required','inconclusive','unknown']);
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*[^\s,;]+/gi
];

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
  const projectPath=String(value || '').replaceAll('\\','/').replace(/^\.\//,'');
  if (!projectPath || projectPath.startsWith('/') || /^[A-Za-z]:\//.test(projectPath) || projectPath.includes('../')) return null;
  return projectPath.slice(0,300);
}

function unique(values) { return [...new Set((values || []).filter(Boolean))]; }
function cleanList(values,max=20) { return unique((values||[]).map((value)=>redact(value,160))).slice(0,max); }
function boundedInteger(value, label, max=2_147_483_647) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${label} must be a bounded non-negative integer.`);
  return value;
}

function safeTaskSummary(session=null, explanation=null) {
  const signals=session?.taskSignals || {};
  const file=cleanPath(signals.file || session?.currentResource || [...(session?.touchedFiles || [])].at(-1) || '');
  const symbol=redact(signals.symbol || '',100);
  const route=redact(signals.route || '',120);
  const table=redact(signals.table || '',120);
  const concept=redact(explanation?.concept?.name || explanation?.concept?.id || '',100);
  if (symbol && file) return `Work around ${symbol} in ${file}`;
  if (route && file) return `Work around route ${route} in ${file}`;
  if (table && file) return `Work around data surface ${table} in ${file}`;
  if (file) return `Work involving ${file}`;
  if (concept) return `Work involving ${concept}`;
  return null;
}

function stableSnapshotId(snapshot) {
  const stable={...snapshot};
  delete stable.generatedAt;
  delete stable.snapshotId;
  return `ipsnap_${digest(canonical(stable)).slice(0,24)}`;
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
  const filePaths=unique([
    ...(session?.touchedFiles || []).map(cleanPath),
    ...(explanation?.files || []).map((item)=>cleanPath(item.path)),
    ...(featureModel?.story || []).filter((item)=>item.type==='file').map((item)=>cleanPath(item.label))
  ]).slice(0,40);
  const surfaces=featureModel?.surfaces || {};
  const metrics=state.metrics || {};
  const snapshot={
    schema:'idleproof.portal-snapshot.v1',
    snapshotId:null,
    generatedAt:new Date().toISOString(),
    project:{ name:redact(state.project || 'project',120), localId:projectLocalId(state.project || 'project', state.createdAt || '') },
    task:{
      summary:safeTaskSummary(session,explanation),
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
      impact:{ blastRadius:Math.max(0,Number(projectModel.impact?.blastRadius || 0)) }
    } : null,
    files:filePaths,
    privacy:{ sourceCodeIncluded:false, rawDiffIncluded:false, rawAgentEventsIncluded:false, rawPromptIncluded:false, secretsRedacted:true }
  };
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

export const __portalTest={stableSnapshotId,MAX_SNAPSHOT_BYTES,assertAssuranceSafe};
