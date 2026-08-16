import fs from 'node:fs';
import path from 'node:path';

const MAX_CONTEXT_BYTES = 128 * 1024;
const cache = new Map();

const TECHNOLOGIES = [
  ['Stripe', /\bstripe\b/i], ['Supabase', /\bsupabase\b/i], ['PostgreSQL', /\bpostgres(?:ql)?\b/i],
  ['OAuth', /\boauth\b/i], ['OpenID Connect', /\boidc\b|open\s?id/i], ['JWT', /\bjwt\b/i],
  ['React', /\breact\b/i], ['Next.js', /\bnext(?:\.js|js)?\b/i], ['Vite', /\bvite\b/i],
  ['Prisma', /\bprisma\b/i], ['Drizzle', /\bdrizzle\b/i], ['Redis', /\bredis\b/i],
  ['GitHub Actions', /github\s+actions|\.github\/workflows/i], ['Docker', /\bdocker\b/i],
  ['Playwright', /\bplaywright\b/i], ['Vitest', /\bvitest\b/i], ['Jest', /\bjest\b/i],
  ['Pytest', /\bpytest\b/i], ['FastAPI', /\bfastapi\b/i], ['Django', /\bdjango\b/i]
];

function safeFile(cwd, candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, candidate);
  if (!(absolute === root || absolute.startsWith(`${root}${path.sep}`))) return null;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_CONTEXT_BYTES) return null;
    return { absolute, stat, relative: path.relative(root, absolute).replaceAll('\\', '/') };
  } catch { return null; }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function symbolsFromText(text) {
  const symbols = [];
  const patterns = [
    /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/g,
    /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/g,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
    /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm,
    /^\s*class\s+([A-Za-z_][\w]*)\s*(?:\(|:)/gm
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) symbols.push(match[1]);
  }
  return unique(symbols).slice(0, 40);
}

function routesFromText(text) {
  const routes = [];
  const pattern = /["'`]((?:\/api\/|\/auth\/|\/webhooks?\/|\/admin(?:\/|$)|\/v\d+\/)[^"'`\s)]*)["'`]/g;
  for (const match of text.matchAll(pattern)) routes.push(match[1]);
  return unique(routes).slice(0, 12);
}

function tablesFromText(text) {
  const tables = [];
  const patterns = [
    /\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`]?([A-Za-z_][\w.]*)/gi,
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+["`]?([A-Za-z_][\w.]*)/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) tables.push(match[1]);
  }
  return unique(tables).slice(0, 20);
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
    return { symbol, score: hits * 10 - index * 0.01 };
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

export function extractTaskSignals(cwd = process.cwd(), session = {}) {
  const file = preferredContextFile(session);
  const safe = safeFile(cwd, file);
  const prompt = String(session.prompt || '');
  if (!safe) {
    return {
      file: file || null,
      symbol: null,
      route: null,
      table: null,
      technologies: technologiesFrom(prompt)
    };
  }

  const cacheKey = `${safe.absolute}|${safe.stat.mtimeMs}|${safe.stat.size}|${prompt}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let text = '';
  try {
    const bytes = fs.readFileSync(safe.absolute);
    if (bytes.includes(0)) throw new Error('binary');
    text = bytes.toString('utf8');
  } catch {
    return { file: safe.relative, symbol: null, route: null, table: null, technologies: technologiesFrom(prompt) };
  }

  const symbols = symbolsFromText(text);
  const routes = routesFromText(`${prompt}\n${text}`);
  const tables = tablesFromText(`${prompt}\n${text}`);
  const signal = {
    file: safe.relative,
    symbol: chooseSymbol(symbols, prompt),
    route: routes[0] || null,
    table: tables[0] || null,
    technologies: unique(technologiesFrom(`${prompt}\n${text}`)).slice(0, 8),
    symbolCount: symbols.length
  };
  cache.set(cacheKey, signal);
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return signal;
}
