import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 640 * 1024;
const MAX_FILES = 24;
const MAX_DEPTH = 2;

const SOURCE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py'];
const RESOLVE_EXTENSIONS = ['', ...SOURCE_EXTENSIONS, '.json'];
const INDEX_CANDIDATES = SOURCE_EXTENSIONS.map((ext) => `/index${ext}`);

const TECHNOLOGIES = [
  ['Stripe', /\bstripe\b/i], ['Supabase', /\bsupabase\b/i], ['PostgreSQL', /\bpostgres(?:ql)?\b|\bpsycopg\b/i],
  ['OAuth', /\boauth\b/i], ['OpenID Connect', /\boidc\b|open\s?id/i], ['JWT', /\bjwt\b/i],
  ['React', /\breact\b/i], ['Next.js', /\bnext(?:\.js|js)?\b/i], ['Prisma', /\bprisma\b/i],
  ['Drizzle', /\bdrizzle\b/i], ['Redis', /\bredis\b/i], ['Playwright', /\bplaywright\b/i],
  ['Vitest', /\bvitest\b/i], ['Jest', /\bjest\b/i], ['Pytest', /\bpytest\b/i],
  ['FastAPI', /\bfastapi\b/i], ['Django', /\bdjango\b/i], ['SQLAlchemy', /\bsqlalchemy\b/i],
  ['Celery', /\bcelery\b/i], ['S3', /\b(?:aws\s*)?s3\b|\bboto3\b/i],
  ['OpenAI', /\bopenai\b/i], ['Anthropic', /\banthropic\b|\bclaude\b/i]
];

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalize(relative = '') {
  return String(relative).replaceAll('\\', '/').replace(/^\.\//, '');
}

function insideProject(cwd, candidate) {
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, candidate);
  return absolute === root || absolute.startsWith(`${root}${path.sep}`);
}

function ignored(relative = '') {
  const value = normalize(relative);
  return !value || value.startsWith('.git/') || value.startsWith('.idleproof/') || value.startsWith('node_modules/') || value.startsWith('dist/') || value.startsWith('build/') || value.startsWith('.next/') || value.startsWith('coverage/') || value.startsWith('.venv/') || value.startsWith('venv/') || value.startsWith('__pycache__/');
}

function safeRead(cwd, relative) {
  const normalized = normalize(relative);
  if (ignored(normalized) || !insideProject(cwd, normalized)) return null;
  const absolute = path.resolve(cwd, normalized);
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0)) return null;
    return { relative: normalized, absolute, size: stat.size, text: bytes.toString('utf8') };
  } catch {
    return null;
  }
}

function firstExistingFile(cwd, candidates) {
  const root = path.resolve(cwd);
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    if (!(absolute === root || absolute.startsWith(`${root}${path.sep}`))) continue;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      return normalize(path.relative(root, absolute));
    } catch {}
  }
  return null;
}

function resolveLocalImport(cwd, importer, specifier) {
  if (!specifier || !specifier.startsWith('.')) return null;
  const base = path.resolve(cwd, path.dirname(importer), specifier);
  return firstExistingFile(cwd, [
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...INDEX_CANDIDATES.map((suffix) => `${base}${suffix}`)
  ]);
}

function pythonModuleCandidates(base) {
  return [`${base}.py`, path.join(base, '__init__.py')];
}

function resolvePythonImport(cwd, importer, moduleName) {
  if (!moduleName) return null;
  const root = path.resolve(cwd);
  const dots = moduleName.match(/^\.+/)?.[0].length || 0;
  const bare = moduleName.slice(dots);
  let baseDir = root;
  if (dots) {
    baseDir = path.resolve(root, path.dirname(importer));
    for (let level = 1; level < dots; level += 1) baseDir = path.dirname(baseDir);
  }
  const modulePath = bare ? bare.split('.').filter(Boolean).join(path.sep) : '';
  const base = modulePath ? path.resolve(baseDir, modulePath) : baseDir;
  return firstExistingFile(cwd, pythonModuleCandidates(base));
}

function pythonImportsFromText(cwd, relative, text) {
  if (!relative.endsWith('.py')) return [];
  const resolved = [];
  const fromPattern = /^\s*from\s+([.A-Za-z_][\w.]*)\s+import\s+([^#\n]+)/gm;
  for (const match of text.matchAll(fromPattern)) {
    const moduleName = match[1];
    const direct = resolvePythonImport(cwd, relative, moduleName);
    if (direct) resolved.push(direct);
    const names = String(match[2]).replace(/[()]/g, '').split(',').map((part) => part.trim().split(/\s+as\s+/i)[0]).filter((name) => /^[A-Za-z_]\w*$/.test(name));
    for (const name of names) {
      const child = resolvePythonImport(cwd, relative, `${moduleName}.${name}`);
      if (child) resolved.push(child);
    }
  }
  const importPattern = /^\s*import\s+([^#\n]+)/gm;
  for (const match of text.matchAll(importPattern)) {
    const modules = String(match[1]).split(',').map((part) => part.trim().split(/\s+as\s+/i)[0]).filter(Boolean);
    for (const moduleName of modules) {
      const resolvedModule = resolvePythonImport(cwd, relative, moduleName);
      if (resolvedModule) resolved.push(resolvedModule);
    }
  }
  return unique(resolved);
}

function importsFromText(cwd, relative, text) {
  const specs = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?['"`]([^'"`]+)['"`]/g,
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) specs.push(match[1]);
  const js = specs.map((specifier) => resolveLocalImport(cwd, relative, specifier));
  return unique([...js, ...pythonImportsFromText(cwd, relative, text)]).slice(0, 20);
}

function fileDerivedRoutes(relative) {
  const value = normalize(relative);
  const routes = [];
  let match = value.match(/(?:^|\/)app\/(api\/.*?)\/route\.(?:js|mjs|cjs|ts|tsx)$/i);
  if (match) routes.push(`/${match[1].replace(/\/(?:\([^/]+\)|@[^/]+)/g, '').replace(/\[\.\.\.([^\]]+)\]/g, ':$1*').replace(/\[([^\]]+)\]/g, ':$1')}`);
  match = value.match(/(?:^|\/)pages\/(api\/.*?)\.(?:js|mjs|cjs|ts|tsx)$/i);
  if (match) routes.push(`/${match[1].replace(/\/index$/i, '').replace(/\[\.\.\.([^\]]+)\]/g, ':$1*').replace(/\[([^\]]+)\]/g, ':$1')}`);
  return routes;
}

function routesFromText(text, relative = '') {
  const routes = [...fileDerivedRoutes(relative)];
  const literal = /["'`]((?:\/api\/|\/auth\/|\/webhooks?\/|\/admin(?:\/|$)|\/v\d+\/)[^"'`\s)]*)["'`]/g;
  for (const match of text.matchAll(literal)) routes.push(match[1]);
  const framework = /\b(?:app|router)\.(?:get|post|put|patch|delete|use)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  for (const match of text.matchAll(framework)) routes.push(match[1]);
  const django = /\b(?:path|re_path)\s*\(\s*[rRuU]?["']([^"']+)["']/g;
  for (const match of text.matchAll(django)) {
    const raw = String(match[1]).replace(/^\^/, '').replace(/\$$/, '');
    routes.push(raw.startsWith('/') ? raw : `/${raw}`);
  }
  return unique(routes).slice(0, 12);
}

function tablesFromText(text) {
  const tables = [];
  const patterns = [
    /\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`]?([A-Za-z_][\w.]*)/gi,
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+["`]?([A-Za-z_][\w.]*)/gi,
    /\.(?:from|table)\s*\(\s*["'`]([A-Za-z_][\w.-]*)["'`]\s*\)/gi,
    /\b__tablename__\s*=\s*["']([A-Za-z_][\w.-]*)["']/gi
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) tables.push(match[1]);
  return unique(tables).slice(0, 16);
}

function technologiesFromText(text) {
  return TECHNOLOGIES.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function roleForFile(relative, text, routes, tables, technologies) {
  const p = normalize(relative).toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec|specs)(\/|$)|\.(?:test|spec)\.[^.]+$|(?:^|\/)test_[^/]+\.py$|_test\.py$/.test(p)) return 'test';
  if (/\.github\/workflows|(?:^|\/)(?:config|configs|settings)(?:\/|$)|(?:^|\/)[^/]*(?:config|settings)\.[^.]+$/.test(p)) return 'config';
  if (/migration|migrations|schema|repository|repositories|models?|database|\/db\//.test(p) || tables.length) return 'data';
  if (/\/api\/|routes?|controllers?|handlers?|endpoint|views\.py$/.test(p) || routes.length) return 'api';
  if (/components?|pages?|views?|screens?|\.tsx$|\.jsx$/.test(p) && /react|jsx|tsx|useState|useEffect|return\s*\(/i.test(text)) return 'ui';
  if (/services?|clients?|integrations?|webhooks?|tasks\.py$/.test(p) || technologies.length) return 'service';
  return 'core';
}

function nodeId(type, value) {
  return `${type}:${value}`;
}

function compact(value = '', max = 90) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function taskTokens(prompt = '') {
  return new Set(String(prompt).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []);
}

function fileRelevance(file, prompt, seedSet) {
  let score = seedSet.has(file.path) ? 20 : 0;
  const tokens = taskTokens(prompt);
  for (const part of file.path.toLowerCase().split(/[^a-z0-9]+/)) if (tokens.has(part)) score += 2;
  if (file.role === 'api' || file.role === 'ui') score += 3;
  if (file.role === 'service' || file.role === 'data') score += 2;
  if (file.role === 'test') score += 1;
  return score;
}

function bestFile(files, roles, prompt, seedSet) {
  return files.filter((file) => roles.includes(file.role))
    .sort((a, b) => fileRelevance(b, prompt, seedSet) - fileRelevance(a, prompt, seedSet) || a.path.localeCompare(b.path))[0] || null;
}

function shortestImportPath(files, edges, from, targets) {
  if (!from) return [];
  const targetSet = new Set(targets);
  const adjacency = new Map();
  for (const edge of edges) {
    if (edge.kind !== 'imports') continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }
  const queue = [[nodeId('file', from.path)]];
  const seen = new Set(queue[0]);
  while (queue.length) {
    const current = queue.shift();
    const last = current.at(-1);
    if (targetSet.has(last) && current.length > 1) return current;
    for (const next of adjacency.get(last) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...current, next]);
    }
  }
  return [];
}

function featureStory(files, edges, prompt, seedSet, refs) {
  const entry = bestFile(files, ['ui', 'api', 'core'], prompt, seedSet) || files[0] || null;
  const downstreamFiles = files.filter((f) => ['service', 'data'].includes(f.role)).map((f) => nodeId('file', f.path));
  const importPath = shortestImportPath(files, edges, entry, downstreamFiles);
  const byId = new Map(files.map((f) => [nodeId('file', f.path), f]));
  const story = [];
  for (const id of importPath.length ? importPath : (entry ? [nodeId('file', entry.path)] : [])) {
    const file = byId.get(id);
    if (file) story.push({ type: 'file', label: file.path, role: file.role, evidence: 'local import graph' });
  }
  if (!story.some((step) => step.role === 'service')) {
    const service = bestFile(files, ['service'], prompt, seedSet);
    if (service) story.push({ type: 'file', label: service.path, role: 'service', evidence: 'related file' });
  }
  if (refs.technologies[0]) story.push({ type: 'technology', label: refs.technologies[0], role: 'external', evidence: 'referenced in related code' });
  if (!story.some((step) => step.role === 'data') && refs.tables[0]) story.push({ type: 'table', label: refs.tables[0], role: 'data', evidence: 'referenced in related code' });
  const test = bestFile(files, ['test'], prompt, seedSet);
  if (test) story.push({ type: 'file', label: test.path, role: 'test', evidence: 'related test file' });
  return story.slice(0, 7);
}

function buildChallenge(files, refs, story) {
  const serviceStep = story.find((step) => step.role === 'service');
  const external = refs.technologies[0];
  const table = refs.tables[0];
  const route = refs.routes[0];
  const test = story.find((step) => step.role === 'test');
  if (external && serviceStep) return { kind:'feature-boundary', question:`In this feature map, where does the ${external} boundary appear?`, options:[`${serviceStep.label} references ${external}`, `${external} is a local database table`, `${external} is only a CSS dependency`], answer:0, explanation:`IdleProof observed ${external} in the related code around ${serviceStep.label}. That makes it an external dependency boundary worth understanding.` };
  if (table) return { kind:'feature-persistence', question:'Which observed part of this feature is the clearest persistence boundary?', options:[table, route || 'The public route', test?.label || 'The test file'], answer:0, explanation:`The related code references ${table} as a data surface. That is the strongest observed persistence signal in this feature map.` };
  if (route) return { kind:'feature-entry', question:'Which observed route is part of this feature surface?', options:[route, '/idleproof/unrelated', '/assets/styles.css'], answer:0, explanation:`${route} was found in the bounded set of files connected to the current task.` };
  if (test) return { kind:'feature-test', question:'Which related file gives the clearest place to verify this feature behavior?', options:[test.label, 'package-lock.json', '.git/config'], answer:0, explanation:`${test.label} is classified as a related test file in the current feature map.` };
  return null;
}

function explainBackPrompt(story) {
  if (story.length < 2) return null;
  return `Explain this feature back in one sentence: ${story.slice(0, 5).map((step) => step.label).join(' → ')}. Focus on responsibility, not syntax.`;
}

export function buildFeatureModel(cwd = process.cwd(), session = {}) {
  const seeds = unique([session.currentResource, session.taskSignals?.file, ...(session.touchedFiles || []).slice(-8)].map(normalize)).filter((file) => !ignored(file));
  const seedSet = new Set(seeds);
  const queue = seeds.map((file) => ({ file, depth:0 }));
  const visited = new Set();
  const files = [];
  const edges = [];
  const routes = new Set();
  const tables = new Set();
  const technologies = new Set(session.taskSignals?.technologies || []);
  let totalBytes = 0;

  while (queue.length && files.length < MAX_FILES && totalBytes < MAX_TOTAL_BYTES) {
    const { file, depth } = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const read = safeRead(cwd, file);
    if (!read || totalBytes + read.size > MAX_TOTAL_BYTES) continue;
    totalBytes += read.size;
    const imports = importsFromText(cwd, read.relative, read.text);
    const fileRoutes = routesFromText(read.text, read.relative);
    const fileTables = tablesFromText(read.text);
    const fileTechnologies = technologiesFromText(read.text);
    const role = roleForFile(read.relative, read.text, fileRoutes, fileTables, fileTechnologies);
    files.push({ path:read.relative, role, imports, routes:fileRoutes, tables:fileTables, technologies:fileTechnologies });
    const from = nodeId('file', read.relative);
    for (const imported of imports) {
      edges.push({ from, to:nodeId('file', imported), kind:'imports' });
      if (depth < MAX_DEPTH && !visited.has(imported)) queue.push({ file:imported, depth:depth + 1 });
    }
    for (const route of fileRoutes) { routes.add(route); edges.push({ from, to:nodeId('route', route), kind:'references-route' }); }
    for (const table of fileTables) { tables.add(table); edges.push({ from, to:nodeId('table', table), kind:'references-data' }); }
    for (const technology of fileTechnologies) { technologies.add(technology); edges.push({ from, to:nodeId('technology', technology), kind:'references-technology' }); }
  }

  const refs = { routes:[...routes].sort(), tables:[...tables].sort(), technologies:[...technologies].sort() };
  const story = featureStory(files, edges, session.prompt || '', seedSet, refs);
  const challenge = buildChallenge(files, refs, story);
  const testFiles = files.filter((file) => file.role === 'test');
  const riskNotes = [];
  if (files.length && !testFiles.length) riskNotes.push('No related test file was observed in the bounded local feature map.');
  if (refs.technologies.length) riskNotes.push(`External boundary observed: ${refs.technologies.join(', ')}.`);
  if (refs.tables.length) riskNotes.push(`Persistence surface observed: ${refs.tables.join(', ')}.`);
  const fingerprintMaterial = JSON.stringify({ seeds:[...seedSet].sort(), files:files.map((file) => ({ path:file.path, role:file.role })).sort((a,b) => a.path.localeCompare(b.path)), refs, prompt:compact(session.prompt || '', 180) });
  const fingerprint = createHash('sha256').update(fingerprintMaterial).digest('hex').slice(0, 24);
  return {
    schema:'idleproof.feature-model.v1', fingerprint, confidence:'bounded-static',
    generatedFrom:{ seedFiles:seeds, filesInspected:files.length, bytesInspected:totalBytes, maxDepth:MAX_DEPTH },
    nodes:[...files.map((file) => ({ id:nodeId('file', file.path), type:'file', label:file.path, role:file.role })), ...refs.routes.map((route) => ({ id:nodeId('route',route), type:'route', label:route, role:'entry' })), ...refs.tables.map((table) => ({ id:nodeId('table',table), type:'table', label:table, role:'data' })), ...refs.technologies.map((technology) => ({ id:nodeId('technology',technology), type:'technology', label:technology, role:'external' }))],
    edges, story, surfaces:refs, tests:testFiles.map((file) => file.path), riskNotes, challenge, explainBack:explainBackPrompt(story),
    disclaimer:'This is a bounded static mental model built from observed project-local files and references. It is not a proven runtime call graph.'
  };
}
