import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processHookLifecycle } from '../src/hook.mjs';
import { buildCurrentPortalSnapshot, portalStatus, writePortalConfig } from '../src/portal-client.mjs';
import { autoDebtStatus, disableAutoDebt, enableAutoDebt, enqueueAutoDebt, runAutoDebtWorker, scheduleAutoDebt, settleWithManualAssurance, __autoDebtTest } from '../src/auto-debt.mjs';
import { syncPortalAssurance, readChangeEnvelope } from '../src/portal-assurance.mjs';
import { queueMatchingDiffWitnessAssurance } from '../src/ide-assurance.mjs';
import { projectPaths } from '../src/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'idleproof.mjs');
const FAKE_DW = path.join(HERE, 'support', 'fake-dw.mjs');
const TOKEN = `ipd_${'a'.repeat(32)}`;
const cleanup = (dir) => { try { fs.rmSync(dir, { recursive:true, force:true }); } catch {} };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding:'utf8' }).trim();
const noSpawn = { start:() => {} };

// A `dw` launcher for the fake Core CLI, callable by path on every platform.
function fakeDw(dir) {
  fs.mkdirSync(dir, { recursive:true });
  if (process.platform === 'win32') {
    const file = path.join(dir, 'dw.cmd');
    fs.writeFileSync(file, `@"${process.execPath}" "${FAKE_DW}" %*\r\n`);
    return file;
  }
  const file = path.join(dir, 'dw');
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DW}" "$@"\n`, { mode:0o755 });
  return file;
}

function project({ endpoint = 'http://127.0.0.1:9/api/v1/snapshots', prefix = 'idleproof-auto-debt-' } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(cwd, 'init', '-q', '-b', 'main'); git(cwd, 'config', 'user.name', 'Auto Debt'); git(cwd, 'config', 'user.email', 'auto-debt@example.invalid');
  fs.writeFileSync(path.join(cwd, 'app.py'), 'def total(items):\n    return sum(items)\n');
  git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'initial');
  writePortalConfig(cwd, { endpoint, token:TOKEN });
  const dw = fakeDw(path.join(cwd, '..', `${path.basename(cwd)}-bin`));
  return { cwd, dw, done:() => { cleanup(cwd); cleanup(path.dirname(dw)); } };
}

// In-process hooks only queue: these tests run the worker themselves (the last test uses the real
// detached worker through the CLI).
process.env.IDLEPROOF_AUTO_DEBT_WORKER = 'off';

// One change completed through the generic IdleProof path (the events `idleproof run` emits).
function completeChange(cwd, file, content) {
  const session_id = `generic-test-${Math.random().toString(16).slice(2)}`;
  processHookLifecycle({ cwd, session_id, source:'generic-wrapper', hook_event_name:'UserPromptSubmit', prompt:`write ${file}` });
  fs.writeFileSync(path.join(cwd, file), content);
  return processHookLifecycle({ cwd, session_id, source:'generic-wrapper', hook_event_name:'generic-stop', tool_name:'Process', tool_input:{ command:`write ${file}` } });
}

const ack = (body) => ({ schema:'idleproof.portal-ingest-ack.v1', status:'accepted', snapshotId:JSON.parse(body).snapshotId });
function portalStub(received, { down = false } = {}) {
  return async (url, options) => {
    if (down) throw new TypeError('fetch failed');
    received.push(JSON.parse(options.body));
    return new Response(JSON.stringify(ack(options.body)), { status:202, headers:{ 'content-type':'application/json' } });
  };
}
const queued = (cwd) => { try { return JSON.parse(fs.readFileSync(projectPaths(cwd).portalQueue, 'utf8')); } catch { return []; } };
const withAssurance = (items) => items.filter((item) => item.assurance?.softwareDebt);

test('automatic debt is off until enabled, and enabling requires a Portal enrollment and a Core CLI', () => {
  const p = project();
  try {
    const hook = completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    assert.equal(hook.autoDebt.reason, 'disabled');
    assert.equal(fs.existsSync(projectPaths(p.cwd).autoDebtJobs), false);
    fs.rmSync(projectPaths(p.cwd).portalConfig);
    assert.throws(() => enableAutoDebt(p.cwd, { dw:p.dw }), (error) => error.code === 'IDLEPROOF_AUTO_DEBT_PORTAL_REQUIRED');
    writePortalConfig(p.cwd, { endpoint:'http://127.0.0.1:9/api/v1/snapshots', token:TOKEN });
    assert.throws(() => enableAutoDebt(p.cwd, { dw:path.join(p.cwd, 'no-such-dw') }), (error) => error.code === 'IDLEPROOF_AUTO_DEBT_CORE_UNAVAILABLE');
    const status = enableAutoDebt(p.cwd, { dw:p.dw });
    assert.equal(status.enabled, true);
    assert.equal(status.dw, p.dw);
    assert.equal(disableAutoDebt(p.cwd).enabled, false);
  } finally { p.done(); }
});

test('the completing hook records the exact frozen references and measures nothing itself', () => {
  const p = project();
  const log = path.join(os.tmpdir(), `fake-dw-${process.pid}-${Date.now()}.log`);
  process.env.FAKE_DW_LOG = log;
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    fs.rmSync(log, { force:true });
    let started = 0;
    const hook = completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    assert.equal(hook.autoDebt.queued, true);
    const session = Object.values(hook.state.sessions)[0];
    const job = __autoDebtTest.readJobs(p.cwd).jobs[0];
    assert.equal(job.changeId, session.proof.changeId);
    assert.equal(job.base.tree, session.changeIdentity.base.tree);
    assert.equal(job.candidate.tree, session.changeIdentity.candidate.tree);
    assert.equal(job.state, 'pending');
    assert.equal(fs.existsSync(log), false, 'the hook never runs the Core CLI');
    // The candidate is an uncommitted worktree: its reference is the frozen tree, not HEAD.
    assert.equal(job.candidate.commit, null);
    // A repeated completion of the same change adds no second job.
    const again = scheduleAutoDebt(p.cwd, session.changeIdentity, { start:() => { started += 1; } });
    assert.equal(again.reason, 'already-queued');
    assert.equal(__autoDebtTest.readJobs(p.cwd).jobs.length, 1);
    assert.equal(started, 1, 'a worker is still started for the waiting job');
  } finally { delete process.env.FAKE_DW_LOG; fs.rmSync(log, { force:true }); p.done(); }
});

test('two successive changes are measured by Core and sent to Portal without any debt command', async () => {
  const p = project();
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    git(p.cwd, 'add', '-A'); git(p.cwd, 'commit', '-qm', 'change 1');
    process.env.FAKE_DW_POINTS = '8';
    const first = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    completeChange(p.cwd, 'report.py', 'def report():\n    # FIXME: format\n    return 1\n');
    process.env.FAKE_DW_POINTS = '5';
    const second = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    delete process.env.FAKE_DW_POINTS;
    assert.deepEqual(first.results.map((item) => item.state), ['done']);
    assert.deepEqual(second.results.map((item) => item.state), ['done']);
    const sent = withAssurance(received);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((item) => item.assurance.softwareDebt.points), [8, 5]);
    assert.deepEqual(sent.map((item) => item.change.changeId), [first.results[0].changeId, second.results[0].changeId]);
    assert.notEqual(sent[0].change.changeId, sent[1].change.changeId);
    const status = autoDebtStatus(p.cwd);
    assert.deepEqual(status.changes.map((item) => [item.state, item.delivery]), [['measured', 'delivered'], ['measured', 'delivered']]);
    assert.equal(status.core, 'available');
  } finally { delete process.env.FAKE_DW_POINTS; p.done(); }
});

test('Portal unavailable: the measurement is kept queued, never reported delivered, and sent once Portal is back', async () => {
  const p = project();
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    const offline = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received, { down:true }) });
    assert.equal(offline.results[0].state, 'done');
    assert.equal(offline.delivery.ok, false);
    assert.equal(withAssurance(queued(p.cwd)).length, 1);
    assert.equal(autoDebtStatus(p.cwd).changes[0].delivery, 'awaiting-delivery');
    // Nothing to measure any more; the ordinary delivery path sends the kept receipt.
    const { flushPortalQueue } = await import('../src/portal-client.mjs');
    const flushed = await flushPortalQueue(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(flushed.ok, true);
    assert.equal(withAssurance(received).length, 1);
    assert.equal(autoDebtStatus(p.cwd).changes[0].delivery, 'delivered');
  } finally { p.done(); }
});

test('Core unavailable: no value is sent, the job waits with its reason and is measured once Core is back', async () => {
  const p = project();
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    const moved = `${p.dw}.moved`;
    fs.renameSync(p.dw, moved);
    const down = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(down.results[0].state, 'core-unavailable');
    assert.equal(received.length, 0);
    assert.equal(withAssurance(queued(p.cwd)).length, 0, 'no debt value, not even a zero, was queued');
    const waiting = autoDebtStatus(p.cwd);
    assert.equal(waiting.changes[0].state, 'retrying');
    assert.equal(waiting.changes[0].lastError.code, 'CORE_UNAVAILABLE');
    assert.equal(waiting.changes[0].attempts, 0, 'an unavailable Core is not counted as a failed measurement');
    fs.renameSync(moved, p.dw);
    const back = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(back.results[0].state, 'done');
    assert.equal(withAssurance(received).length, 1);
  } finally { p.done(); }
});

test('a failing measurement is retried with backoff, then reported failed; never sent', async () => {
  const p = project();
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    process.env.FAKE_DW_FAIL = 'debt';
    for (let attempt = 1; attempt <= __autoDebtTest.MAX_ATTEMPTS; attempt += 1) {
      const result = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
      assert.equal(result.results[0].code, 'MEASUREMENT_FAILED');
      const jobs = __autoDebtTest.readJobs(p.cwd);
      // The backoff is honoured; the test moves the retry time back instead of waiting.
      if (jobs.jobs[0].retryAfter) { jobs.jobs[0].retryAfter = new Date(0).toISOString(); fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, JSON.stringify(jobs)); }
    }
    delete process.env.FAKE_DW_FAIL;
    assert.equal(autoDebtStatus(p.cwd).changes[0].state, 'failed');
    assert.equal((await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) })).results.length, 0, 'a failed job is not retried silently');
    assert.equal(received.length, 0);
    const retried = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received), retryFailed:true });
    assert.equal(retried.results[0].state, 'done');
    assert.equal(withAssurance(received).length, 1);
  } finally { delete process.env.FAKE_DW_FAIL; p.done(); }
});

test('an interrupted worker leaves its job for the next one, and repeated or concurrent triggers send one receipt', async () => {
  const p = project();
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    const hook = completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    // A worker died while measuring: its job is still marked measuring and no lock holder remains.
    const jobs = __autoDebtTest.readJobs(p.cwd);
    jobs.jobs[0].state = 'measuring';
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, JSON.stringify(jobs));
    // Two worker processes started together (a repeated trigger); Core is slow enough for them to overlap.
    const log = path.join(path.dirname(p.dw), 'calls.log');
    const worker = () => new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'portal', 'auto-debt', 'run', '--json'], { cwd:p.cwd, env:{ ...process.env, FAKE_DW_SLEEP_MS:'1500', FAKE_DW_LOG:log } });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('close', () => resolve(JSON.parse(out)));
    });
    const [a, b] = await Promise.all([worker(), worker()]);
    const outcomes = [...a.results, ...b.results].map((item) => item.state).filter((state) => state !== 'busy');
    assert.deepEqual(outcomes, ['done']);
    assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('debt ')).length, 1, 'Core measured the change once');
    // The same completion triggered again, and the worker run again: nothing new.
    const session = Object.values(hook.state.sessions)[0];
    assert.equal(enqueueAutoDebt(p.cwd, session.changeIdentity).reason, 'already-measured');
    assert.equal((await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) })).results.length, 0);
    // One receipt, still queued for delivery (the workers had no reachable Portal).
    assert.equal(withAssurance(queued(p.cwd)).length, 1);
    assert.equal(received.length, 0);
  } finally { p.done(); }
});

test('the manual mode stays available and deduplicates with the automatic measurement', async () => {
  const p = project();
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    const auto = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    const envelope = readChangeEnvelope(path.join(projectPaths(p.cwd).autoDebtWork, auto.results[0].changeId, 'envelope.json'), p.cwd);
    const manual = await syncPortalAssurance(p.cwd, envelope, { fetchImpl:portalStub(received) });
    assert.equal(manual.queueReason, 'already-sent');
    assert.equal(manual.snapshotId, auto.results[0].snapshotId);
    assert.equal(new Set(withAssurance(received).map((item) => item.snapshotId)).size, 1);
  } finally { p.done(); }
});

test('a measurement whose earlier receipt is no longer kept is reported failed, never delivered', async () => {
  const p = project();
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    const job = structuredClone(__autoDebtTest.readJobs(p.cwd).jobs[0]);
    const first = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(first.results[0].state, 'done');
    // Much later: the receipt body is no longer kept locally, and the same change is measured again
    // (as after a lost queue file). The client can neither resend nor confirm that receipt.
    const sentFile = projectPaths(p.cwd).portalAssuranceSent;
    const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
    sent.entries = sent.entries.map(({ snapshot, ...entry }) => entry);
    fs.writeFileSync(sentFile, JSON.stringify(sent));
    const jobs = __autoDebtTest.readJobs(p.cwd);
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, JSON.stringify({ ...jobs, jobs:[{ ...job, state:'pending', attempts:0 }], done:[], measured:[] }));
    const again = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(again.results[0].state, 'failed');
    assert.equal(again.results[0].code, 'IDLEPROOF_ASSURANCE_NOT_RETAINED');
    const change = autoDebtStatus(p.cwd, { probe:false }).changes.find((item) => item.changeId === job.changeId);
    assert.equal(change.state, 'failed');
    assert.equal(change.lastError.code, 'IDLEPROOF_ASSURANCE_NOT_RETAINED');
    assert.equal(change.delivery, undefined);
    assert.equal(withAssurance(received).length, 1);
    // Core did measure it: once its failed job leaves the list, completing it again measures nothing.
    const after = __autoDebtTest.readJobs(p.cwd);
    assert.equal(after.measured.includes(job.changeId), true);
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, JSON.stringify({ ...after, jobs:[] }));
    const identity = { available:true, changeId:job.changeId, repository:{ fingerprint:'dwrepo_x' }, base:{ tree:job.base.tree, sha:null }, candidate:{ tree:job.candidate.tree, sha:null } };
    assert.equal(enqueueAutoDebt(p.cwd, identity).reason, 'already-measured');
  } finally { p.done(); }
});

test('a measured change is never measured again, even beyond the bounded measurement details', async () => {
  const p = project();
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    const hex = (n) => n.toString(16).padStart(24, '0');
    const old = Array.from({ length:__autoDebtTest.MAX_DONE }, (_, n) => ({ changeId:`dwchg_${hex(n + 1)}`, points:0, obligations:0, budgetPassed:true, snapshotId:`ipsnap_${hex(n + 1)}`, measuredAt:'2026-01-01T00:00:00.000Z' }));
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, JSON.stringify({ schema:'idleproof.auto-debt-jobs.v1', jobs:[], done:old, measured:old.map((item) => item.changeId), skipped:[], skippedTotal:0, degraded:false }));
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    const run = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(run.results[0].state, 'done');
    const jobs = __autoDebtTest.readJobs(p.cwd);
    assert.equal(jobs.done.length, __autoDebtTest.MAX_DONE);
    assert.equal(jobs.done.some((item) => item.changeId === old[0].changeId), false);
    assert.equal(jobs.measured.length, __autoDebtTest.MAX_DONE + 1);
    assert.equal(autoDebtStatus(p.cwd, { probe:false }).counts.measured, __autoDebtTest.MAX_DONE + 1);
    // The oldest change left the details but not the identities: completing it again queues nothing.
    const identity = { available:true, changeId:old[0].changeId, repository:{ fingerprint:'dwrepo_x' }, base:{ tree:'a'.repeat(40), sha:null }, candidate:{ tree:'b'.repeat(40), sha:null } };
    assert.equal(enqueueAutoDebt(p.cwd, identity).reason, 'already-measured');
    assert.equal(enqueueAutoDebt(p.cwd, { ...identity, changeId:run.results[0].changeId }).reason, 'already-measured');
  } finally { p.done(); }
});

test('the status lists changes still waiting, retrying or failed before the measured ones', () => {
  const p = project();
  try {
    const hex = (n) => n.toString(16).padStart(24, '0');
    const done = Array.from({ length:12 }, (_, n) => ({ changeId:`dwchg_${hex(n + 1)}`, points:1, obligations:1, budgetPassed:true, snapshotId:`ipsnap_${hex(n + 1)}`, measuredAt:'2026-01-01T00:00:00.000Z' }));
    const waiting = { changeId:`dwchg_${'f'.repeat(24)}`, repository:null, base:{ tree:'a'.repeat(40), commit:null }, candidate:{ tree:'b'.repeat(40), commit:null },
      enqueuedAt:'2026-01-02T00:00:00.000Z', state:'pending', attempts:0, lastError:{ code:'CORE_UNAVAILABLE', message:'dw is not answering', at:'2026-01-02T00:00:00.000Z' }, lastAttemptAt:null, retryAfter:null };
    fs.mkdirSync(projectPaths(p.cwd).dir, { recursive:true });
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, JSON.stringify({ schema:'idleproof.auto-debt-jobs.v1', jobs:[waiting], done, measured:done.map((item) => item.changeId), skipped:[], skippedTotal:0, degraded:false }));
    const out = execFileSync(process.execPath, [CLI, 'portal', 'auto-debt', 'status'], { cwd:p.cwd, encoding:'utf8' });
    const lines = out.split('\n').filter((line) => line.startsWith('  dwchg_'));
    assert.equal(lines.length, 10);
    assert.match(lines[0], new RegExp(`${waiting.changeId} · retrying · CORE_UNAVAILABLE: dw is not answering`));
    assert.match(out, /… 3 more \(idleproof portal auto-debt status --json\)/);
  } finally { p.done(); }
});

test('failed jobs neither block new changes nor accumulate: only the latest stay listed, older ones are counted', async () => {
  const p = project();
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    const hex = (n) => n.toString(16).padStart(24, '0');
    const failedJob = (n) => ({ changeId:`dwchg_${hex(n)}`, repository:null, base:{ tree:'a'.repeat(40), commit:null }, candidate:{ tree:'b'.repeat(40), commit:null },
      enqueuedAt:'2026-01-01T00:00:00.000Z', state:'failed', attempts:1, lastError:{ code:'REFERENCE_UNAVAILABLE', message:'gone', at:'2026-01-01T00:00:00.000Z' }, lastAttemptAt:null, retryAfter:null });
    const failed = Array.from({ length:__autoDebtTest.MAX_FAILED }, (_, n) => failedJob(n + 1));
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, JSON.stringify({ schema:'idleproof.auto-debt-jobs.v1', jobs:failed, done:[], measured:[], skipped:[], skippedTotal:0, degraded:false }));
    // A full list of failures does not take the place of a new change.
    const identity = { available:true, changeId:`dwchg_${'e'.repeat(24)}`, repository:{ fingerprint:'dwrepo_x' }, base:{ tree:'c'.repeat(40), sha:null }, candidate:{ tree:'d'.repeat(40), sha:null } };
    assert.equal(enqueueAutoDebt(p.cwd, identity).queued, true);
    // Its trees do not exist: it fails too, and the oldest failure leaves the list but is counted.
    const run = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(run.results[0].code, 'REFERENCE_UNAVAILABLE');
    const jobs = __autoDebtTest.readJobs(p.cwd);
    assert.equal(jobs.jobs.filter((job) => job.state === 'failed').length, __autoDebtTest.MAX_FAILED);
    assert.equal(jobs.jobs.some((job) => job.changeId === failed[0].changeId), false);
    assert.equal(jobs.jobs.some((job) => job.changeId === identity.changeId), true);
    const status = autoDebtStatus(p.cwd, { probe:false });
    assert.equal(status.counts.failed, __autoDebtTest.MAX_FAILED);
    assert.equal(status.counts.failedNoLongerListed, 1);
    assert.equal(status.degraded, false);
    assert.equal(received.length, 0);
    // That older change is then measured manually: it is no longer counted as an older failure.
    assert.equal(settleWithManualAssurance(p.cwd, failed[0].changeId, { snapshotId:null }).settled, true);
    assert.equal(autoDebtStatus(p.cwd, { probe:false }).counts.failedNoLongerListed, 0);
    // Another failure evicts the next oldest; presented again later, that change is queued anew and is no
    // longer counted as an older failure either.
    const another = { ...identity, changeId:`dwchg_${'f'.repeat(24)}` };
    assert.equal(enqueueAutoDebt(p.cwd, another).queued, true);
    assert.equal((await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) })).results[0].code, 'REFERENCE_UNAVAILABLE');
    assert.equal(autoDebtStatus(p.cwd, { probe:false }).counts.failedNoLongerListed, 1);
    const again = { available:true, changeId:failed[1].changeId, repository:{ fingerprint:'dwrepo_x' }, base:{ tree:'a'.repeat(40), sha:null }, candidate:{ tree:'b'.repeat(40), sha:null } };
    assert.equal(enqueueAutoDebt(p.cwd, again).queued, true);
    assert.equal(autoDebtStatus(p.cwd, { probe:false }).counts.failedNoLongerListed, 0);
  } finally { p.done(); }
});

test('a measurement the delivery queue refused is kept and sent later, without measuring again', async () => {
  const p = project();
  const received = [];
  const log = path.join(p.cwd, '..', `${path.basename(p.cwd)}-dw.log`);
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    // Portal is disconnected when the measurement is ready: the queue refuses it.
    fs.rmSync(projectPaths(p.cwd).portalConfig);
    process.env.FAKE_DW_LOG = log;
    const refused = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(refused.results[0].state, 'waiting');
    assert.equal(refused.results[0].code, 'PORTAL_NOT_CONFIGURED');
    const measuredOnce = fs.readFileSync(log, 'utf8').split('\n').filter((line) => /^(debt|envelope) /.test(line)).length;
    assert.equal(measuredOnce, 2);
    // Later triggers, and Core gone meanwhile: nothing is measured again.
    await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    fs.rmSync(p.dw);
    writePortalConfig(p.cwd, { endpoint:'http://127.0.0.1:9/api/v1/snapshots', token:TOKEN });
    const sent = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(sent.results[0].state, 'done');
    assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter((line) => /^(debt|envelope) /.test(line)).length, measuredOnce);
    assert.equal(withAssurance(received).length, 1);
    assert.equal(withAssurance(received)[0].assurance.softwareDebt.points, 8);
    assert.equal(autoDebtStatus(p.cwd, { probe:false }).changes.find((item) => item.changeId === sent.results[0].changeId).delivery, 'delivered');
  } finally { delete process.env.FAKE_DW_LOG; cleanup(log); p.done(); }
});

test('Core arguments reach the launcher literally, whatever the repository path holds', async () => {
  // cmd.exe runs a .cmd/.bat launcher on Windows: every argument is quoted, and what quoting cannot
  // protect is refused before anything runs.
  const line = __autoDebtTest.windowsShellLine('C:\\Tools\\dw.cmd', ['debt', '--repo', 'C:\\work\\a&b (x)|y\\', '--base', 'abc']);
  assert.equal(line, '"C:\\Tools\\dw.cmd" "debt" "--repo" "C:\\work\\a&b (x)|y\\\\" "--base" "abc"');
  for (const unsafe of ['C:\\100%\\x', 'C:\\a"b', 'C:\\wow!', 'C:\\a\nb']) assert.equal(__autoDebtTest.windowsShellLine('C:\\dw.cmd', ['--repo', unsafe]), null);
  // A real measurement from a repository whose path holds shell metacharacters (through the .cmd
  // launcher and cmd.exe on Windows).
  const p = project({ prefix:'idleproof-auto-debt-a&b (x)-' });
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    const run = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(run.results[0].state, 'done');
    assert.equal(withAssurance(received).length, 1);
  } finally { p.done(); }
});

test('an explicit retry resets only the failed job it takes; the others stay failed', async () => {
  const p = project();
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    const failedJob = (n) => ({ changeId:`dwchg_${String(n).padStart(24, '0')}`, repository:null, base:{ tree:'a'.repeat(40), commit:null }, candidate:{ tree:'b'.repeat(40), commit:null },
      enqueuedAt:'2026-01-01T00:00:00.000Z', state:'failed', attempts:5, lastError:{ code:'MEASUREMENT_FAILED', message:'x', at:'2026-01-01T00:00:00.000Z' }, lastAttemptAt:null, retryAfter:null });
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, JSON.stringify({ schema:'idleproof.auto-debt-jobs.v1', jobs:[failedJob(1), failedJob(2)], done:[], measured:[], skipped:[], skippedTotal:0, degraded:false }));
    // Core is gone: the run stops at the first job it takes.
    fs.rmSync(p.dw);
    const run = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received), retryFailed:true });
    assert.deepEqual(run.results.map((item) => [item.changeId, item.state]), [[failedJob(1).changeId, 'core-unavailable']]);
    const states = Object.fromEntries(__autoDebtTest.readJobs(p.cwd).jobs.map((job) => [job.changeId, job.state]));
    assert.equal(states[failedJob(1).changeId], 'pending');
    assert.equal(states[failedJob(2).changeId], 'failed');
  } finally { p.done(); }
});

test('a full delivery queue is sent by the worker, then the kept measurement is queued in the same run', async () => {
  const p = project();
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    // The Portal delivery queue is already full of older receipts.
    const older = buildCurrentPortalSnapshot(p.cwd);
    fs.writeFileSync(projectPaths(p.cwd).portalQueue, JSON.stringify(Array.from({ length:200 }, () => older)));
    // Even when that job is the last one this run may take, its second attempt still happens.
    const run = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received), maxJobs:1 });
    assert.deepEqual(run.results.map((item) => [item.state, item.code ?? null]), [['waiting', 'PORTAL_QUEUE_FULL'], ['done', null]]);
    assert.equal(received.some((item) => item.snapshotId === older.snapshotId), true);
    assert.equal(withAssurance(received).length, 1);
    assert.equal(queued(p.cwd).length, 0);
    // Nothing was lost: the kept measurement waited, so Portal delivery health records no skipped snapshot.
    const health = portalStatus(p.cwd);
    assert.equal(health.degraded, false);
    assert.equal(health.skippedSnapshots, 0);
  } finally { p.done(); }
});

test('a change recorded as not measured and admitted later is no longer reported as not measured', () => {
  const p = project();
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    const identity = (n) => ({ available:true, changeId:`dwchg_${String(n).padStart(24, '0')}`, repository:{ fingerprint:'dwrepo_x' }, base:{ tree:'a'.repeat(40), sha:null }, candidate:{ tree:`${String(n).padStart(40, 'b')}`, sha:null } });
    for (let n = 1; n <= __autoDebtTest.MAX_JOBS; n += 1) assert.equal(enqueueAutoDebt(p.cwd, identity(n)).queued, true);
    const late = identity(__autoDebtTest.MAX_JOBS + 1);
    assert.equal(enqueueAutoDebt(p.cwd, late).reason, 'queue-full');
    // Presented again while the queue is still full (Stop, then SessionEnd): still one not-measured change.
    assert.equal(enqueueAutoDebt(p.cwd, late).reason, 'queue-full');
    assert.equal(autoDebtStatus(p.cwd, { probe:false }).counts.skipped, 1);
    assert.equal(autoDebtStatus(p.cwd, { probe:false }).degraded, true);
    // A worker frees a slot, then a later hook (SessionEnd) presents the same change again.
    const jobs = __autoDebtTest.readJobs(p.cwd);
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, JSON.stringify({ ...jobs, jobs:jobs.jobs.slice(1) }));
    assert.equal(enqueueAutoDebt(p.cwd, late).queued, true);
    const status = autoDebtStatus(p.cwd, { probe:false });
    assert.equal(status.degraded, false);
    assert.equal(status.counts.skipped, 0);
    assert.equal(status.skipped.some((item) => item.changeId === late.changeId), false);
  } finally { p.done(); }
});

test('every change recorded as not measured stays counted until it is admitted, beyond the listed ones', () => {
  const p = project();
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    const identity = (n) => ({ available:true, changeId:`dwchg_${String(n).padStart(24, '0')}`, repository:{ fingerprint:'dwrepo_x' }, base:{ tree:'a'.repeat(40), sha:null }, candidate:{ tree:`${String(n).padStart(40, 'b')}`, sha:null } });
    for (let n = 1; n <= __autoDebtTest.MAX_JOBS; n += 1) assert.equal(enqueueAutoDebt(p.cwd, identity(n)).queued, true);
    // As many changes as the list holds were already refused while the queue stayed full.
    const refused = (n) => identity(1000 + n);
    const record = (n) => ({ changeId:refused(n).changeId, at:new Date(0).toISOString(), base:{ tree:'a'.repeat(40), commit:null }, candidate:{ tree:refused(n).candidate.tree, commit:null } });
    const jobs = __autoDebtTest.readJobs(p.cwd);
    const listed = Array.from({ length:__autoDebtTest.MAX_SKIPPED }, (_, n) => record(n));
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, JSON.stringify({ ...jobs, skipped:listed, skippedIds:listed.map((item) => item.changeId), skippedTotal:listed.length, degraded:true }));
    // One more: the oldest leaves the listed details but is still counted.
    assert.equal(enqueueAutoDebt(p.cwd, refused(__autoDebtTest.MAX_SKIPPED)).reason, 'queue-full');
    assert.equal(autoDebtStatus(p.cwd, { probe:false }).counts.skipped, __autoDebtTest.MAX_SKIPPED + 1);
    assert.equal(__autoDebtTest.readJobs(p.cwd).skipped.some((item) => item.changeId === refused(0).changeId), false);
    // Presented again while the queue is still full, it is not counted twice.
    assert.equal(enqueueAutoDebt(p.cwd, refused(0)).reason, 'queue-full');
    assert.equal(autoDebtStatus(p.cwd, { probe:false }).counts.skipped, __autoDebtTest.MAX_SKIPPED + 1);
    // A slot frees up and a change no longer listed (refused(1)) is admitted: it is no longer counted.
    assert.equal(__autoDebtTest.readJobs(p.cwd).skipped.some((item) => item.changeId === refused(1).changeId), false);
    const full = __autoDebtTest.readJobs(p.cwd);
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, JSON.stringify({ ...full, jobs:full.jobs.slice(1) }));
    assert.equal(enqueueAutoDebt(p.cwd, refused(1)).queued, true);
    const status = autoDebtStatus(p.cwd, { probe:false });
    assert.equal(status.counts.skipped, __autoDebtTest.MAX_SKIPPED);
    assert.equal(status.degraded, true);
    assert.equal(__autoDebtTest.readJobs(p.cwd).skippedIds.includes(refused(1).changeId), false);
  } finally { p.done(); }
});

test('a Core envelope that runs out of time counts as a failed attempt, up to the failed state', async () => {
  const p = project();
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    // Earlier attempts already failed; this one is the last.
    const jobs = __autoDebtTest.readJobs(p.cwd);
    jobs.jobs[0].attempts = __autoDebtTest.MAX_ATTEMPTS - 1;
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, JSON.stringify(jobs));
    process.env.FAKE_DW_HANG = 'envelope';
    const run = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received), measureTimeoutMs:4000 });
    assert.equal(run.results[0].state, 'retry');
    assert.equal(run.results[0].code, 'ENVELOPE_TIMEOUT');
    const job = __autoDebtTest.readJobs(p.cwd).jobs[0];
    assert.equal(job.state, 'failed');
    assert.equal(job.attempts, __autoDebtTest.MAX_ATTEMPTS);
    assert.equal(job.lastError.code, 'ENVELOPE_TIMEOUT');
    assert.equal(autoDebtStatus(p.cwd, { probe:false }).changes[0].state, 'failed');
    assert.equal(received.length, 0);
  } finally { delete process.env.FAKE_DW_HANG; p.done(); }
});

test('a manual assurance settles the automatic job of the same change: Core is not run again', async () => {
  const p = project();
  const received = [];
  const log = path.join(p.cwd, '..', `${path.basename(p.cwd)}-dw.log`);
  const debtFile = path.join(p.cwd, '..', `${path.basename(p.cwd)}-debt.json`);
  const envelopeFile = path.join(p.cwd, '..', `${path.basename(p.cwd)}-envelope.json`);
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    const job = __autoDebtTest.readJobs(p.cwd).jobs[0];
    assert.equal(job.state, 'pending');
    // The documented manual path, while the automatic job is still waiting.
    git(p.cwd, 'add', '-A'); git(p.cwd, 'commit', '-qm', 'change');
    execFileSync(process.execPath, [FAKE_DW, 'debt', '--repo', p.cwd, '--base', 'HEAD~1', '--candidate', 'HEAD', '--json', debtFile], { cwd:p.cwd });
    execFileSync(process.execPath, [FAKE_DW, 'envelope', '--repo', p.cwd, '--base', 'HEAD~1', '--candidate', 'HEAD', '--debt', debtFile, '--out', envelopeFile], { cwd:p.cwd });
    assert.equal(JSON.parse(fs.readFileSync(envelopeFile, 'utf8')).change_id, job.changeId);
    const manual = JSON.parse(spawnSync(process.execPath, [CLI, 'portal', 'assurance', '--envelope', envelopeFile, '--json'], { cwd:p.cwd, encoding:'utf8' }).stdout);
    assert.equal(manual.autoDebt.settled, true);
    assert.equal(manual.autoDebt.hadJob, true);
    process.env.FAKE_DW_LOG = log;
    const run = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(run.results.length, 0);
    assert.equal(fs.existsSync(log), false);
    const change = autoDebtStatus(p.cwd, { probe:false }).changes.find((item) => item.changeId === job.changeId);
    assert.equal(change.state, 'measured');
    assert.equal(change.source, 'manual');
    assert.equal(change.points, 8);
    const identity = { available:true, changeId:job.changeId, repository:{ fingerprint:'dwrepo_x' }, base:{ tree:job.base.tree, sha:null }, candidate:{ tree:job.candidate.tree, sha:null } };
    assert.equal(enqueueAutoDebt(p.cwd, identity).reason, 'already-measured');
  } finally { delete process.env.FAKE_DW_LOG; for (const file of [log, debtFile, envelopeFile]) cleanup(file); p.done(); }
});

test('a change Core measured but IdleProof could not correlate keeps its envelope: a retry correlates it without measuring again', async () => {
  const p = project();
  const received = [];
  const log = path.join(p.cwd, '..', `${path.basename(p.cwd)}-dw.log`);
  const stateFiles = [projectPaths(p.cwd).state, projectPaths(p.cwd).stateBackup];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    const job = __autoDebtTest.readJobs(p.cwd).jobs[0];
    // The session history no longer holds the change (it aged out): correlation fails after Core measured it.
    for (const file of stateFiles) if (fs.existsSync(file)) fs.renameSync(file, `${file}.hidden`);
    process.env.FAKE_DW_LOG = log;
    const first = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(first.results[0].code, 'NOT_CORRELATED');
    const failed = __autoDebtTest.readJobs(p.cwd);
    assert.equal(failed.jobs[0].state, 'failed');
    assert.equal(failed.measured.includes(job.changeId), true);
    assert.equal(received.length, 0);
    // The history holds the change again: the explicit retry correlates the kept envelope, and Core is not run.
    for (const file of stateFiles) if (fs.existsSync(`${file}.hidden`)) fs.renameSync(`${file}.hidden`, file);
    const retried = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received), retryFailed:true });
    assert.equal(retried.results[0].state, 'done');
    assert.equal(withAssurance(received).length, 1);
    assert.equal(withAssurance(received)[0].change.changeId, job.changeId);
    const calls = fs.readFileSync(log, 'utf8').split('\n');
    assert.equal(calls.filter((line) => line.startsWith('debt --repo')).length, 1);
    assert.equal(calls.filter((line) => line.startsWith('envelope ')).length, 1);
  } finally { delete process.env.FAKE_DW_LOG; cleanup(log); p.done(); }
});

test('a manual assurance that the current Portal queue refuses does not settle the automatic job', async () => {
  const p = project();
  const debtFile = path.join(p.cwd, '..', `${path.basename(p.cwd)}-debt.json`);
  const envelopeFile = path.join(p.cwd, '..', `${path.basename(p.cwd)}-envelope.json`);
  const assurance = () => JSON.parse(spawnSync(process.execPath, [CLI, 'portal', 'assurance', '--envelope', envelopeFile, '--json'], { cwd:p.cwd, encoding:'utf8' }).stdout);
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    const waiting = fs.readFileSync(projectPaths(p.cwd).autoDebtJobs, 'utf8');
    const job = __autoDebtTest.readJobs(p.cwd).jobs[0];
    git(p.cwd, 'add', '-A'); git(p.cwd, 'commit', '-qm', 'change');
    execFileSync(process.execPath, [FAKE_DW, 'debt', '--repo', p.cwd, '--base', 'HEAD~1', '--candidate', 'HEAD', '--json', debtFile], { cwd:p.cwd });
    execFileSync(process.execPath, [FAKE_DW, 'envelope', '--repo', p.cwd, '--base', 'HEAD~1', '--candidate', 'HEAD', '--debt', debtFile, '--out', envelopeFile], { cwd:p.cwd });
    // Sent once, to an earlier enrollment: that receipt is recorded as sent.
    const first = assurance();
    assert.equal(first.accepted, true);
    assert.equal(first.autoDebt.settled, true);
    // Later the automatic job of the same change waits again, and the current enrollment's delivery queue is
    // full of other receipts.
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, waiting);
    const older = buildCurrentPortalSnapshot(p.cwd);
    fs.writeFileSync(projectPaths(p.cwd).portalQueue, JSON.stringify(Array.from({ length:200 }, () => older)));
    const refused = assurance();
    assert.equal(refused.queueReason, 'already-sent');
    assert.equal(refused.accepted, false);
    assert.equal(refused.autoDebt, undefined);
    const jobs = __autoDebtTest.readJobs(p.cwd);
    assert.equal(jobs.jobs.find((item) => item.changeId === job.changeId)?.state, 'pending');
    assert.equal(jobs.measured.includes(job.changeId), false);
  } finally { for (const file of [debtFile, envelopeFile]) cleanup(file); p.done(); }
});

test('a DiffWitness receipt that the IDE hook queues settles the automatic job of the same change', async () => {
  const p = project();
  const received = [];
  const log = path.join(p.cwd, '..', `${path.basename(p.cwd)}-dw.log`);
  const debtFile = path.join(p.cwd, '..', `${path.basename(p.cwd)}-debt.json`);
  const envelopeFile = path.join(p.cwd, '.git', 'diffwitness', 'change-envelope.json');
  // The hook also schedules a detached flush; an invalid NODE_OPTIONS makes that child exit at startup.
  const hook = () => {
    const nodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--idleproof-test-no-background-flush';
    try { return queueMatchingDiffWitnessAssurance(p.cwd); }
    finally { if (nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = nodeOptions; }
  };
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    const job = __autoDebtTest.readJobs(p.cwd).jobs[0];
    // The DiffWitness IDE integration measured the change and left its envelope for the hook.
    git(p.cwd, 'add', '-A'); git(p.cwd, 'commit', '-qm', 'change');
    fs.mkdirSync(path.dirname(envelopeFile), { recursive:true });
    execFileSync(process.execPath, [FAKE_DW, 'debt', '--repo', p.cwd, '--base', 'HEAD~1', '--candidate', 'HEAD', '--json', debtFile], { cwd:p.cwd });
    execFileSync(process.execPath, [FAKE_DW, 'envelope', '--repo', p.cwd, '--base', 'HEAD~1', '--candidate', 'HEAD', '--debt', debtFile, '--out', envelopeFile], { cwd:p.cwd });
    // The delivery queue is full: the hook's receipt is refused, and the automatic job keeps waiting.
    const older = buildCurrentPortalSnapshot(p.cwd);
    fs.writeFileSync(projectPaths(p.cwd).portalQueue, JSON.stringify(Array.from({ length:200 }, () => older)));
    const refused = hook();
    assert.equal(refused.matched, true);
    assert.equal(refused.queued, false);
    assert.equal(refused.autoDebt, null);
    assert.equal(__autoDebtTest.readJobs(p.cwd).jobs[0].state, 'pending');
    // With room in the queue, the hook's receipt is accepted and settles the job.
    fs.writeFileSync(projectPaths(p.cwd).portalQueue, '[]');
    const hooked = hook();
    assert.equal(hooked.queued, true);
    assert.equal(hooked.autoDebt.settled, true);
    assert.equal(hooked.autoDebt.hadJob, true);
    process.env.FAKE_DW_LOG = log;
    const run = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(run.results.length, 0);
    assert.equal(fs.existsSync(log), false);
    const change = autoDebtStatus(p.cwd, { probe:false }).changes.find((item) => item.changeId === job.changeId);
    assert.equal(change.state, 'measured');
    assert.equal(change.source, 'ide');
    assert.equal(change.points, 8);
  } finally { delete process.env.FAKE_DW_LOG; for (const file of [log, debtFile]) cleanup(file); p.done(); }
});

test('`auto-debt run` delivers receipts queued earlier, even when it has nothing to measure', async () => {
  const received = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = request.method === 'POST' ? JSON.parse(body || '{}') : null;
      if (!/^ipsnap_/.test(String(parsed?.snapshotId || ''))) { response.writeHead(404, { 'content-type':'application/json' }); response.end('{}'); return; }
      received.push(parsed);
      response.writeHead(202, { 'content-type':'application/json' });
      response.end(JSON.stringify(ack(body)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const p = project({ endpoint:`http://127.0.0.1:${server.address().port}/api/v1/snapshots` });
  // Asynchronous, so that the Portal stand-in in this process can answer the command.
  const cli = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'portal', 'auto-debt', 'run', '--json'], { cwd:p.cwd });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => resolve(JSON.parse(out)));
  });
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    // The hook's own detached flush is kept out of this test: an invalid NODE_OPTIONS makes it exit at startup.
    const nodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--idleproof-test-no-background-flush';
    try { completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n'); }
    finally { if (nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = nodeOptions; }
    // Measured and queued while Portal was offline: the job is done, the receipt waits in the delivery queue.
    const offline = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub([], { down:true }) });
    assert.equal(offline.results[0].state, 'done');
    assert.equal(offline.delivery.ok, false);
    assert.equal(withAssurance(queued(p.cwd)).length, 1);
    // Portal is back. The command has no job to measure, and still delivers the waiting receipt.
    const run = await cli();
    assert.equal(run.results.length, 0);
    assert.equal(run.delivery.ok, true);
    assert.equal(withAssurance(received).length, 1);
    assert.equal(queued(p.cwd).length, 0);
    // With nothing queued and nothing to measure, the command does not touch the network.
    assert.equal((await cli()).delivery, null);
  } finally { p.done(); await new Promise((resolve) => server.close(resolve)); }
});

test('`auto-debt run` reports an unreadable delivery queue instead of taking it for an empty one', async () => {
  const p = project();
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    fs.writeFileSync(projectPaths(p.cwd).portalQueue, '{ damaged');
    const run = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub([]), deliverQueued:true });
    assert.equal(run.results.length, 0);
    assert.equal(run.delivery.ok, false);
    assert.equal(run.delivery.errorCode, 'IDLEPROOF_PORTAL_QUEUE_CORRUPT');
    assert.equal(fs.readFileSync(projectPaths(p.cwd).portalQueue, 'utf8'), '{ damaged');
  } finally { p.done(); }
});

test('reset never moves the local state under a measurement, and a worker then leaves it alone', async () => {
  const p = project();
  const reset = () => spawnSync(process.execPath, [CLI, 'reset'], { cwd:p.cwd, encoding:'utf8' });
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    // A worker is measuring: Core takes a while.
    const child = spawn(process.execPath, [CLI, 'portal', 'auto-debt', 'run', '--json'], { cwd:p.cwd, env:{ ...process.env, FAKE_DW_SLEEP_MS:'7000' } });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    const finished = new Promise((resolve) => child.on('close', resolve));
    for (let i = 0; i < 200 && __autoDebtTest.readJobs(p.cwd).jobs[0]?.state !== 'measuring'; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(__autoDebtTest.readJobs(p.cwd).jobs[0].state, 'measuring');
    // Reset waits for the worker's lock, then stops explicitly: nothing is moved.
    const refused = reset();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /measuring or delivering a change/);
    assert.equal(fs.existsSync(projectPaths(p.cwd).autoDebtJobs), true);
    await finished;
    assert.equal(JSON.parse(out).results[0].state, 'done');
    // Once the job has ended, reset archives the state with its result, and without its own lock.
    const archived = reset();
    assert.equal(archived.status, 0, archived.stderr);
    assert.equal(fs.existsSync(projectPaths(p.cwd).dir), false);
    const recovery = path.join(p.cwd, '.git', 'idleproof-recovery');
    const [entry] = fs.readdirSync(recovery);
    assert.equal(JSON.parse(fs.readFileSync(path.join(recovery, entry, 'auto-debt-jobs.json'), 'utf8')).done.length, 1);
    assert.equal(fs.existsSync(path.join(recovery, entry, 'auto-debt-worker.lock')), false);
    // A worker that takes its lock right after a reset finds no configuration, and writes nothing.
    assert.equal(__autoDebtTest.processNextJob(p.cwd, { enabled:true, dw:p.dw }), null);
    assert.equal(fs.existsSync(projectPaths(p.cwd).autoDebtJobs), false);
  } finally { p.done(); }
});

test('reset never moves the local state while the worker delivers, and the delivery recreates nothing', async () => {
  const p = project();
  const received = [];
  let answer;
  const answered = new Promise((resolve) => { answer = resolve; });
  // A Portal that answers only when the test lets it.
  const slowPortal = async (url, options) => {
    await answered;
    received.push(JSON.parse(options.body));
    return new Response(JSON.stringify(ack(options.body)), { status:202, headers:{ 'content-type':'application/json' } });
  };
  const reset = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'reset'], { cwd:p.cwd });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stderr }));
  });
  let run = null;
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    // The hook's own detached flush is kept out of this test: an invalid NODE_OPTIONS makes it exit at startup.
    const nodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--idleproof-test-no-background-flush';
    try { completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n'); }
    finally { if (nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = nodeOptions; }
    run = runAutoDebtWorker(p.cwd, { fetchImpl:slowPortal, timeoutMs:15000 });
    // The change is measured; its delivery is in flight and holds the worker lock.
    for (let i = 0; i < 200 && !fs.existsSync(projectPaths(p.cwd).autoDebtWorkerLock); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(fs.existsSync(projectPaths(p.cwd).autoDebtWorkerLock), true);
    const refused = await reset();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /measuring or delivering a change/);
    assert.equal(fs.existsSync(projectPaths(p.cwd).autoDebtJobs), true);
    // Portal answers: the delivery ends, then reset archives the state, and nothing recreates it.
    answer();
    const result = await run;
    assert.equal(result.results[0].state, 'done');
    assert.equal(result.delivery.ok, true);
    assert.equal(withAssurance(received).length, 1);
    const archived = await reset();
    assert.equal(archived.status, 0, archived.stderr);
    assert.equal(fs.existsSync(projectPaths(p.cwd).dir), false);
    // A worker started for the reset project stops without writing anything.
    assert.deepEqual(await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received), deliverQueued:true }), { enabled:false, results:[] });
    assert.equal(fs.existsSync(projectPaths(p.cwd).dir), false);
  } finally { answer(); if (run) await run.catch(() => {}); p.done(); }
});

test('references that no longer match are refused, never sent under another change', async () => {
  const p = project();
  const received = [];
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    completeChange(p.cwd, 'app.py', 'def total(items):\n    # TODO: check\n    return sum(items)\n');
    process.env.FAKE_DW_WRONG_CHANGE = '1';
    const mismatch = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    delete process.env.FAKE_DW_WRONG_CHANGE;
    assert.equal(mismatch.results[0].code, 'REFERENCE_MISMATCH');
    assert.equal(autoDebtStatus(p.cwd).changes[0].state, 'failed');
    completeChange(p.cwd, 'other.py', 'x = 1\n');
    const jobs = __autoDebtTest.readJobs(p.cwd);
    const pending = jobs.jobs.find((job) => job.state === 'pending');
    pending.candidate = { tree:'0'.repeat(40), commit:null };
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, JSON.stringify(jobs));
    const gone = await runAutoDebtWorker(p.cwd, { fetchImpl:portalStub(received) });
    assert.equal(gone.results[0].code, 'REFERENCE_UNAVAILABLE');
    assert.equal(received.length, 0);
  } finally { delete process.env.FAKE_DW_WRONG_CHANGE; p.done(); }
});

test('a full queue records the change as not measured and degrades the status; a damaged queue is never replaced', () => {
  const p = project();
  try {
    enableAutoDebt(p.cwd, { dw:p.dw });
    const identity = (n) => ({ available:true, changeId:`dwchg_${String(n).padStart(24, '0')}`, repository:{ fingerprint:'dwrepo_x' }, base:{ tree:'a'.repeat(40), sha:null }, candidate:{ tree:`${String(n).padStart(40, 'b')}`, sha:null } });
    for (let n = 1; n <= __autoDebtTest.MAX_JOBS; n += 1) assert.equal(enqueueAutoDebt(p.cwd, identity(n)).queued, true);
    const overflow = enqueueAutoDebt(p.cwd, identity(__autoDebtTest.MAX_JOBS + 1));
    assert.equal(overflow.reason, 'queue-full');
    const status = autoDebtStatus(p.cwd, { probe:false });
    assert.equal(status.degraded, true);
    assert.equal(status.counts.skipped, 1);
    assert.equal(status.skipped[0].changeId, identity(__autoDebtTest.MAX_JOBS + 1).changeId);
    fs.writeFileSync(projectPaths(p.cwd).autoDebtJobs, '{ damaged');
    assert.throws(() => enqueueAutoDebt(p.cwd, identity(999)), (error) => error.code === 'IDLEPROOF_AUTO_DEBT_STATE_CORRUPT');
    assert.equal(fs.readFileSync(projectPaths(p.cwd).autoDebtJobs, 'utf8'), '{ damaged');
    assert.equal(autoDebtStatus(p.cwd, { probe:false }).errorCode, 'IDLEPROOF_AUTO_DEBT_STATE_CORRUPT');
    // The hook stays fail-open.
    const hook = completeChange(p.cwd, 'app.py', 'x = 2\n');
    assert.equal(hook.autoDebt.errorCode, 'IDLEPROOF_AUTO_DEBT_STATE_CORRUPT');
  } finally { p.done(); }
});

test('end to end through `idleproof run`: the detached worker measures and delivers, and the CLI reports it', async () => {
  const received = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      // Only snapshot deliveries are answered; anything else (a memory page) is not supported here.
      const parsed = request.method === 'POST' ? JSON.parse(body || '{}') : null;
      if (!/^ipsnap_/.test(String(parsed?.snapshotId || ''))) { response.writeHead(404, { 'content-type':'application/json' }); response.end('{}'); return; }
      received.push(parsed);
      response.writeHead(202, { 'content-type':'application/json' });
      response.end(JSON.stringify(ack(body)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const p = project({ endpoint:`http://127.0.0.1:${server.address().port}/api/v1/snapshots` });
  try {
    execFileSync(process.execPath, [CLI, 'portal', 'auto-debt', 'enable', '--dw', p.dw], { cwd:p.cwd, encoding:'utf8' });
    const env = { ...process.env };
    delete env.IDLEPROOF_AUTO_DEBT_WORKER;
    // The command run by IdleProof is a script file outside the repository: no shell quoting on any platform.
    const script = path.join(path.dirname(p.dw), 'change.cjs');
    fs.writeFileSync(script, "require('fs').writeFileSync('app.py', 'def total(items):\\n    # TODO: check\\n    return sum(items)\\n')\n");
    execFileSync(process.execPath, [CLI, 'run', '--', process.execPath, script], { cwd:p.cwd, encoding:'utf8', env });
    let status;
    for (let i = 0; i < 100; i += 1) {
      status = JSON.parse(execFileSync(process.execPath, [CLI, 'portal', 'auto-debt', 'status', '--json'], { cwd:p.cwd, encoding:'utf8' }));
      if (status.changes[0]?.delivery === 'delivered') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(status.changes[0].state, 'measured');
    assert.equal(status.changes[0].delivery, 'delivered');
    assert.equal(withAssurance(received).length, 1);
    const text = execFileSync(process.execPath, [CLI, 'portal', 'auto-debt', 'status'], { cwd:p.cwd, encoding:'utf8' });
    assert.match(text, /Automatic debt: enabled/);
    assert.match(text, /8 point\(s\) · 2 obligation\(s\) · budget PASS · delivered/);
  } finally { server.close(); p.done(); }
});
