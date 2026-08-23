import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshState, saveState } from '../src/state.mjs';
import {
  buildCurrentPortalSnapshot,
  disconnectPortal,
  flushPortalQueue,
  portalStatus,
  queuePortalSnapshot,
  writePortalConfig
} from '../src/portal-client.mjs';
import { __portalTest } from '../src/portal-snapshot.mjs';
import { projectPaths } from '../src/paths.mjs';

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-portal-client-'));
  const state = freshState(cwd);
  state.sessions.s1 = {
    id:'s1',
    source:'claude',
    status:'complete',
    startedAt:'2026-08-21T18:00:00Z',
    lastEventAt:'2026-08-21T18:01:00Z',
    completedAt:'2026-08-21T18:01:00Z',
    prompt:'PRIVATE PROMPT CONTENT',
    promptChars:22,
    promptSha256:'a'.repeat(64),
    touchedFiles:['src/auth.ts'],
    changed:{ added:4, deleted:1 },
    concepts:{},
    events:[],
    proof:{ changeId:`dwchg_${'b'.repeat(24)}`, diffSha256:'c'.repeat(64) },
    taskSignals:{ file:'src/auth.ts' }
  };
  saveState(cwd, state);
  return cwd;
}

function cleanup(cwd) {
  try { fs.rmSync(cwd, { recursive:true, force:true }); } catch {}
}

test('Portal config stays project-local and refuses plaintext remote HTTP', () => {
  const cwd = fixture();
  try {
    assert.throws(
      () => writePortalConfig(cwd, { endpoint:'http://example.com/api/v1/snapshots', token:`ipd_${'x'.repeat(32)}` }),
      (error) => error?.code === 'IDLEPROOF_PORTAL_TLS_REQUIRED'
    );
    const status = writePortalConfig(cwd, { endpoint:'http://127.0.0.1:8787/api/v1/snapshots', token:`ipd_${'x'.repeat(32)}` });
    assert.equal(status.configured, true);
    assert.equal(status.tokenLast4, 'xxxx');
    assert.equal(status.endpoint, 'http://127.0.0.1:8787/api/v1/snapshots');
    const configPath = projectPaths(cwd).portalConfig;
    assert.equal(fs.existsSync(configPath), true);
    const raw = fs.readFileSync(configPath, 'utf8');
    assert.match(raw, /ipd_/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  } finally { cleanup(cwd); }
});

test('current Portal snapshot is exactly privacy-safe and contract-shaped', () => {
  const cwd = fixture();
  try {
    const snapshot = buildCurrentPortalSnapshot(cwd);
    assert.equal(snapshot.schema, 'idleproof.portal-snapshot.v1');
    assert.match(snapshot.snapshotId, /^ipsnap_[a-f0-9]{24}$/);
    assert.match(snapshot.project.localId, /^[a-f0-9]{24}$/);
    assert.equal(snapshot.task.promptDigest, `sha256:${'a'.repeat(64)}`);
    assert.equal(snapshot.change.changeId, `dwchg_${'b'.repeat(24)}`);
    assert.equal(snapshot.change.diffSha256, 'c'.repeat(64));
    assert.equal(snapshot.privacy.sourceCodeIncluded, false);
    assert.equal(snapshot.privacy.rawDiffIncluded, false);
    assert.equal(snapshot.privacy.rawAgentEventsIncluded, false);
    assert.equal(snapshot.privacy.rawPromptIncluded, false);
    assert.equal(snapshot.privacy.secretsRedacted, true);
    assert.equal(snapshot.files.includes('src/auth.ts'), true);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes('PRIVATE PROMPT CONTENT'), false);
    assert.equal(Buffer.byteLength(serialized, 'utf8') <= 64 * 1024, true);
  } finally { cleanup(cwd); }
});

test('queued snapshots flush idempotently without persisting the enrollment token in the queue', async () => {
  const cwd = fixture();
  try {
    const token = `ipd_${'q'.repeat(32)}`;
    writePortalConfig(cwd, { endpoint:'http://127.0.0.1:8787/api/v1/snapshots', token });
    const snapshot = buildCurrentPortalSnapshot(cwd);
    const first = queuePortalSnapshot(cwd, snapshot);
    const second = queuePortalSnapshot(cwd, snapshot);
    assert.equal(first.pending, 1);
    assert.equal(second.pending, 1);
    const queuePath = projectPaths(cwd).portalQueue;
    const queueRaw = fs.readFileSync(queuePath, 'utf8');
    assert.equal(queueRaw.includes(token), false);
    assert.equal(queueRaw.includes('PRIVATE PROMPT CONTENT'), false);

    const seen = [];
    const fakeFetch = async (url, options) => {
      seen.push({ url:String(url), options, body:JSON.parse(options.body) });
      return new Response(JSON.stringify({ schema:'idleproof.portal-ingest-ack.v1', status:'accepted', snapshotId:snapshot.snapshotId }), {
        status:202,
        headers:{ 'content-type':'application/json' }
      });
    };
    const result = await flushPortalQueue(cwd, { fetchImpl:fakeFetch, timeoutMs:500 });
    assert.equal(result.ok, true);
    assert.equal(result.delivered, 1);
    assert.equal(result.pending, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].options.headers.authorization, `Bearer ${token}`);
    assert.equal(seen[0].body.snapshotId, snapshot.snapshotId);
    assert.equal(fs.existsSync(queuePath), false);
    assert.equal(portalStatus(cwd).healthy, true);
  } finally { cleanup(cwd); }
});

test('network failure fails open for the coding agent and preserves the bounded retry queue', async () => {
  const cwd = fixture();
  try {
    writePortalConfig(cwd, { endpoint:'http://127.0.0.1:8787/api/v1/snapshots', token:`ipd_${'z'.repeat(32)}` });
    const snapshot = buildCurrentPortalSnapshot(cwd);
    queuePortalSnapshot(cwd, snapshot);
    const result = await flushPortalQueue(cwd, {
      fetchImpl:async () => { throw new Error('offline'); },
      timeoutMs:500
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'NETWORK_ERROR');
    assert.equal(result.pending, 1);
    assert.equal(JSON.parse(fs.readFileSync(projectPaths(cwd).portalQueue, 'utf8')).length, 1);
    const status = portalStatus(cwd);
    assert.equal(status.healthy, false);
    assert.equal(status.lastErrorCode, 'NETWORK_ERROR');
    assert.equal(status.skippedSnapshots, 0);
  } finally { cleanup(cwd); }
});

test('queue saturation never silently evicts history and marks Portal delivery degraded', () => {
  const cwd = fixture();
  try {
    writePortalConfig(cwd, { endpoint:'http://127.0.0.1:8787/api/v1/snapshots', token:`ipd_${'f'.repeat(32)}` });
    const base = buildCurrentPortalSnapshot(cwd);
    const fullQueue = Array.from({ length:200 }, (_, index) => {
      const item = structuredClone(base);
      item.task.summary = `Offline task ${index}`;
      item.snapshotId = __portalTest.stableSnapshotId(item);
      return item;
    });
    const paths = projectPaths(cwd);
    fs.writeFileSync(paths.portalQueue, `${JSON.stringify(fullQueue, null, 2)}\n`, { encoding:'utf8', mode:0o600 });

    const overflow = structuredClone(base);
    overflow.task.summary = 'The task that must not silently replace history';
    overflow.snapshotId = __portalTest.stableSnapshotId(overflow);
    const result = queuePortalSnapshot(cwd, overflow);
    assert.equal(result.queued, false);
    assert.equal(result.reason, 'queue-full');
    assert.equal(result.pending, 200);
    assert.equal(result.skippedSnapshots, 1);

    const persisted = JSON.parse(fs.readFileSync(paths.portalQueue, 'utf8'));
    assert.equal(persisted.length, 200);
    assert.deepEqual(persisted.map((item) => item.snapshotId), fullQueue.map((item) => item.snapshotId));
    assert.equal(persisted.some((item) => item.snapshotId === overflow.snapshotId), false);
    const status = portalStatus(cwd);
    assert.equal(status.healthy, false);
    assert.equal(status.degraded, true);
    assert.equal(status.skippedSnapshots, 1);
    assert.equal(status.lastErrorCode, 'QUEUE_FULL');
  } finally { cleanup(cwd); }
});

test('disconnect removes only the credential config and preserves queued evidence metadata', () => {
  const cwd = fixture();
  try {
    writePortalConfig(cwd, { endpoint:'http://127.0.0.1:8787/api/v1/snapshots', token:`ipd_${'d'.repeat(32)}` });
    queuePortalSnapshot(cwd, buildCurrentPortalSnapshot(cwd));
    const paths = projectPaths(cwd);
    assert.equal(fs.existsSync(paths.portalConfig), true);
    assert.equal(fs.existsSync(paths.portalQueue), true);
    disconnectPortal(cwd);
    const status = portalStatus(cwd);
    assert.equal(status.configured, false);
    assert.equal(fs.existsSync(paths.portalConfig), false);
    assert.equal(fs.existsSync(paths.portalQueue), true);
  } finally { cleanup(cwd); }
});
