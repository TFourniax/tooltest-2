// Automatic Core debt of changes completed through IdleProof (ALPHA-AUTO-DEBT). Off until the
// project owner runs `idleproof portal auto-debt enable` once the project is attached to Portal.
//
// The hook that completes a change only records a job holding the change's exact references (its
// repository and its base and candidate Git trees, as IdleProof froze them) and starts a detached
// worker; no measurement and no network happen on the interactive hook path. The worker measures the
// change with the Core CLI (`dw debt`, then `dw envelope`) on unreachable commit objects built from
// those trees, the way Core builds its own analytical baselines (no ref, no index, no user commit), and
// hands the envelope to the same assurance receipt path and Portal delivery queue as
// `idleproof portal assurance`. The manual commands stay available for diagnosis and recalculation.
//
// Guarantees:
//   * one job per change; a change already measured is never measured again automatically, and one
//     measurement stays one receipt whichever route (this worker, the IDE hook, the command) sent it;
//   * jobs survive interruptions: a job left `measuring` by a worker that died is measured again by the
//     next one (measurement uses `--no-record`, so a retry measures exactly the same way);
//   * nothing is dropped silently: a full queue records the change as skipped and marks the status
//     degraded; a Core failure keeps the job, with its reason, and never sends a value;
//   * Core or Portal being down never blocks development: the hook only writes a small file.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { PACKAGE_ROOT, projectPaths } from './paths.mjs';
import { withOwnedLock } from './portal-memory-lock.mjs';
import { flushPortalQueue, queuedPortalSnapshot, readPortalConfig } from './portal-client.mjs';
import { buildAssurancePortalSnapshot, queueAssuranceReceipt } from './portal-assurance.mjs';

const CONFIG_SCHEMA = 'idleproof.auto-debt-config.v1';
const JOBS_SCHEMA = 'idleproof.auto-debt-jobs.v1';
// Jobs still to measure, retrying or failed. Beyond it a completed change is recorded as skipped.
const MAX_JOBS = 100;
// Identities of measured changes (about a hundred bytes each), so none is measured twice.
const MAX_DONE = 2048;
const MAX_SKIPPED = 200;
const MAX_ATTEMPTS = 5;
const KEPT_WORK_DIRS = 64;
const MEASURE_TIMEOUT_MS = 10 * 60 * 1000;
const CHANGE_ID = /^dwchg_[a-f0-9]{24}$/;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
// Fixed metadata: the reference commit of a tree is always the same object.
const REFERENCE_ENV = {
  GIT_AUTHOR_NAME:'IdleProof', GIT_AUTHOR_EMAIL:'idleproof@localhost', GIT_COMMITTER_NAME:'IdleProof', GIT_COMMITTER_EMAIL:'idleproof@localhost',
  GIT_AUTHOR_DATE:'2000-01-01T00:00:00+00:00', GIT_COMMITTER_DATE:'2000-01-01T00:00:00+00:00'
};

function autoDebtError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const staged = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { encoding:'utf8', mode:0o600, flag:'wx' });
    fs.renameSync(staged, file);
  } finally {
    try { fs.rmSync(staged, { force:true }); } catch {}
  }
}

export function readAutoDebtConfig(cwd = process.cwd()) {
  let value;
  try { value = JSON.parse(fs.readFileSync(projectPaths(cwd).autoDebtConfig, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw autoDebtError('IDLEPROOF_AUTO_DEBT_CONFIG_CORRUPT', `Automatic debt configuration is unreadable (${error?.code || 'invalid JSON'}); run \`idleproof portal auto-debt enable\` again.`);
  }
  if (value?.schema !== CONFIG_SCHEMA || typeof value.dw !== 'string' || !value.dw) throw autoDebtError('IDLEPROOF_AUTO_DEBT_CONFIG_CORRUPT', 'Automatic debt configuration has an unsupported schema; run `idleproof portal auto-debt enable` again.');
  return { enabled:value.enabled === true, dw:value.dw, enabledAt:typeof value.enabledAt === 'string' ? value.enabledAt : null };
}

function findOnPath(name) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  return null;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding:'utf8', windowsHide:true, maxBuffer:8 * 1024 * 1024, shell:process.platform === 'win32' && /\.(cmd|bat)$/i.test(command), ...options });
}

// The Core CLI, probed where it will run: `dw debt` must exist.
function probeCore(dw, cwd) {
  const result = run(dw, ['debt', '--help'], { cwd, timeout:20000 });
  if (result.error) return { ok:false, code:result.error.code === 'ETIMEDOUT' ? 'CORE_TIMEOUT' : 'CORE_UNAVAILABLE', message:String(result.error.message || result.error).slice(0, 300) };
  if (result.status !== 0 || !/dw debt/.test(`${result.stdout}${result.stderr}`)) return { ok:false, code:'CORE_UNSUPPORTED', message:String(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 300) };
  return { ok:true };
}

// Explicit activation for this project, once it is attached to Portal: the results go to that enrollment.
export function enableAutoDebt(cwd = process.cwd(), { dw = null } = {}) {
  const portal = readPortalConfig(cwd);
  if (!portal?.enabled) throw autoDebtError('IDLEPROOF_AUTO_DEBT_PORTAL_REQUIRED', 'Attach this project to Portal first (`idleproof portal configure --endpoint URL --token-stdin`): automatic debt results are sent to that enrollment.');
  const command = dw ? path.resolve(cwd, dw) : findOnPath('dw');
  if (!command) throw autoDebtError('IDLEPROOF_AUTO_DEBT_CORE_NOT_FOUND', 'The Core CLI `dw` is not on PATH; pass its location with --dw PATH.');
  const probe = probeCore(command, cwd);
  if (!probe.ok) throw autoDebtError('IDLEPROOF_AUTO_DEBT_CORE_UNAVAILABLE', `${command} does not answer as the Core CLI (${probe.code}: ${probe.message}).`);
  atomicJson(projectPaths(cwd).autoDebtConfig, { schema:CONFIG_SCHEMA, enabled:true, dw:command, enabledAt:new Date().toISOString() });
  return autoDebtStatus(cwd, { probe:false });
}

// Jobs and history are kept; only new completed changes stop being queued.
export function disableAutoDebt(cwd = process.cwd()) {
  const config = readAutoDebtConfig(cwd);
  if (config) atomicJson(projectPaths(cwd).autoDebtConfig, { schema:CONFIG_SCHEMA, enabled:false, dw:config.dw, enabledAt:config.enabledAt, disabledAt:new Date().toISOString() });
  return autoDebtStatus(cwd, { probe:false });
}

function emptyJobs() {
  return { schema:JOBS_SCHEMA, jobs:[], done:[], skipped:[], skippedTotal:0, degraded:false };
}

// Only a missing file is an empty queue; a damaged one stops the queue with an explicit error, never
// replaced by an empty one (that would lose the changes waiting in it).
function readJobs(cwd) {
  let value;
  try { value = JSON.parse(fs.readFileSync(projectPaths(cwd).autoDebtJobs, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return emptyJobs();
    throw autoDebtError('IDLEPROOF_AUTO_DEBT_STATE_CORRUPT', `The automatic debt queue ${'.idleproof/auto-debt-jobs.json'} is unreadable (${error?.code || 'invalid JSON'}); nothing was queued. Inspect it before removing it deliberately.`);
  }
  if (value?.schema !== JOBS_SCHEMA || !Array.isArray(value.jobs) || !Array.isArray(value.done) || !Array.isArray(value.skipped)) {
    throw autoDebtError('IDLEPROOF_AUTO_DEBT_STATE_CORRUPT', `The automatic debt queue ${'.idleproof/auto-debt-jobs.json'} has an unsupported schema; nothing was queued.`);
  }
  return { ...emptyJobs(), ...value, skippedTotal:Number.isInteger(value.skippedTotal) ? value.skippedTotal : value.skipped.length, degraded:value.degraded === true };
}

function withJobs(cwd, fn) {
  fs.mkdirSync(projectPaths(cwd).dir, { recursive:true });
  return withOwnedLock(projectPaths(cwd).autoDebtJobsLock, () => {
    const jobs = readJobs(cwd);
    const result = fn(jobs);
    atomicJson(projectPaths(cwd).autoDebtJobs, jobs);
    return result;
  }, 'IDLEPROOF_AUTO_DEBT_BUSY', 'Automatic debt queue');
}

// Called by the hook that completed the change: records its exact references, nothing else.
export function enqueueAutoDebt(cwd, identity, { now = new Date() } = {}) {
  const config = readAutoDebtConfig(cwd);
  if (!config?.enabled) return { queued:false, reason:'disabled' };
  const changeId = identity?.changeId;
  if (!identity?.available || !CHANGE_ID.test(String(changeId || '')) || !OBJECT_ID.test(String(identity.base?.tree || '')) || !OBJECT_ID.test(String(identity.candidate?.tree || ''))) {
    return { queued:false, reason:'no-exact-change' };
  }
  if (identity.base.tree === identity.candidate.tree) return { queued:false, reason:'empty-change', changeId };
  const reference = (side) => ({ tree:side.tree, commit:OBJECT_ID.test(String(side.sha || '')) ? side.sha : null });
  return withJobs(cwd, (state) => {
    if (state.jobs.some((job) => job.changeId === changeId)) return { queued:false, reason:'already-queued', changeId, pending:state.jobs.length };
    if (state.done.some((item) => item.changeId === changeId)) return { queued:false, reason:'already-measured', changeId, pending:state.jobs.length };
    if (state.jobs.length >= MAX_JOBS) {
      state.degraded = true;
      state.skippedTotal += 1;
      state.skipped = [...state.skipped.filter((item) => item.changeId !== changeId), { changeId, at:now.toISOString(), base:reference(identity.base), candidate:reference(identity.candidate) }].slice(-MAX_SKIPPED);
      return { queued:false, reason:'queue-full', changeId, pending:state.jobs.length };
    }
    state.jobs.push({ changeId, repository:identity.repository?.fingerprint ?? null, base:reference(identity.base), candidate:reference(identity.candidate),
      enqueuedAt:now.toISOString(), state:'pending', attempts:0, lastError:null, lastAttemptAt:null, retryAfter:null });
    return { queued:true, changeId, pending:state.jobs.length };
  });
}

function pendingJobs(cwd) {
  try { return readJobs(cwd).jobs.filter((job) => job.state === 'pending' || job.state === 'measuring').length; } catch { return 0; }
}

function spawnWorker(cwd) {
  const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'idleproof.mjs'), 'portal', 'auto-debt', 'run', '--quiet'], {
    cwd, detached:true, stdio:'ignore', windowsHide:true, env:{ ...process.env, IDLEPROOF_AUTO_DEBT_BACKGROUND:'1' }
  });
  child.once('error', () => {});
  child.unref();
}

// Hook entry point: queue the completed change (if any) and start a detached worker when there is work.
// With IDLEPROOF_AUTO_DEBT_WORKER=off the hook only queues, and `idleproof portal auto-debt run`
// measures when the user decides. Fail-open: an automatic debt problem never blocks the coding
// session; it is reported by status.
export function scheduleAutoDebt(cwd = process.cwd(), identity = null, { start = process.env.IDLEPROOF_AUTO_DEBT_WORKER === 'off' ? () => {} : spawnWorker } = {}) {
  try {
    const config = readAutoDebtConfig(cwd);
    if (!config?.enabled) return { scheduled:false, reason:'disabled' };
    const queued = identity ? enqueueAutoDebt(cwd, identity) : { queued:false, reason:'no-change' };
    if (!queued.queued && !pendingJobs(cwd)) return { scheduled:false, ...queued };
    start(cwd);
    return { scheduled:true, ...queued };
  } catch (error) {
    return { scheduled:false, errorCode:error?.code || 'IDLEPROOF_AUTO_DEBT_SCHEDULE_FAILED', message:String(error?.message || error).slice(0, 300) };
  }
}

function gitRoot(cwd) {
  const result = run('git', ['rev-parse', '--show-toplevel'], { cwd, timeout:10000 });
  if (result.status !== 0) throw autoDebtError('IDLEPROOF_AUTO_DEBT_NOT_GIT', 'The project is no longer a Git repository.');
  return path.resolve(result.stdout.trim());
}

// A commit object whose tree is the frozen tree: the recorded commit when it still names that tree,
// otherwise an unreachable commit built from the tree with fixed metadata. Null if the tree is gone.
function referenceCommit(root, side) {
  if (side.commit) {
    const tree = run('git', ['rev-parse', '--verify', '--quiet', `${side.commit}^{tree}`], { cwd:root, timeout:10000 });
    if (tree.status === 0 && tree.stdout.trim() === side.tree) return side.commit;
  }
  const type = run('git', ['cat-file', '-t', side.tree], { cwd:root, timeout:10000 });
  if (type.status !== 0 || type.stdout.trim() !== 'tree') return null;
  const commit = run('git', ['commit-tree', side.tree], { cwd:root, timeout:10000, input:'IdleProof automatic debt reference\n', env:{ ...process.env, ...REFERENCE_ENV } });
  const sha = commit.stdout.trim();
  return commit.status === 0 && OBJECT_ID.test(sha) ? sha : null;
}

// The measurement configuration: the Core CLI version and the project's Core configuration file.
function configurationKey(root, dw) {
  const version = run(dw, ['--version'], { cwd:root, timeout:20000 });
  if (version.error) return { ok:false, code:'CORE_UNAVAILABLE', message:String(version.error.message || version.error).slice(0, 300) };
  let settings = '';
  try { settings = fs.readFileSync(path.join(root, '.diffwitness.toml'), 'utf8'); } catch {}
  return { ok:true, key:createHash('sha256').update(`${String(version.stdout).trim()}\n${settings}`).digest('hex').slice(0, 24), core:String(version.stdout).trim().slice(0, 80) };
}

function pruneWork(dir) {
  try {
    const entries = fs.readdirSync(dir).map((name) => ({ name, at:fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const entry of entries.slice(KEPT_WORK_DIRS)) fs.rmSync(path.join(dir, entry.name), { recursive:true, force:true });
  } catch {}
}

function tail(text) { return String(text || '').trim().split(/\r?\n/).slice(-4).join(' | ').slice(0, 400); }

// One job, synchronously: measure, bind, queue the receipt. Never throws; the outcome says what happened.
function measureAndQueue(cwd, config, job) {
  let root;
  try { root = gitRoot(cwd); } catch (error) { return { state:'retry', code:error.code, message:error.message }; }
  const key = configurationKey(root, config.dw);
  if (!key.ok) return { state:'core-unavailable', code:key.code, message:key.message };
  const base = referenceCommit(root, job.base);
  const candidate = referenceCommit(root, job.candidate);
  if (!base || !candidate) return { state:'failed', code:'REFERENCE_UNAVAILABLE', message:`The frozen ${base ? 'candidate' : 'base'} tree of ${job.changeId} is no longer in the repository; measure it manually if its trees can be recovered.` };
  const work = path.join(projectPaths(cwd).autoDebtWork, job.changeId);
  fs.mkdirSync(work, { recursive:true, mode:0o700 });
  const debtFile = path.join(work, 'debt.json');
  const envelopeFile = path.join(work, 'envelope.json');
  fs.rmSync(debtFile, { force:true }); fs.rmSync(envelopeFile, { force:true });
  // --no-record: the Core ledger is left to the manual `dw debt`; the measurement stays repeatable.
  const debt = run(config.dw, ['debt', '--repo', root, '--base', base, '--candidate', candidate, '--json', debtFile, '--no-record', '--ignore-budget'], { cwd:root, timeout:MEASURE_TIMEOUT_MS });
  if (debt.error) return { state:debt.error.code === 'ETIMEDOUT' ? 'retry' : 'core-unavailable', code:debt.error.code === 'ETIMEDOUT' ? 'MEASUREMENT_TIMEOUT' : 'CORE_UNAVAILABLE', message:String(debt.error.message || debt.error).slice(0, 300) };
  if (debt.status !== 0) return { state:'retry', code:'MEASUREMENT_FAILED', message:tail(debt.stderr || debt.stdout) };
  let report;
  try { report = JSON.parse(fs.readFileSync(debtFile, 'utf8')); } catch { return { state:'retry', code:'MEASUREMENT_INVALID', message:'dw debt wrote no readable report.' }; }
  if (!Number.isInteger(report?.report?.summary?.points)) return { state:'retry', code:'MEASUREMENT_INVALID', message:'dw debt reported no point total.' };
  const bound = run(config.dw, ['envelope', '--repo', root, '--base', base, '--candidate', candidate, '--debt', debtFile, '--out', envelopeFile], { cwd:root, timeout:MEASURE_TIMEOUT_MS });
  if (bound.error) return { state:'core-unavailable', code:'CORE_UNAVAILABLE', message:String(bound.error.message || bound.error).slice(0, 300) };
  if (bound.status !== 0) return { state:'retry', code:'ENVELOPE_FAILED', message:tail(bound.stderr || bound.stdout) };
  let envelope;
  try { envelope = JSON.parse(fs.readFileSync(envelopeFile, 'utf8')); } catch { return { state:'retry', code:'ENVELOPE_INVALID', message:'dw envelope wrote no readable envelope.' }; }
  if (envelope?.change_id !== job.changeId) return { state:'failed', code:'REFERENCE_MISMATCH', message:`Core bound the measurement to ${String(envelope?.change_id || 'no change')}, not ${job.changeId}; nothing was sent.` };
  let snapshot;
  try { snapshot = buildAssurancePortalSnapshot(cwd, envelope); }
  catch (error) { return { state:'failed', code:'NOT_CORRELATED', message:String(error?.message || error).slice(0, 300) }; }
  let queued;
  try { queued = queueAssuranceReceipt(cwd, snapshot); }
  catch (error) { return { state:'retry', code:error?.code || 'RECEIPT_QUEUE_FAILED', message:String(error?.message || error).slice(0, 300) }; }
  pruneWork(projectPaths(cwd).autoDebtWork);
  const measured = { configKey:key.key, core:key.core, points:snapshot.assurance.softwareDebt.points, obligations:snapshot.assurance.softwareDebt.obligations, budgetPassed:snapshot.assurance.softwareDebt.budgetPassed };
  if (queued.notRetained) return { state:'done', ...measured, snapshotId:queued.receipt.snapshotId, queueReason:'not-retained' };
  if (queued.queued.reason === 'not-configured') return { state:'waiting', code:'PORTAL_NOT_CONFIGURED', message:'Portal is not configured any more; the measurement is kept and sent once it is.' };
  if (queued.queued.reason === 'queue-full') return { state:'waiting', code:'PORTAL_QUEUE_FULL', message:'The Portal delivery queue is full; the measurement is sent once it drains.' };
  return { state:'done', ...measured, snapshotId:queued.receipt.snapshotId, queueReason:queued.previous ? 'already-sent' : queued.queued.reason || (queued.queued.queued ? 'queued' : null) };
}

const backoff = (attempts) => new Date(Date.now() + Math.min(60 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, attempts - 1))).toISOString();

// Called with the worker lock held: nobody else is measuring, so a job still marked `measuring` was
// left by a worker that died, and is measured again.
function processNextJob(cwd, config, { retryFailed = false } = {}) {
  const job = withJobs(cwd, (state) => {
    for (const item of state.jobs) {
      if (item.state === 'measuring') { item.state = 'pending'; item.interrupted = (item.interrupted || 0) + 1; }
      if (retryFailed && item.state === 'failed') { item.state = 'pending'; item.attempts = 0; item.retryAfter = null; }
    }
    const next = state.jobs.find((item) => item.state === 'pending' && (!item.retryAfter || Date.parse(item.retryAfter) <= Date.now()));
    if (!next) return null;
    next.state = 'measuring';
    next.lastAttemptAt = new Date().toISOString();
    return structuredClone(next);
  });
  if (!job) return null;
  const outcome = measureAndQueue(cwd, config, job);
  withJobs(cwd, (state) => {
    const item = state.jobs.find((entry) => entry.changeId === job.changeId);
    if (!item) return;
    const error = outcome.code ? { code:outcome.code, message:outcome.message ?? null, at:new Date().toISOString() } : null;
    if (outcome.state === 'done') {
      state.jobs = state.jobs.filter((entry) => entry.changeId !== job.changeId);
      state.done = [...state.done.filter((entry) => entry.changeId !== job.changeId), { changeId:job.changeId, configKey:outcome.configKey, core:outcome.core,
        points:outcome.points, obligations:outcome.obligations, budgetPassed:outcome.budgetPassed, snapshotId:outcome.snapshotId, queueReason:outcome.queueReason,
        measuredAt:new Date().toISOString(), attempts:item.attempts + 1 }].slice(-MAX_DONE);
    } else if (outcome.state === 'failed') {
      Object.assign(item, { state:'failed', lastError:error, attempts:item.attempts + 1 });
    } else if (outcome.state === 'retry') {
      const attempts = item.attempts + 1;
      Object.assign(item, { state:attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', lastError:error, attempts, retryAfter:attempts >= MAX_ATTEMPTS ? null : backoff(attempts) });
    } else {
      // Core unavailable or Portal not reachable as a destination: not the measurement's fault, so no
      // attempt is counted; the job waits for the next trigger.
      Object.assign(item, { state:'pending', lastError:error, retryAfter:null });
    }
  });
  return { changeId:job.changeId, ...outcome };
}

// The detached worker (also `idleproof portal auto-debt run`). One job per worker-lock hold, so jobs
// queued meanwhile are taken by the same loop; a second worker finding the lock held just leaves.
export async function runAutoDebtWorker(cwd = process.cwd(), { fetchImpl = globalThis.fetch, timeoutMs = 3000, retryFailed = false, maxJobs = MAX_JOBS } = {}) {
  const config = readAutoDebtConfig(cwd);
  if (!config?.enabled) return { enabled:false, results:[] };
  const results = [];
  let first = true;
  while (results.length < maxJobs) {
    let outcome;
    try {
      outcome = withOwnedLock(projectPaths(cwd).autoDebtWorkerLock, () => processNextJob(cwd, config, { retryFailed:retryFailed && first }), 'IDLEPROOF_AUTO_DEBT_WORKER_BUSY', 'Automatic debt worker');
    } catch (error) {
      if (error?.code === 'IDLEPROOF_AUTO_DEBT_WORKER_BUSY') { results.push({ state:'busy' }); break; }
      throw error;
    }
    first = false;
    if (!outcome) break;
    results.push(outcome);
    // The same unavailable Core or destination would fail every remaining job the same way.
    if (outcome.state === 'core-unavailable' || outcome.state === 'waiting') break;
  }
  // The network is used only now, outside the worker lock, through the existing delivery queue.
  const delivery = results.some((item) => item.state === 'done') ? await flushPortalQueue(cwd, { fetchImpl, timeoutMs }).catch((error) => ({ ok:false, errorCode:error?.code || 'DELIVERY_FAILED' })) : null;
  return { enabled:true, results, delivery };
}

// What happened to each change: never a value that was not measured.
export function autoDebtStatus(cwd = process.cwd(), { probe = true } = {}) {
  const schema = 'idleproof.auto-debt-status.v1';
  let config;
  try { config = readAutoDebtConfig(cwd); } catch (error) { return { schema, enabled:null, errorCode:error.code, message:error.message }; }
  let jobs;
  try { jobs = readJobs(cwd); } catch (error) { return { schema, enabled:Boolean(config?.enabled), dw:config?.dw ?? null, errorCode:error.code, message:error.message }; }
  const core = config && probe ? probeCore(config.dw, cwd) : null;
  const delivery = (snapshotId) => {
    try { return queuedPortalSnapshot(cwd, snapshotId) ? 'awaiting-delivery' : 'delivered'; } catch { return 'unknown'; }
  };
  const changes = [
    ...jobs.jobs.map((job) => ({ changeId:job.changeId, state:job.state === 'pending' ? (job.lastError ? 'retrying' : 'waiting') : job.state, attempts:job.attempts,
      lastError:job.lastError, retryAfter:job.retryAfter, enqueuedAt:job.enqueuedAt })),
    ...jobs.done.slice(-20).map((item) => ({ changeId:item.changeId, state:'measured', delivery:delivery(item.snapshotId), points:item.points, obligations:item.obligations,
      budgetPassed:item.budgetPassed, snapshotId:item.snapshotId, measuredAt:item.measuredAt }))
  ];
  return {
    schema,
    enabled:Boolean(config?.enabled),
    dw:config?.dw ?? null,
    core:core ? (core.ok ? 'available' : core.code) : null,
    counts:{ waiting:jobs.jobs.filter((job) => job.state === 'pending').length, measuring:jobs.jobs.filter((job) => job.state === 'measuring').length,
      failed:jobs.jobs.filter((job) => job.state === 'failed').length, measured:jobs.done.length, skipped:jobs.skippedTotal },
    degraded:jobs.degraded,
    skipped:jobs.skipped.slice(-20),
    changes
  };
}

export const __autoDebtTest = { referenceCommit, configurationKey, measureAndQueue, processNextJob, readJobs, MAX_JOBS, MAX_ATTEMPTS };
