import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { inferFileRole } from './semantics.mjs';
import { readProjectSource } from './project-source.mjs';
import { loadStructureExtractions, supportsStructurePath, structureLanguageFor } from './structure-provider.mjs';

const MAX_RELATED_FILES = 8;
const cache = new Map();

const TECHNOLOGIES = [
  ['Stripe', /\bstripe\b/i], ['Supabase', /\bsupabase\b/i], ['PostgreSQL', /\bpostgres(?:ql)?\b|\bpsycopg\b/i],
  ['MySQL', /\bmysql\b/i], ['SQLite', /\bsqlite\b/i], ['MongoDB', /\bmongodb\b|\bmongoose\b/i],
  ['OAuth', /\boauth\b/i], ['OpenID Connect', /\boidc\b|open\s?id/i], ['JWT', /\bjwt\b/i],
  ['React', /\breact\b/i], ['Next.js', /\bnext(?:\.js|js)?\b/i], ['Vite', /\bvite\b/i], ['Vue', /\bvue\b/i], ['Svelte', /\bsvelte\b/i],
  ['Prisma', /\bprisma\b/i], ['Drizzle', /\bdrizzle\b/i], ['Redis', /\bredis\b/i], ['Valkey', /\bvalkey\b/i],
  ['Kafka', /\bkafka\b/i], ['RabbitMQ', /\brabbitmq\b|\bamqp\b/i], ['Celery', /\bcelery\b/i],
  ['GitHub Actions', /github\s+actions|\.github\/workflows/i], ['Docker', /\bdocker\b/i], ['Kubernetes', /\bkubernetes\b|\bk8s\b/i],
  ['Terraform', /\bterraform\b|\.tf\b/i], ['AWS', /\baws\b|amazon web services|\bboto3\b/i], ['S3', /\b(?:aws\s*)?s3\b/i],
  ['Google Cloud', /google cloud|\bgcp\b/i], ['Firebase', /\bfirebase\b/i], ['Azure', /\bazure\b/i],
  ['Playwright', /\bplaywright\b/i], ['Vitest', /\bvitest\b/i], ['Jest', /\bjest\b/i], ['Pytest', /\bpytest\b/i],
  ['FastAPI', /\bfastapi\b/i], ['Django', /\bdjango\b/i], ['Flask', /\bflask\b/i], ['Rails', /\brails\b|active\s*record/i],
  ['Laravel', /\blaravel\b/i], ['Spring', /\bspring(?:boot)?\b/i], ['.NET', /\basp\.net\b|\bdotnet\b|\b\.net\b/i],
  ['OpenAI', /\bopenai\b/i], ['Anthropic', /\banthropic\b|\bclaude\b/i]
];

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stripCommentEvidence(text = '') {
  // Comments are useful to humans but are weak evidence for what code actually does. Remove the
  // common comment-only forms before extracting symbols/routes/tables/technology signals so an old
  // note cannot silently become an IdleProof "fact". Strings and executable lines stay untouched.
  const withoutBlocks = String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n');
  return withoutBlocks.split(/\r?\n/).map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//')) return '';
    if (trimmed.startsWith('--')) return '';
    if (trimmed.startsWith('#')) {
      // Preserve shebangs, Rust attributes and C/C++ preprocessor directives.
      if (/^#!|^#\[|^#\s*(?:include|define|if|ifdef|ifndef|elif|else|endif|pragma|error)\b/.test(trimmed)) return line;
      return '';
    }
    return line;
  }).join('\n');
}

function symbolsFromText(text) {
  const symbols = [];
  const patterns = [
    /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/g,
    /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/g,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
    /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm,
    /^\s*class\s+([A-Za-z_][\w]*)\s*(?:\(|:)/gm,
    /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/gm,
    /\bfn\s+([A-Za-z_][\w]*)\s*[<(]/g,
    /\b(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|abstract\s+)*(?:class|interface|enum|record|struct)\s+([A-Za-z_][\w]*)\b/g,
    /^\s*def\s+([A-Za-z_][\w!?=]*)\b/gm,
    /\bfunction\s+([A-Za-z_][\w]*)\s*\(/g,
    /\b(?:func|function)\s+([A-Za-z_][\w]*)\s*\(/g
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) symbols.push(match[1]);
  return unique(symbols).slice(0, 60);
}

function externalDependency(value, language = null) {
  const target=String(value || '').trim();
  if(!target||target.startsWith('.')||target.startsWith('/')||target.startsWith('#')
      ||target.startsWith('node:')||target.startsWith('file:')||target.startsWith('data:')
      ||/^[A-Za-z]:[\\/]/.test(target)) return null;
  if(['javascript','typescript'].includes(language)&&isBuiltin(target)) return null;
  if(language==='rust'&&['crate','self','super','std','core','alloc'].includes(target.replace(/^::/,'').split('::')[0])) return null;
  // Go standard and unresolved local names have no host-qualified first segment.
  // Raw imports remain available in canonical extraction; do not label them as
  // third-party task dependencies without an external-looking module path.
  if(language==='go'&&!target.split('/')[0].includes('.')) return null;
  return target;
}

function dependenciesFromText(text) {
  const dependencies = [];
  const add = (value) => {
    const cleaned = externalDependency(value);
    if (!cleaned) return;
    dependencies.push(cleaned);
  };
  for (const match of text.matchAll(/\b(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?['"`]([^'"`]+)['"`]/g)) add(match[1]);
  for (const match of text.matchAll(/\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) add(match[1]);
  for (const match of text.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm)) add(match[1].split('.')[0]);
  for (const block of text.matchAll(/\bimport\s*\(([^)]*)\)/gs)) for (const match of String(block[1]).matchAll(/["`]([^"`]+)["`]/g)) add(match[1]);
  for (const match of text.matchAll(/^\s*import\s+["`]([^"`]+)["`]/gm)) add(match[1]);
  for (const match of text.matchAll(/^\s*use\s+([A-Za-z_][\w]*)::/gm)) if (!['crate','self','super','std','core','alloc'].includes(match[1])) add(match[1]);
  for (const match of text.matchAll(/^\s*import\s+([A-Za-z_][\w.]*)\s*;?$/gm)) add(match[1].split('.').slice(0, 3).join('.'));
  for (const match of text.matchAll(/^\s*require(?:_relative)?\s*[('" ]+([^'"\s)]+)/gm)) add(match[1]);
  return unique(dependencies).slice(0, 24);
}

function routesFromText(text) {
  const routes = [];
  const literal = /["'`]((?:\/api\/|\/auth\/|\/webhooks?\/|\/admin(?:\/|$)|\/v\d+\/)[^"'`\s)]*)["'`]/g;
  for (const match of text.matchAll(literal)) routes.push(match[1]);
  for (const match of text.matchAll(/\b(?:app|router|server)\.(?:get|post|put|patch|delete|use)\s*\(\s*["'`]([^"'`]+)["'`]/g)) routes.push(match[1]);
  for (const match of text.matchAll(/@(?:app|router)\.(?:get|post|put|patch|delete)\s*\(\s*[rRuU]?["']([^"']+)["']/g)) routes.push(match[1]);
  for (const match of text.matchAll(/@(?:RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g)) routes.push(match[1]);
  return unique(routes).slice(0, 16);
}

function tablesFromText(text) {
  const tables = [];
  const source = String(text).split(/\r?\n/).filter((line) => !/^\s*from\s+[.A-Za-z_][\w.]*\s+import\b/i.test(line)).join('\n');
  const patterns = [
    /\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`]?([A-Za-z_][\w.]*)/gi,
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+["`]?([A-Za-z_][\w.]*)/gi,
    /\.(?:from|table)\s*\(\s*["'`]([A-Za-z_][\w.-]*)["'`]\s*\)/gi,
    /\b__tablename__\s*=\s*["']([A-Za-z_][\w.-]*)["']/gi
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) tables.push(match[1]);
  return unique(tables).slice(0, 24);
}

function wordTokens(value = '') {
  return new Set(String(value).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []);
}

function chooseSymbol(symbols, prompt) {
  if (!symbols.length) return null;
  const tokens = wordTokens(prompt);
  const scored = symbols.map((symbol, index) => {
    const parts = String(symbol).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const hits = parts.filter((part) => tokens.has(part)).length;
    return { symbol, score:hits * 10 - index * 0.01 };
  }).sort((a, b) => b.score - a.score);
  return scored[0].symbol;
}

function technologiesFrom(text) {
  return TECHNOLOGIES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function preferredContextFile(session = {}) {
  const touched = [...(session.touchedFiles || [])].at(-1) || null;
  const live = session.currentResource || null;
  const capabilities = new Set(session.currentCapabilities || []);
  const reading = capabilities.has('code.read') || capabilities.has('database.read') || capabilities.has('scm.read');
  return reading ? (live || touched) : (touched || live);
}

function inspectTaskFile(cwd, file, prompt, admitted, extractions) {
  const safe = admitted.get(file);
  if (!safe) {
    const fallback = { file:file || null, symbol:null, route:null, table:null, technologies:technologiesFrom(prompt), dependencies:[], importReferences:[], symbols:[],
      structureCoverage:{provider:'unavailable',parsed:null,canonical:false,reason:'source-unavailable'} };
    return { ...fallback, fileRole:inferFileRole(file || '', fallback) };
  }
  const canonical = extractions.byPath.get(safe.relative);
  const structureCoverage = canonical
    ? {provider:canonical.provider,sourceSha256:safe.sha256,parsed:canonical.parsed,canonical:true}
    : {provider:'legacy-heuristic',sourceSha256:safe.sha256,parsed:null,canonical:false,
       reason:supportsStructurePath(safe.relative) ? extractions.reason : 'language-adapter-pending'};
  const cacheKey = JSON.stringify([safe.absolute, safe.sha256, createHash('sha256').update(prompt).digest('hex'),
                                 canonical||structureCoverage]);
  if (cache.has(cacheKey)) return structuredClone(cache.get(cacheKey));

  const evidenceText = stripCommentEvidence(safe.text);
  const sourceLanguage = canonical?.language || structureLanguageFor(safe.relative);
  const dataSource = ['sql','json','toml','yaml'].includes(sourceLanguage);
  const unresolvedOrigin = ['java','kotlin','csharp','ruby','php'].includes(sourceLanguage);
  const displayName = symbol => {
    const name=canonical.language==='python' ? symbol.qualified_name : symbol.qualified_name.slice(safe.relative.length+2);
    return dataSource ? name : name.split('.').at(-1);
  };
  const symbols = canonical ? unique(canonical.symbols.map(displayName)).slice(0,60)
                            : dataSource ? [] : symbolsFromText(evidenceText);
  // Data syntax has its own admitted facts. Values and SQL literal/query text
  // must not re-enter task facts through the legacy code-language heuristics.
  const routes = dataSource ? [] : routesFromText(`${prompt}\n${evidenceText}`);
  const tables = dataSource ? sourceLanguage==='sql'&&canonical
    ? canonical.symbols.filter(symbol=>symbol.kind==='table').map(displayName) : []
    : tablesFromText(`${prompt}\n${evidenceText}`);
  const importReferences = canonical ? unique(canonical.imports.map(item=>item.target)).slice(0,24) : [];
  const dependencies = dataSource||unresolvedOrigin ? [] : canonical ? unique(canonical.imports.map(item=>externalDependency(
    canonical.language==='python' ? item.target.split('.')[0] : item.target,canonical.language))).slice(0,24)
    : dependenciesFromText(evidenceText);
  const base = {
    file:safe.relative,
    symbol:chooseSymbol(symbols, prompt),
    route:routes[0] || null,
    table:tables[0] || null,
    technologies:unique(technologiesFrom(dataSource ? prompt : `${prompt}\n${evidenceText}`)).slice(0, 12),
    dependencies,
    importReferences,
    symbols:symbols.slice(0, 12),
    symbolCount:symbols.length,
    structureCoverage
  };
  const signal = { ...base, fileRole:inferFileRole(safe.relative, base) };
  cache.set(cacheKey, structuredClone(signal));
  if (cache.size > 160) cache.delete(cache.keys().next().value);
  return signal;
}

export function extractTaskSignals(cwd = process.cwd(), session = {}) {
  const prompt = String(session.prompt || '');
  const currentFile = preferredContextFile(session);
  const candidates = unique([currentFile, ...(session.touchedFiles || []).slice(-MAX_RELATED_FILES)]).filter(Boolean).slice(-MAX_RELATED_FILES);
  const admitted = new Map(unique([currentFile,...candidates]).map(file=>[file,readProjectSource(cwd,file)]));
  const sources = [...new Map([...admitted.values()].filter(Boolean).map(source=>[source.relative,source])).values()]
    .filter(source=>supportsStructurePath(source.relative));
  const extractions = loadStructureExtractions(cwd,sources);
  const current = inspectTaskFile(cwd, currentFile, prompt, admitted, extractions);
  const relatedFiles = candidates.map((file) => inspectTaskFile(cwd, file, prompt, admitted, extractions));
  const allTechnologies = unique([...(current.technologies || []), ...relatedFiles.flatMap((item) => item.technologies || [])]).slice(0, 16);
  return { ...current, technologies:allTechnologies, relatedFiles };
}
