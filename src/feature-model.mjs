import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { loadStructureExtractions, supportsStructurePath, structureLanguageFor } from './structure-provider.mjs';
import { SOURCE_FILE_BYTES, isExcludedProjectPath as ignored, isInsideProject as inside,
         admitProjectSource as admittedSource, readProjectSource as safeRead } from './project-source.mjs';

const LIMITS = { fileBytes:SOURCE_FILE_BYTES, totalBytes:640 * 1024, files:24, depth:2, imports:20, symbols:100, extractionMs:500 };
const JS_SOURCE_EXTENSIONS = ['.js','.mjs','.cjs','.ts','.tsx','.jsx','.mts','.cts'];
const JS_RESOLVE_EXTENSIONS = ['', ...JS_SOURCE_EXTENSIONS, '.json'];
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

function uniqueExisting(cwd, candidates) {
  const matches=new Set();
  const root=path.resolve(cwd);
  for (const candidate of candidates) {
    const absolute=path.resolve(candidate); if (!inside(root,absolute)) continue;
    const admitted=admittedSource(cwd,path.relative(root,absolute));
    if (admitted) matches.add(admitted.relative);
  }
  return matches.size===1 ? [...matches][0] : null;
}

function resolveJsImport(cwd, importer, specifier) {
  if (!specifier?.startsWith('.')) return null;
  const base=path.resolve(cwd,path.dirname(importer),specifier);
  return uniqueExisting(cwd,path.extname(specifier) ? [base] : [...JS_RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`), ...JS_SOURCE_EXTENSIONS.map((ext) => path.join(base,`index${ext}`))]);
}

function resolvePythonModule(cwd, importer, moduleName) {
  if (!moduleName) return null;
  const root=path.resolve(cwd); const dots=moduleName.match(/^\.+/)?.[0].length || 0; const bare=moduleName.slice(dots);
  if (dots>norm(path.dirname(importer)).split('/').filter(part=>part&&part!=='.').length) return null;
  let baseDir=root;
  if (dots) { baseDir=path.resolve(root,path.dirname(importer)); for (let i=1;i<dots;i+=1) baseDir=path.dirname(baseDir); }
  const modulePath=bare ? bare.split('.').filter(Boolean).join(path.sep) : '';
  const base=modulePath ? path.resolve(baseDir,modulePath) : baseDir;
  return uniqueExisting(cwd,[`${base}.py`,path.join(base,'__init__.py')]);
}

function pythonImports(cwd, relative, text) {
  if (!relative.endsWith('.py')) return [];
  const found=[];
  for (const match of text.matchAll(/^\s*from\s+([.A-Za-z_][\w.]*)\s+import\s+([^#\n]+)/gm)) {
    const moduleName=match[1]; found.push(resolvePythonModule(cwd,relative,moduleName));
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
  for (const id of importPath.length ? importPath : (entry ? [nodeId('file',entry.path)] : [])) { const file=byId.get(id); if (file) story.push({ type:'file',label:file.path,role:file.role,evidence:'inferred local import graph',epistemic_status:'INFERRED' }); }
  if (!story.some((s) => s.role==='service')) { const service=bestFile(files,['service'],prompt,seeds); if (service) story.push({ type:'file',label:service.path,role:'service',evidence:'related file' }); }
  if (refs.technologies[0]) story.push({ type:'technology',label:refs.technologies[0],role:'reference',evidence:'inferred or task-declared technology reference',epistemic_status:'INFERRED' });
  if (!story.some((s) => s.role==='data') && refs.tables[0]) story.push({ type:'table',label:refs.tables[0],role:'data',evidence:'referenced in related code' });
  const test=bestFile(files,['test'],prompt,seeds); if (test) story.push({ type:'file',label:test.path,role:'test',evidence:'related test file' });
  return story.slice(0,7);
}

function buildChallenge(refs,story) {
  const service=story.find((s) => s.role==='service'), external=refs.technologies[0], table=refs.tables[0], route=refs.routes[0], test=story.find((s) => s.role==='test');
  if (external && service) return { kind:'feature-boundary',question:`In this feature map, which file is associated with the ${external} reference?`,options:[`${service.label} references ${external}`,`${external} is a local database table`,`${external} is only a CSS dependency`],answer:0,explanation:`The bounded map associates ${external} with ${service.label}. This is an inferred reference; package origin and runtime use are unresolved.` };
  if (table) return { kind:'feature-persistence',question:'Which data surface is referenced by this bounded feature map?',options:[table,route||'The public route',test?.label||'The test file'],answer:0,explanation:`The related code references ${table} as a data surface. This reference does not prove runtime persistence.` };
  if (route) return { kind:'feature-entry',question:'Which route candidate appears in this feature map?',options:[route,'/idleproof/unrelated','/assets/styles.css'],answer:0,explanation:`${route} was found in the bounded set of files connected to the current task.` };
  if (test) return { kind:'feature-test',question:'Which related file gives the clearest place to verify this feature behavior?',options:[test.label,'package-lock.json','.git/config'],answer:0,explanation:`${test.label} is classified as a related test file in the current feature map.` };
  return null;
}

function localTarget(cwd, relative, language, reference) {
  // Core already normalizes supported lexical bases. Leading dots in its
  // target explicitly mean unresolved; do not reinterpret the raw citation.
  if (language==='python') return reference.target.startsWith('.') ? null : resolvePythonModule(cwd,relative,reference.target);
  if (['javascript','typescript'].includes(language)) return resolveJsImport(cwd,relative,reference.target);
  // Other languages need language-specific origin resolution. Preserve the
  // syntax reference without guessing whether it names a local file or package.
  return null;
}

export function buildFeatureModel(cwd=process.cwd(),session={}, {structureOptions={}}={}) {
  const seeds=uniq([session.currentResource,session.taskSignals?.file,...(session.touchedFiles||[]).slice(-8)].map(norm)).filter((f) => !ignored(f));
  const seedSet=new Set(seeds), visited=new Set(), files=[], edges=[], references=[], symbols=[], coverage=[];
  const routes=new Set(), tables=new Set(), technologies=new Set(session.taskSignals?.technologies||[]);
  let queue=seeds, totalBytes=0;
  const deadline=performance.now()+LIMITS.extractionMs;
  for(let depth=0;depth<=LIMITS.depth && queue.length;depth+=1) {
    const batch=[];
    for(const file of queue) {
      if(visited.has(file)||files.length+batch.length>=LIMITS.files) continue;
      visited.add(file);const read=safeRead(cwd,file);
      if(!read||totalBytes+read.size>LIMITS.totalBytes) continue;
      totalBytes+=read.size;batch.push(read);
    }
    queue=[];
    const remaining=Math.floor(deadline-performance.now());
    const extracted=remaining>0
      ? loadStructureExtractions(cwd,batch.filter(read=>supportsStructurePath(read.relative)),{...structureOptions,details:true,timeoutMs:Math.min(remaining,LIMITS.extractionMs)})
      : {byPath:new Map(),reason:'extraction-budget-exhausted'};
    for(const read of batch) {
      const canonical=extracted.byPath.get(read.relative), language=structureLanguageFor(read.relative);
      const dataSource=['sql','json','toml','yaml'].includes(language);
      const fallback=!canonical&&!dataSource&&['core-extraction-unavailable','no-supported-sources'].includes(extracted.reason);
      const syntaxUsable=Boolean(canonical?.parsed);
      const source={path:read.relative,source_sha256:read.sha256};
      const itemCoverage={...source,language,provider:canonical?.provider||null,canonical:Boolean(canonical),parsed:syntaxUsable,
        reason:canonical ? (syntaxUsable?null:'source-unparsed') : extracted.reason,
        importsTruncated:Math.max(0,(canonical?.imports.length||0)-LIMITS.imports),
        symbolsTruncated:Math.max(0,(canonical?.symbols.length||0)-LIMITS.symbols),legacyHeuristics:fallback};
      coverage.push(itemCoverage);
      const localImports=[];
      for(const imported of (canonical?.imports||[]).slice(0,LIMITS.imports)) {
        const target=localTarget(cwd,read.relative,language,imported);
        const citation={...source,line:imported.line,end_line:imported.end_line};
        references.push({...imported,source:citation,resolution:target?'local-candidate':'unresolved',localPath:target});
        if(target && target!==read.relative) {
          localImports.push(target);
          edges.push({from:nodeId('file',read.relative),to:nodeId('file',target),kind:'imports',epistemic_status:'INFERRED',source:citation,extraction:'canonical'});
        }
      }
      if(fallback) for(const target of importsFromText(cwd,read.relative,read.text)) {
        localImports.push(target);
        edges.push({from:nodeId('file',read.relative),to:nodeId('file',target),kind:'imports',epistemic_status:'INFERRED',source,extraction:'legacy-heuristic'});
      }
      const admittedSymbols=(canonical?.symbols||[]).slice(0,LIMITS.symbols);
      for(const symbol of admittedSymbols) symbols.push({...symbol,source:{...source,line:symbol.line,end_line:symbol.end_line}});
      const heuristicCode=!dataSource&&(syntaxUsable||fallback);
      const fileRoutes=heuristicCode?routesFromText(read.text,read.relative):[];
      const tableSymbols=language==='sql'?admittedSymbols.filter(symbol=>symbol.kind==='table'):[];
      const fileTables=language==='sql'?tableSymbols.map(symbol=>symbol.qualified_name.slice(read.relative.length+2))
        :heuristicCode?tablesFromText(read.text):[];
      const fileTech=heuristicCode?technologiesFromText(read.text):[];
      const role=dataSource ? (language==='sql'?'data':'config') : roleForFile(read.relative,heuristicCode?read.text:'',fileRoutes,fileTables,fileTech);
      files.push({path:read.relative,role,imports:uniq(localImports),routes:fileRoutes,tables:fileTables,technologies:fileTech,source});
      if(depth<LIMITS.depth) queue.push(...localImports.filter(target=>!visited.has(target)));
      const from=nodeId('file',read.relative);
      for(const route of fileRoutes) {routes.add(route);edges.push({from,to:nodeId('route',route),kind:'references-route',epistemic_status:'INFERRED',source,extraction:'legacy-heuristic'});}
      for(let index=0;index<fileTables.length;index+=1) {
        const table=fileTables[index],symbol=tableSymbols[index];tables.add(table);
        edges.push({from,to:nodeId('table',table),kind:'references-data',epistemic_status:symbol?'OBSERVED':'INFERRED',
          source:symbol?{...source,line:symbol.line,end_line:symbol.end_line}:source,extraction:symbol?'canonical':'legacy-heuristic'});
      }
      for(const tech of fileTech) {technologies.add(tech);edges.push({from,to:nodeId('technology',tech),kind:'references-technology',epistemic_status:'INFERRED',source,extraction:'legacy-heuristic'});}
    }
  }
  const refs={routes:[...routes].sort(),tables:[...tables].sort(),technologies:[...technologies].sort()}, story=featureStory(files,edges,session.prompt||'',seedSet,refs), tests=files.filter((f) => f.role==='test');
  const riskNotes=[];
  if(files.length&&!tests.length) riskNotes.push('No related test file was observed in the bounded local feature map.');
  if(refs.technologies.length) riskNotes.push(`Inferred or task-declared technology references: ${refs.technologies.join(', ')}. Origins and runtime use are unresolved.`);
  if(refs.tables.length) riskNotes.push(`Data surface references: ${refs.tables.join(', ')}. Runtime persistence is unproven.`);
  if(coverage.some(item=>!item.canonical||!item.parsed)) riskNotes.push('Structure coverage is incomplete; inspect per-file coverage before relying on this map.');
  const fingerprint=createHash('sha256').update(JSON.stringify({seeds:[...seedSet].sort(),files:files.map((f)=>({path:f.path,role:f.role,source:f.source})).sort((a,b)=>a.path.localeCompare(b.path)),coverage,refs,references,symbols,prompt:compact(session.prompt||'',180)})).digest('hex').slice(0,24);
  return {schema:'idleproof.feature-model.v1',fingerprint,confidence:'bounded-static',
    generatedFrom:{seedFiles:seeds,filesInspected:files.length,bytesInspected:totalBytes,maxDepth:LIMITS.depth,coverage},
    nodes:[...files.map((f)=>({id:nodeId('file',f.path),type:'file',label:f.path,role:f.role,source:f.source})),
      ...refs.routes.map((v)=>({id:nodeId('route',v),type:'route',label:v,role:'entry'})),
      ...refs.tables.map((v)=>({id:nodeId('table',v),type:'table',label:v,role:'data'})),
      ...refs.technologies.map((v)=>({id:nodeId('technology',v),type:'technology',label:v,role:'reference'}))],
    edges,references,symbols,story,surfaces:refs,tests:tests.map((f)=>f.path),riskNotes,challenge:buildChallenge(refs,story),
    explainBack:story.length<2?null:`Explain this feature back in one sentence: ${story.slice(0,5).map((s)=>s.label).join(' → ')}. Focus on responsibility, not syntax.`,
    disclaimer:'This is a bounded static mental model of cited source syntax, inferred local links and explicitly labelled legacy heuristics. It is not a proven runtime call graph.'};
}
