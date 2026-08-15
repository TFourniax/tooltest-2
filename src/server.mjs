import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONCEPT_BY_ID } from './catalog.mjs';
import { rankCard, publicSession } from './analyze.mjs';
import { computeMetrics, loadState, mutateState } from './state.mjs';
import { buildReceipt } from './hook.mjs';
import { PACKAGE_ROOT, DEFAULT_PORT, projectPaths } from './paths.mjs';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100000) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function latestSession(state) {
  return Object.values(state.sessions || {}).sort((a, b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))[0] || null;
}

function presentState(cwd) {
  const state = loadState(cwd);
  const session = latestSession(state);
  const cardId = rankCard(state, session);
  const concept = CONCEPT_BY_ID[cardId];
  const ledger = state.ledger[cardId] || {};
  const { answer, patterns, ...publicConcept } = concept;
  return {
    project: state.project,
    updatedAt: state.updatedAt,
    preferences: state.preferences,
    metrics: computeMetrics(state),
    session: publicSession(session),
    card: {
      ...publicConcept,
      confidence: Math.round((ledger.confidence || 0) * 100),
      exposures: ledger.exposures || 0
    },
    ledger: Object.fromEntries(Object.entries(state.ledger)
      .filter(([, entry]) => entry.exposures > 0)
      .map(([id, entry]) => [id, {
        title: CONCEPT_BY_ID[id]?.title || id,
        risk: CONCEPT_BY_ID[id]?.risk || 1,
        exposures: entry.exposures,
        confidence: Math.round((entry.confidence || 0) * 100)
      }]))
  };
}

function mime(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const publicRoot = path.join(PACKAGE_ROOT, 'public');
  const file = path.resolve(publicRoot, relative);
  if (!(file === publicRoot || file.startsWith(`${publicRoot}${path.sep}`))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': mime(file), 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

export function createServer({ cwd = process.cwd(), port = DEFAULT_PORT } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/api/health') return json(res, 200, { ok: true });
      if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, presentState(cwd));
      if (url.pathname === '/api/receipt' && req.method === 'GET') return json(res, 200, buildReceipt(cwd));

      if (url.pathname === '/api/answer' && req.method === 'POST') {
        const body = await readBody(req);
        const concept = CONCEPT_BY_ID[body.conceptId];
        if (!concept || !Number.isInteger(body.choice)) return json(res, 400, { error: 'Invalid answer' });
        const correct = body.choice === concept.answer;
        mutateState(cwd, (state) => {
          const entry = state.ledger[concept.id];
          if (correct) {
            entry.correct += 1;
            entry.confidence = Math.min(1, entry.confidence + (entry.confidence < 0.5 ? 0.34 : 0.18));
          } else {
            entry.wrong += 1;
            entry.confidence = Math.max(0, entry.confidence - 0.08);
          }
          entry.lastAnsweredAt = new Date().toISOString();
          return state;
        });
        buildReceipt(cwd);
        return json(res, 200, { correct, answer: concept.answer, review: concept.review, state: presentState(cwd) });
      }

      if (url.pathname === '/api/preferences' && req.method === 'POST') {
        const body = await readBody(req);
        mutateState(cwd, (state) => {
          if (['learn', 'review'].includes(body.mode)) state.preferences.mode = body.mode;
          if (['adaptive', 'beginner', 'experienced'].includes(body.level)) state.preferences.level = body.level;
          return state;
        });
        return json(res, 200, presentState(cwd));
      }

      return serveStatic(req, res);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const info = { pid: process.pid, port: actualPort, cwd, startedAt: new Date().toISOString() };
      const paths = projectPaths(cwd);
      fs.mkdirSync(paths.dir, { recursive: true });
      fs.writeFileSync(paths.server, `${JSON.stringify(info, null, 2)}\n`);
      resolve({ server, url: `http://127.0.0.1:${actualPort}` });
    });
  });
}

export function openBrowser(url) {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => {});
    child.unref();
  } catch {}
}
