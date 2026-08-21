import { createHash } from 'node:crypto';

const FORBIDDEN_KEYS = new Set(['sourceCode','source_code','content','rawContent','raw_content','diff','patch','tool_input','toolInput','prompt','promptRaw','secret','token','credential']);
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

export function projectLocalId(project = '', seed = '') {
  return createHash('sha256').update(`${project}|${seed}`).digest('hex').slice(0,24);
}

export function buildPortalSnapshot({ state={}, session=null, featureModel=null, projectModel=null, explanation=null }={}) {
  const rawPrompt=String(session?.prompt || '');
  const filePaths=unique([
    ...(session?.touchedFiles || []).map(cleanPath),
    ...(explanation?.files || []).map((item)=>cleanPath(item.path)),
    ...(featureModel?.story || []).filter((item)=>item.type==='file').map((item)=>cleanPath(item.label))
  ]).slice(0,40);
  const surfaces=featureModel?.surfaces || {};
  const metrics=state.metrics || {};
  return {
    schema:'idleproof.portal-snapshot.v1',
    generatedAt:new Date().toISOString(),
    project:{ name:redact(state.project || 'project',120), localId:projectLocalId(state.project || 'project', state.createdAt || '') },
    task:{
      summary:safeTaskSummary(session,explanation),
      promptDigest:rawPrompt ? `sha256:${digest(rawPrompt)}` : null,
      promptChars:rawPrompt.length,
      source:redact(session?.source || 'agent',40),
      status:session?.status || null,
      changed:session?.changed || {added:0,deleted:0}
    },
    change:{ changeId:session?.proof?.changeId || null, diffSha256:session?.proof?.diffSha256 || null },
    explanation:explanation ? {
      concept:explanation.concept?.id || null,
      certainty:explanation.certainty?.level || null,
      files:(explanation.files || []).map((item)=>({ path:cleanPath(item.path), role:item.role, confidence:item.confidence })).filter((item)=>item.path).slice(0,20)
    } : null,
    feature:featureModel ? {
      fingerprint:featureModel.fingerprint || null,
      surfaces:{ routes:cleanList(surfaces.routes,20), tables:cleanList(surfaces.tables,20), technologies:cleanList(surfaces.technologies,20) },
      story:(featureModel.story || []).map((item)=>({ type:item.type, label:item.type==='file' ? cleanPath(item.label) : redact(item.label,160), role:item.role })).filter((item)=>item.label).slice(0,12),
      tests:(featureModel.tests || []).map(cleanPath).filter(Boolean).slice(0,12)
    } : null,
    understanding:{
      conceptsSeen:Number(metrics.conceptsSeen || 0),
      cognitiveCoverage:Number(metrics.coverage || 0),
      knowledgeDebt:Number(metrics.debt || 0),
      featuresSeen:Number(metrics.featuresSeen || 0),
      featureCoverage:Number(metrics.featureCoverage || 0),
      featureDebt:Number(metrics.featureDebt || 0)
    },
    projectMemory:projectModel ? { stats:projectModel.stats || null, impact:{ blastRadius:Number(projectModel.impact?.blastRadius || 0) } } : null,
    files:filePaths,
    privacy:{ sourceCodeIncluded:false, rawDiffIncluded:false, rawAgentEventsIncluded:false, rawPromptIncluded:false, secretsRedacted:true }
  };
}

export function assertPortalSnapshotSafe(snapshot) {
  const visit=(value,key='root')=>{
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`Forbidden portal field: ${key}`);
    if (Array.isArray(value)) return value.forEach((item)=>visit(item,key));
    if (value && typeof value==='object') for (const [childKey,child] of Object.entries(value)) visit(child,childKey);
  };
  visit(snapshot);
  if (
    snapshot?.privacy?.sourceCodeIncluded !== false ||
    snapshot?.privacy?.rawDiffIncluded !== false ||
    snapshot?.privacy?.rawAgentEventsIncluded !== false ||
    snapshot?.privacy?.rawPromptIncluded !== false
  ) throw new Error('Portal snapshot privacy declaration is not fail-closed.');
  return true;
}
