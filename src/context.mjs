import fs from 'node:fs';
import path from 'node:path';
import { inferFileRole } from './semantics.mjs';

const MAX_CONTEXT_BYTES = 128 * 1024;
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

function safeFile(cwd, candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, candidate);
  if (!(absolute === root || absolute.startsWith(`${root}${path.sep}`))) return null;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_CONTEXT_BYTES) return null;
    return { absolute, stat, relative:path.relative(root, absolute).replaceAll('\\', '/') };
  } catch { return null; }
}

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

function dependenciesFromText(text) {
  const dependencies = [];
  const add = (value) => {
    const cleaned = String(value || '').trim();
    if (!cleaned || cleaned.startsWith('.') || cleaned.startsWith('/') || cleaned.startsWith('node:')) return;
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

function inspectTaskFile(cwd, file, prompt) {
  const safe = safeFile(cwd, file);
  if (!safe) {
    const fallback = { file:file || null, symbol:null, route:null, table:null, technologies:technologiesFrom(prompt), dependencies:[], symbols:[] };
    return { ...fallback, fileRole:inferFileRole(file || '', fallback) };
  }
  const cacheKey = `${safe.absolute}|${safe.stat.mtimeMs}|${safe.stat.size}|${prompt}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let text = '';
  try {
    const bytes = fs.readFileSync(safe.absolute);
    if (bytes.includes(0)) throw new Error('binary');
    text = bytes.toString('utf8');
  } catch {
    const fallback = { file:safe.relative, symbol:null, route:null, table:null, technologies:technologiesFrom(prompt), dependencies:[], symbols:[] };
    return { ...fallback, fileRole:inferFileRole(safe.relative, fallback) };
  }

  const evidenceText = stripCommentEvidence(text);
  const symbols = symbolsFromText(evidenceText);
  const routes = routesFromText(`${prompt}\n${evidenceText}`);
  const tables = tablesFromText(`${prompt}\n${evidenceText}`);
  const dependencies = dependenciesFromText(evidenceText);
  const base = {
    file:safe.relative,
    symbol:chooseSymbol(symbols, prompt),
    route:routes[0] || null,
    table:tables[0] || null,
    technologies:unique(technologiesFrom(`${prompt}\n${evidenceText}`)).slice(0, 12),
    dependencies,
    symbols:symbols.slice(0, 12),
    symbolCount:symbols.length
  };
  const signal = { ...base, fileRole:inferFileRole(safe.relative, base) };
  cache.set(cacheKey, signal);
  if (cache.size > 160) cache.delete(cache.keys().next().value);
  return signal;
}

export function extractTaskSignals(cwd = process.cwd(), session = {}) {
  const prompt = String(session.prompt || '');
  const currentFile = preferredContextFile(session);
  const current = inspectTaskFile(cwd, currentFile, prompt);
  const candidates = unique([currentFile, ...(session.touchedFiles || []).slice(-MAX_RELATED_FILES)]).filter(Boolean).slice(-MAX_RELATED_FILES);
  const relatedFiles = candidates.map((file) => inspectTaskFile(cwd, file, prompt));
  const allTechnologies = unique([...(current.technologies || []), ...relatedFiles.flatMap((item) => item.technologies || [])]).slice(0, 16);
  return { ...current, technologies:allTechnologies, relatedFiles };
}
