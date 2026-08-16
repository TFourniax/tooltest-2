import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONCEPT_BY_ID } from './catalog.mjs';
import { publicSession } from './analyze.mjs';
import { extractTaskSignals } from './context.mjs';
import { buildFeatureModel } from './feature-model.mjs';
import { buildLearningExperience, buildLearningJourney } from './learning.mjs';
import { presentLearningCard } from './presentation.mjs';
import { taskConceptAvailability, snoozeUntil } from './snooze.mjs';
import { computeMetrics, loadState, mutateState } from './state.mjs';
import { buildReceipt } from './hook.mjs';
import { PACKAGE_ROOT, DEFAULT_PORT, projectPaths } from './paths.mjs';
import { grantApproval, loadPolicy, policyHash } from './policy.mjs';
import { buildAgentBom, readProvenanceEvents, verifyProvenanceChain } from './provenance.mjs';
import { createAttestation, verifyAttestation } from './attest.mjs';
import { createEvidenceBundle } from './evidence.mjs';
import { acceptResponsibility, responsibilityReport } from './ownership.mjs';
import { replayPolicy } from './replay.mjs';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
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

function safeRecentEvents(cwd, limit = 18) {
  return readProvenanceEvents(cwd, { limit }).map((record) => ({
    sequence: record.sequence,
    hash: record.hash,
    previousHash: record.previousHash,
    event: record.event
  }));
}

function latestContextEvent(session, recentEvents = []) {
  const reversed = [...recentEvents].reverse();
  if (session?.id) {
    const exact = reversed.find((record) => record.event?.sessionId === session.id);
    if (exact) return exact.event;
  }
  return reversed.find((record) => !record.event?.sessionId)?.event || null;
}

function enrichLearningSession(cwd, session, recentEvents = []) {
  if (!session) return null;
  const event = latestContextEvent(session, recentEvents);
  const enriched = {
    ...session,
    currentCapabilities: event?.capabilities || [],
    currentExecutable: event?.commandExecutable || null,
    currentResource: event?.resource || null
  };
  enriched.taskSignals = extractTaskSignals(cwd, enriched);
  return enriched;
}

function learningForState(cwd, state, recentEvents = safeRecentEvents(cwd, 40)) {
  const session = latestSession(state);
  const enriched = enrichLearningSession(cwd, session, recentEvents);
  const journey = buildLearningJourney(state, enriched || {});
  const availability = taskConceptAvailability(state, enriched || {});

  if (availability.paused) {
    return {
      session,
      enriched,
      learning: {
        ...journey,
        selectedConceptId: null,
        card: null,
        paused: true,
        snoozedConceptIds: availability.snoozed.map((item) => item.id),
        resumeAt: availability.resumeAt
      }
    };
  }

  const learningSession = enriched && Object.keys(enriched.concepts || {}).length
    ? { ...enriched, concepts: availability.available }
    : enriched;
  const selected = buildLearningExperience(state, learningSession || {}, 'testing');
  return {
    session,
    enriched,
    learning: {
      ...selected,
      concepts: journey.concepts,
      recap: journey.recap,
      card: presentLearningCard(selected.card, enriched || {}),
      paused: false,
      snoozedConceptIds: availability.snoozed.map((item) => item.id),
      resumeAt: availability.resumeAt
    }
  };
}

function safeFeatureModel(model, memory = null) {
  if (!model || !model.generatedFrom?.filesInspected) return null;
  const challenge = model.challenge ? {
    kind: model.challenge.kind,
    question: model.challenge.question,
    options: model.challenge.options
  } : null;
  return {
    schema: model.schema,
    fingerprint: model.fingerprint,
    confidence: model.confidence,
    generatedFrom: model.generatedFrom,
    nodes: model.nodes,
    edges: model.edges,
    story: model.story,
    surfaces: model.surfaces,
    tests: model.tests,
    riskNotes: model.riskNotes,
    challenge,
    explainBack: model.explainBack,
    disclaimer: model.disclaimer,
    fluency: {
      confidence: Math.round((memory?.confidence || 0) * 100),
      exposures: memory?.exposures || 0,
      checks: memory?.checks || 0,
      correct: memory?.correct || 0,
      wrong: memory?.wrong || 0,
      lastAnsweredAt: memory?.lastAnsweredAt || null
    }
  };
}

function recentFeatureMemory(state) {
  return Object.values(state.features || {})
    .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))
    .slice(0, 8)
    .map((entry) => ({
      fingerprint: entry.fingerprint,
      task: entry.task || 'Previous task',
      confidence: Math.round((entry.confidence || 0) * 100),
      exposures: entry.exposures || 0,
      checks: entry.checks || 0,
      lastSeenAt: entry.lastSeenAt || null,
      story: (entry.story || []).slice(0, 5),
      surfaces: entry.surfaces || { routes: [], tables: [], technologies: [] },
      tests: (entry.tests || []).slice(0, 6),
      riskNotes: (entry.riskNotes || []).slice(0, 4)
    }));
}

function currentFeatureModel(cwd, state, enriched) {
  const model = buildFeatureModel(cwd, enriched || {});
  return { raw: model, public: safeFeatureModel(model, state.features?.[model.fingerprint] || null) };
}

function presentState(cwd) {
  const state = loadState(cwd);
  const recentEvents = safeRecentEvents(cwd);
  const { session, enriched, learning } = learningForState(cwd, state, recentEvents);
  const featureModel = currentFeatureModel(cwd, state, enriched || session || {});
  let publicConcept = null;
  if (learning.card) {
    const { answer, patterns, ...safeCard } = learning.card;
    publicConcept = safeCard;
  }
  const policy = loadPolicy(cwd);
  const chain = verifyProvenanceChain(cwd);
  const bom = buildAgentBom(cwd, { write: false });
  const responsibility = responsibilityReport(cwd);
  const maxRecentRisk = Math.max(0, ...recentEvents.map((record) => Number(record.event?.policy?.risk || 0)));
  const latestDecision = [...recentEvents].reverse().find((record) => record.event?.policy)?.event?.policy || null;
  const attestationPath = projectPaths(cwd).attestation;
  let attestation = { exists: false, valid: null };
  if (fs.existsSync(attestationPath)) {
    const verified = verifyAttestation(attestationPath);
    attestation = { exists: true, valid: verified.ok, fingerprint: verified.statement?.predicate?.provenance?.signerFingerprint || null };
  }

  return {
    project: state.project,
    updatedAt: state.updatedAt,
    preferences: state.preferences,
    metrics: computeMetrics(state),
    session: session ? {
      ...publicSession(session),
      currentCapabilities: enriched?.currentCapabilities || [],
      currentExecutable: enriched?.currentExecutable || null,
      currentResource: enriched?.currentResource || null,
      taskSignals: enriched?.taskSignals || null
    } : null,
    card: publicConcept,
    learning: {
      phase: learning.phase,
      task: learning.task,
      file: learning.file,
      concepts: learning.concepts,
      recap: learning.recap,
      paused: learning.paused,
      snoozedConceptIds: learning.snoozedConceptIds,
      resumeAt: learning.resumeAt
    },
    featureModel: featureModel.public,
    featureMemory: recentFeatureMemory(state),
    ledger: Object.fromEntries(Object.entries(state.ledger)
      .filter(([, entry]) => entry.exposures > 0)
      .map(([id, entry]) => [id, {
        title: CONCEPT_BY_ID[id]?.title || id,
        risk: CONCEPT_BY_ID[id]?.risk || 1,
        exposures: entry.exposures,
        confidence: Math.round((entry.confidence || 0) * 100),
        snoozedUntil: entry.snoozedUntil || null
      }])),
    controlPlane: {
      policy: { profile: policy.profile, source: policy.source, sha256: policyHash(cwd) },
      provenance: { valid: chain.ok, events: chain.length, headHash: chain.headHash, errors: chain.errors },
      runtimeRisk: maxRecentRisk,
      latestDecision,
      recentEvents,
      agentBom: bom,
      responsibility,
      attestation
    }
  };
}

function currentAnswerContext(cwd, conceptId) {
  const state = loadState(cwd);
  const { learning } = learningForState(cwd, state);
  if (learning.card?.id === conceptId) {
    return { answer: learning.card.answer, review: learning.card.review };
  }
  const concept = CONCEPT_BY_ID[conceptId];
  return concept ? { answer: concept.answer, review: concept.review } : null;
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
    res.writeHead(403, SECURITY_HEADERS); res.end('Forbidden'); return;
  }
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': mime(file), 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, SECURITY_HEADERS); res.end('Not found');
  }
}

export function createServer({ cwd = process.cwd(), port = DEFAULT_PORT } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, product: 'idleproof', plane: 'local' });
      if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, presentState(cwd));
      if (url.pathname === '/api/receipt' && req.method === 'GET') return json(res, 200, buildReceipt(cwd));
      if (url.pathname === '/api/policy' && req.method === 'GET') return json(res, 200, loadPolicy(cwd));
      if (url.pathname === '/api/policy/replay' && req.method === 'GET') return json(res, 200, replayPolicy(cwd, { profile: url.searchParams.get('profile') || null, limit: 10000 }));
      if (url.pathname === '/api/provenance' && req.method === 'GET') return json(res, 200, { chain: verifyProvenanceChain(cwd), events: safeRecentEvents(cwd, 100) });
      if (url.pathname === '/api/bom' && req.method === 'GET') return json(res, 200, buildAgentBom(cwd));
      if (url.pathname === '/api/attestation' && req.method === 'GET') return json(res, 200, createAttestation(cwd));
      if (url.pathname === '/api/evidence' && req.method === 'GET') return json(res, 200, createEvidenceBundle(cwd));
      if (url.pathname === '/api/responsibility' && req.method === 'GET') return json(res, 200, responsibilityReport(cwd));
      if (url.pathname === '/api/feature-model' && req.method === 'GET') {
        const state = loadState(cwd);
        const recentEvents = safeRecentEvents(cwd, 40);
        const session = latestSession(state);
        const enriched = enrichLearningSession(cwd, session, recentEvents);
        return json(res, 200, currentFeatureModel(cwd, state, enriched || session || {}).public || { available: false });
      }

      if (url.pathname === '/api/answer' && req.method === 'POST') {
        const body = await readBody(req);
        const concept = CONCEPT_BY_ID[body.conceptId];
        if (!concept || !Number.isInteger(body.choice)) return json(res, 400, { error: 'Invalid answer' });
        const context = currentAnswerContext(cwd, concept.id) || { answer: concept.answer, review: concept.review };
        const correct = body.choice === context.answer;
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
          entry.snoozedUntil = null;
          return state;
        });
        buildReceipt(cwd);
        return json(res, 200, { correct, answer: context.answer, review: context.review, state: presentState(cwd) });
      }

      if (url.pathname === '/api/feature-answer' && req.method === 'POST') {
        const body = await readBody(req);
        if (!Number.isInteger(body.choice)) return json(res, 400, { error: 'Invalid feature answer' });
        const state = loadState(cwd);
        const recentEvents = safeRecentEvents(cwd, 40);
        const session = latestSession(state);
        const enriched = enrichLearningSession(cwd, session, recentEvents);
        const model = buildFeatureModel(cwd, enriched || session || {});
        if (!model.challenge || !model.generatedFrom.filesInspected) return json(res, 409, { error: 'No feature challenge available' });
        if (body.fingerprint && body.fingerprint !== model.fingerprint) return json(res, 409, { error: 'Feature model changed; refresh before answering' });
        const correct = body.choice === model.challenge.answer;
        mutateState(cwd, (next) => {
          next.features ||= {};
          const entry = next.features[model.fingerprint] || {
            fingerprint: model.fingerprint,
            exposures: 1,
            checks: 0,
            correct: 0,
            wrong: 0,
            confidence: 0,
            firstSeenAt: new Date().toISOString(),
            sessionIds: session?.id ? [session.id] : []
          };
          entry.checks += 1;
          if (correct) {
            entry.correct += 1;
            entry.confidence = Math.min(1, (entry.confidence || 0) + ((entry.confidence || 0) < 0.5 ? 0.32 : 0.16));
          } else {
            entry.wrong += 1;
            entry.confidence = Math.max(0, (entry.confidence || 0) - 0.08);
          }
          entry.lastAnsweredAt = new Date().toISOString();
          entry.lastSeenAt = entry.lastSeenAt || new Date().toISOString();
          entry.task = String(session?.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 180);
          entry.story = model.story;
          entry.surfaces = model.surfaces;
          entry.tests = model.tests;
          entry.riskNotes = model.riskNotes;
          next.features[model.fingerprint] = entry;
          return next;
        });
        return json(res, 200, {
          correct,
          answer: model.challenge.answer,
          explanation: model.challenge.explanation,
          state: presentState(cwd)
        });
      }

      if (url.pathname === '/api/snooze' && req.method === 'POST') {
        const body = await readBody(req);
        const concept = CONCEPT_BY_ID[body.conceptId];
        if (!concept) return json(res, 400, { error: 'Invalid concept' });
        const until = snoozeUntil(body.minutes ?? 10);
        mutateState(cwd, (state) => {
          const entry = state.ledger[concept.id];
          entry.snoozedUntil = until;
          entry.lastSkippedAt = new Date().toISOString();
          return state;
        });
        return json(res, 200, { ok: true, conceptId: concept.id, snoozedUntil: until, state: presentState(cwd) });
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

      if (url.pathname === '/api/approve' && req.method === 'POST') {
        const body = await readBody(req);
        const grant = grantApproval(cwd, body.fingerprint, {
          minutes: Number(body.minutes || 10),
          uses: Number(body.uses || 1),
          note: body.note || 'Approved from local control plane'
        });
        return json(res, 200, { ok: true, fingerprint: body.fingerprint, grant });
      }

      if (url.pathname === '/api/responsibility/accept' && req.method === 'POST') {
        const body = await readBody(req);
        const acceptance = acceptResponsibility(cwd, { principal: body.principal || '', note: body.note || 'Accepted from local control plane' });
        createAttestation(cwd);
        return json(res, 200, { ok: true, acceptance, responsibility: responsibilityReport(cwd) });
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
