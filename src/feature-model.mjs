import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const LIMITS = { fileBytes:128 * 1024, totalBytes:640 * 1024, files:24, depth:2 };
const SOURCE_EXTENSIONS = ['.js','.mjs','.cjs','.ts','.tsx','.jsx','.py'];
const JS_RESOLVE_EXTENSIONS = ['', ...SOURCE_EXTENSIONS, '.json'];
const TECHNOLOGIES = [
  ['Stripe', /\bstripe\b/i], ['Supabase', /\bsupabase\b/i], ['PostgreSQL', /\bpostgres(?:ql)?\b|\bpsycopg\b/i],
  ['OAuth', /\boauth\b/i], ['OpenID Connect', /\boidc\b|open\s?id/i], ['JWT', /\bjwt\b/i],
  ['React', /\breact\b/i], ['Next.js', /\bnext(?:\.js|js)?\b/i], ['Prisma', /\bprisma\b/i], ['Drizzle', /\bdrizzle\b/i],
  ['Redis', /\bredis\b/i], ['Playwright', /\bplaywright\b/i], ['Vitest', /\bvitest\b/i], ['Jest', /\bjest\b/i], ['Pytest', /\bpytest\b/i],
  ['FastAPI', /\bfastapi\b/i], ['Django', /\bdjango\b/i], ['SQLAlchemy', /\bsqlalchemy\b/i], ['Celery', /\bcelery\b/i],
  ['S3', /\b(?:aws\s*)?s3\b|\bboto3\b/i], ['OpenAI', /\bopenai\b/i], ['Anthropic', /\banthropic\b|\bclaude\b/i]
];

const uniq = (values) => [...new Set((values || []).filter(Boolean))];
const norm = (value = '') => String(value).replaceAll('\\','/').replace(/^\.\//,'');
const compact = (value = '', max = 90) => { const text=String(value || '').replace(/\s+/g,' ').trim(); return text.length <= max ? text : `${text.slice(0,max-1).trimEnd()}…`; };
const nodeId = (type, value) => `${type}:${value}`;

function ignored(relative = '') {
  const v = norm(relative);
  return !v || ['.git/','.idleproof/','node_modules/','dist/','build/','.next/','coverage/','.venv/','venv/','__pycache__/'].some((prefix) => v.startsWith(prefix));
}

function inside(cwd, candidate) {
  const root=path.resolve(cwd); const absolute=path.resolve(root,candidate);
  return absolute === root || absolute.startsWith(`${root}${path.sep}`);
}

function safeRead(cwd, relative) {
  const file=norm(relative); if (ignored(file) || !inside(cwd,file)) return null;
  const absolute=path.resolve(cwd,file);
  try {
    const stat=fs.statSync(absolute); if (!stat.isFile() || stat.size > LIMITS.fileBytes) return null;
    const bytes=fs.readFileSync(absolute); if (bytes.includes(0)) return null;
    return { relative:file, absolute, size:stat.size, text:bytes.toString('utf8') };
  } catch { return null; }
}

function firstExisting(cwd, candidates) {
  const root=path.resolve(cwd);
  for (const candidate of candidates) {
    const absolute=path.resolve(candidate); if (!(absolute === root || absolute.startsWith(`${root}${path.sep}`))) continue;
    try { const stat=fs.statSync(absolute); if (stat.isFile() && stat.size <= LIMITS.fileBytes) return norm(path.relative(root,absolute)); } catch {}
  }
  return null;
}

function resolveJsImport(cwd, importer, specifier) {
  if (!specifier?.startsWith('.')) return null;
  const base=path.resolve(cwd,path.dirname(importer),specifier);
  return firstExisting(cwd,[...JS_RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`), ...SOURCE_EXTENSIONS.map((ext) => path.join(base,`index${ext}`))]);
}

function resolvePythonModule(cwd, importer, moduleName) {
  if (!moduleName) return null;
  const root=path.resolve(cwd); const dots=moduleName.match(/^\.+/)?.[0].length || 0; const bare=moduleName.slice(dots);
  let baseDir=root;
  if (dots) { baseDir=path.resolve(root,path.dirname(importer)); for (let i=1;i<dots;i+=1) baseDir=path.dirname(baseDir); }
  const modulePath=bare ? bare.split('.').filter(Boolean).join(path.sep) : '';
  const base=modulePath ? path.resolve(baseDir,modulePath) : baseDir;
  return firstExisting(cwd,[`${base}.py`,path.join(base,'__init__.py')]);
}

function pythonImports(cwd, relative, text) {
  if (!relative.endsWith('.py')) return [];
  const found=[];
  for (const match of text.matchAll(/^\s*from\s+([.A-Za-z_][\w.]*)\s+import\s+([^#\n]+)/gm)) {
    const moduleName=match[1]; found.push(resolvePythonModule(cwd,relative,moduleName));
    const names=String(match[2]).replace(/[()]/g,'').split(',').map((part) => part.trim().split(/\s+as\s+/i)[0]).filter((name) => /^[A-Za-z_]\w*$/.test(name));
    for (const name of names) found.push(resolvePythonModule(cwd,relative,`${moduleName}.${name}`));
  }
  for (const match of text.matchAll(/^\s*import\s+([^#\n]+)/gm)) {
    for (const moduleName of String(match[1]).split(',').map((part) => part.trim().split(/\s+as\s+/i)[0]).filter(Boolean)) found.push(resolvePythonModule(cwd,relative,moduleName));
  }
  return uniq(found);
}

function importsFromText(cwd, relative, text) {
  const specs=[];
  for (const pattern of [/\b(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?['"`]([^'"`]+)['"`]/g,/\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,/\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g]) {
    for (const match of text.matchAll(pattern)) specs.push(match[1]);
  }
  return uniq([...specs.map((specifier) => resolveJsImport(cwd,relative,specifier)), ...pythonImports(cwd,relative,text)]).slice(0,20);
}

function fileRoutes(relative) {
  const value=norm(relative); const routes=[];
  let match=value.match(/(?:^|\/)app\/(api\/.*?)\/route\.(?:js|mjs|cjs|ts|tsx)$/i);
  if (match) routes.push(`/${match[1].replace(/\/(?:\([^/]+\)|@[^/]+)/g,'').replace(/\[\.\.\.([^\]]+)\]/g,':$1*').replace(/\[([^\]]+)\]/g,':$1')}`);
  match=value.match(/(?:^|\/)pages\/(api\/.*?)\.(?:js|mjs|cjs|ts|tsx)$/i);
  if (match) routes.push(`/${match[1].replace(/\/index$/i,'').replace(/\[\.\.\.([^\]]+)\]/g,':$1*').replace(/\[([^\]]+)\]/g,':$1')}`);
  return routes;
}

function routesFromText(text, relative) {
  const routes=[...fileRoutes(relative)];
  for (const match of text.matchAll(/["'`]((?:\/api\/|\/auth\/|\/webhooks?\/|\/admin(?:\/|$)|\/v\d+\/)[^"'`\s)]*)["'`]/g)) routes.push(match[1]);
  for (const match of text.matchAll(/\b(?:app|router)\.(?:get|post|put|patch|delete|use)\s*\(\s*["'`]([^"'`]+)["'`]/g)) routes.push(match[1]);
  for (const match of text.matchAll(/\b(?:path|re_path)\s*\(\s*[rRuU]?["']([^"']+)["']/g)) {
    const raw=String(match[1]).replace(/^\^/,'').replace(/\$$/,''); routes.push(raw.startsWith('/') ? raw : `/${raw}`);
  }
  return uniq(routes).slice(0,12);
}

function sqlSignalText(text) {
  return String(text).split(/\r?\n/).filter((line) => !/^\s*from\s+[.A-Za-z_][\w.]*\s+import\b/i.test(line) && !/^\s*import\s+[A-Za-z_][\w.]*(?:\s+as\s+\w+)?\s*$/i.test(line)).join('\n');
}

function tablesFromText(text) {
  const source=sqlSignalText(text); const tables=[];
  for (const pattern of [
    /\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`]?([A-Za-z_][\w.]*)/gi,
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+["`]?([A-Za-z_][\w.]*)/gi,
    /\.(?:from|table)\s*\(\s*["'`]([A-Za-z_][\w.-]*)["'`]\s*\)/gi,
    /\b__tablename__\s*=\s*["']([A-Za-z_][\w.-]*)["']/gi
  ]) for (const match of source.matchAll(pattern)) tables.push(match[1]);
  return uniq(tables).slice(0,16);
}

const technologiesFromText = (text) => TECHNOLOGIES.filter(([,pattern]) => pattern.test(text)).map(([name]) => name);

function roleForFile(relative, text, routes, tables, technologies) {
  const p=norm(relative).toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec|specs)(\/|$)|\.(?:test|spec)\.[^.]+$|(?:^|\/)test_[^/]+\.py$|_test\.py$/.test(p)) return 'test';
  if (/\.github\/workflows|(?:^|\/)(?:config|configs|settings)(?:\/|$)|(?:^|\/)[^/]*(?:config|settings)\.[^.]+$/.test(p)) return 'config';
  if (/(^|\/)(?:api|routes?|controllers?|handlers?)(?:\/|$)|endpoint|views\.py$/.test(p) || routes.length) return 'api';
  if (/migration|migrations|schema|repository|repositories|models?|database|(?:^|\/)db(?:\/|$)/.test(p) || tables.length) return 'data';
  if (/components?|pages?|views?|screens?|\.tsx$|\.jsx$/.test(p) && /react|jsx|tsx|useState|useEffect|return\s*\(/i.test(text)) return 'ui';
  if (/services?|clients?|integrations?|webhooks?|tasks\.py$/.test(p) || technologies.length) return 'service';
  return 'core';
}

function taskTokens(prompt='') { return new Set(String(prompt).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []); }
function relevance(file,prompt,seeds) { let score=seeds.has(file.path)?20:0; const tokens=taskTokens(prompt); for (const part of file.path.toLowerCase().split(/[^a-z0-9]+/)) if (tokens.has(part)) score+=2; if (['api','ui'].includes(file.role)) score+=3; if (['service','data'].includes(file.role)) score+=2; if (file.role==='test') score+=1; return score; }
function bestFile(files,roles,prompt,seeds) { return files.filter((f) => roles.includes(f.role)).sort((a,b) => relevance(b,prompt,seeds)-relevance(a,prompt,seeds) || a.path.localeCompare(b.path))[0] || null; }

function shortestImportPath(edges, from, targets) {
  if (!from) return []; const targetSet=new Set(targets); const adjacency=new Map();
  for (const edge of edges) if (edge.kind==='imports') { if (!adjacency.has(edge.from)) adjacency.set(edge.from,[]); adjacency.get(edge.from).push(edge.to); }
  const queue=[[nodeId('file',from.path)]], seen=new Set(queue[0]);
  while (queue.length) { const current=queue.shift(), last=current.at(-1); if (targetSet.has(last) && current.length>1) return current; for (const next of adjacency.get(last)||[]) if (!seen.has(next)) { seen.add(next); queue.push([...current,next]); } }
  return [];
}

function featureStory(files,edges,prompt,seeds,refs) {
  const entry=bestFile(files,['ui','api','core'],prompt,seeds) || files[0] || null;
  const downstream=files.filter((f) => ['service','data'].includes(f.role)).map((f) => nodeId('file',f.path));
  const importPath=shortestImportPath(edges,entry,downstream); const byId=new Map(files.map((f) => [nodeId('file',f.path),f])); const story=[];
  for (const id of importPath.length ? importPath : (entry ? [nodeId('file',entry.path)] : [])) { const file=byId.get(id); if (file) story.push({ type:'file',label:file.path,role:file.role,evidence:'local import graph' }); }
  if (!story.some((s) => s.role==='service')) { const service=bestFile(files,['service'],prompt,seeds); if (service) story.push({ type:'file',label:service.path,role:'service',evidence:'related file' }); }
  if (refs.technologies[0]) story.push({ type:'technology',label:refs.technologies[0],role:'external',evidence:'referenced in related code' });
  if (!story.some((s) => s.role==='data') && refs.tables[0]) story.push({ type:'table',label:refs.tables[0],role:'data',evidence:'referenced in related code' });
  const test=bestFile(files,['test'],prompt,seeds); if (test) story.push({ type:'file',label:test.path,role:'test',evidence:'related test file' });
  return story.slice(0,7);
}

function buildChallenge(refs,story) {
  const service=story.find((s) => s.role==='service'), external=refs.technologies[0], table=refs.tables[0], route=refs.routes[0], test=story.find((s) => s.role==='test');
  if (external && service) return { kind:'feature-boundary',question:`In this feature map, where does the ${external} boundary appear?`,options:[`${service.label} references ${external}`,`${external} is a local database table`,`${external} is only a CSS dependency`],answer:0,explanation:`IdleProof observed ${external} in the related code around ${service.label}. That makes it an external dependency boundary worth understanding.` };
  if (table) return { kind:'feature-persistence',question:'Which observed part of this feature is the clearest persistence boundary?',options:[table,route||'The public route',test?.label||'The test file'],answer:0,explanation:`The related code references ${table} as a data surface. That is the strongest observed persistence signal in this feature map.` };
  if (route) return { kind:'feature-entry',question:'Which observed route is part of this feature surface?',options:[route,'/idleproof/unrelated','/assets/styles.css'],answer:0,explanation:`${route} was found in the bounded set of files connected to the current task.` };
  if (test) return { kind:'feature-test',question:'Which related file gives the clearest place to verify this feature behavior?',options:[test.label,'package-lock.json','.git/config'],answer:0,explanation:`${test.label} is classified as a related test file in the current feature map.` };
  return null;
}

export function buildFeatureModel(cwd=process.cwd(),session={}) {
  const seeds=uniq([session.currentResource,session.taskSignals?.file,...(session.touchedFiles||[]).slice(-8)].map(norm)).filter((f) => !ignored(f));
  const seedSet=new Set(seeds), queue=seeds.map((file) => ({file,depth:0})), visited=new Set(), files=[], edges=[], routes=new Set(), tables=new Set(), technologies=new Set(session.taskSignals?.technologies||[]); let totalBytes=0;
  while (queue.length && files.length<LIMITS.files && totalBytes<LIMITS.totalBytes) {
    const {file,depth}=queue.shift(); if (visited.has(file)) continue; visited.add(file); const read=safeRead(cwd,file); if (!read || totalBytes+read.size>LIMITS.totalBytes) continue; totalBytes+=read.size;
    const imports=importsFromText(cwd,read.relative,read.text), fileRoutes=routesFromText(read.text,read.relative), fileTables=tablesFromText(read.text), fileTech=technologiesFromText(read.text), role=roleForFile(read.relative,read.text,fileRoutes,fileTables,fileTech);
    files.push({path:read.relative,role,imports,routes:fileRoutes,tables:fileTables,technologies:fileTech}); const from=nodeId('file',read.relative);
    for (const imported of imports) { edges.push({from,to:nodeId('file',imported),kind:'imports'}); if (depth<LIMITS.depth && !visited.has(imported)) queue.push({file:imported,depth:depth+1}); }
    for (const route of fileRoutes) { routes.add(route); edges.push({from,to:nodeId('route',route),kind:'references-route'}); }
    for (const table of fileTables) { tables.add(table); edges.push({from,to:nodeId('table',table),kind:'references-data'}); }
    for (const tech of fileTech) { technologies.add(tech); edges.push({from,to:nodeId('technology',tech),kind:'references-technology'}); }
  }
  const refs={routes:[...routes].sort(),tables:[...tables].sort(),technologies:[...technologies].sort()}, story=featureStory(files,edges,session.prompt||'',seedSet,refs), tests=files.filter((f) => f.role==='test');
  const riskNotes=[]; if (files.length&&!tests.length) riskNotes.push('No related test file was observed in the bounded local feature map.'); if (refs.technologies.length) riskNotes.push(`External boundary observed: ${refs.technologies.join(', ')}.`); if (refs.tables.length) riskNotes.push(`Persistence surface observed: ${refs.tables.join(', ')}.`);
  const fingerprint=createHash('sha256').update(JSON.stringify({seeds:[...seedSet].sort(),files:files.map((f)=>({path:f.path,role:f.role})).sort((a,b)=>a.path.localeCompare(b.path)),refs,prompt:compact(session.prompt||'',180)})).digest('hex').slice(0,24);
  return { schema:'idleproof.feature-model.v1',fingerprint,confidence:'bounded-static',generatedFrom:{seedFiles:seeds,filesInspected:files.length,bytesInspected:totalBytes,maxDepth:LIMITS.depth},nodes:[...files.map((f)=>({id:nodeId('file',f.path),type:'file',label:f.path,role:f.role})),...refs.routes.map((v)=>({id:nodeId('route',v),type:'route',label:v,role:'entry'})),...refs.tables.map((v)=>({id:nodeId('table',v),type:'table',label:v,role:'data'})),...refs.technologies.map((v)=>({id:nodeId('technology',v),type:'technology',label:v,role:'external'}))],edges,story,surfaces:refs,tests:tests.map((f)=>f.path),riskNotes,challenge:buildChallenge(refs,story),explainBack:story.length<2?null:`Explain this feature back in one sentence: ${story.slice(0,5).map((s)=>s.label).join(' → ')}. Focus on responsibility, not syntax.`,disclaimer:'This is a bounded static mental model built from observed project-local files and references. It is not a proven runtime call graph.' };
}
