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
import { acquireOwnedLock, withOwnedLock } from './portal-memory-lock.mjs';
import { flushPortalQueue, pendingPortalSnapshots, queuedPortalSnapshot, readPortalConfig } from './portal-client.mjs';
import { buildAssurancePortalSnapshot, queueAssuranceReceipt } from './portal-assurance.mjs';

const CONFIG_SCHEMA = 'idleproof.auto-debt-config.v1';
const JOBS_SCHEMA = 'idleproof.auto-debt-jobs.v1';
// Jobs still to measure or retrying. Beyond it a completed change is recorded as skipped.
const MAX_JOBS = 100;
// Failed jobs kept listed, apart from the limit above; older ones are counted, never silently lost. Their
// identities are kept without a bound, so a change measured manually later is no longer counted.
const MAX_FAILED = 100;
// Details of the latest measured changes, for the status. The identities of every measured change are
// kept apart, without a bound (about thirty bytes each), so none is ever measured twice.
const MAX_DONE = 200;
// Details of the latest changes recorded as not measured (queue full). Their identities are kept apart,
// without a bound, so each stays counted until it is queued or measured manually.
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

// Windows starts a .cmd/.bat launcher only through cmd.exe, which receives the arguments unescaped. Each
// one is therefore double-quoted, which keeps & | < > ^ ( ) and spaces literal in both cmd.exe parses
// (the command line, then the launcher's %*). The characters quoting cannot protect (" % ! and line
// breaks) are refused: nothing runs in their presence. Any other launcher runs without a shell.
const CMD_UNSAFE = /["%!\r\n\0]/;
function windowsShellLine(command, args) {
  const values = [command, ...args].map(String);
  if (values.some((value) => CMD_UNSAFE.test(value))) return null;
  // Backslashes before the closing quote are doubled so the program does not read an escaped quote.
  return values.map((value) => `"${value.replace(/(\\+)$/, '$1$1')}"`).join(' ');
}

function run(command, args, options = {}) {
  const settings = { encoding:'utf8', windowsHide:true, maxBuffer:8 * 1024 * 1024, ...options };
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) return spawnSync(command, args, settings);
  const line = windowsShellLine(command, args);
  if (!line) {
    const error = autoDebtError('UNSAFE_WINDOWS_ARGUMENT', `The Core launcher ${command} is a .cmd/.bat file, which Windows runs through cmd.exe, and a path given to it contains ", %, ! or a line break, which cmd.exe cannot receive safely; nothing was run. Configure the Core executable instead (\`idleproof portal auto-debt enable --dw <path to dw.exe>\`).`);
    return { status:null, stdout:'', stderr:'', error };
  }
  return spawnSync(line, { ...settings, shell:true });
}

// The Core CLI, probed where it will run: `dw debt` must exist.
function probeCore(dw, cwd) {
  if (!fs.existsSync(dw)) return { ok:false, code:'CORE_UNAVAILABLE', message:`${dw} does not exist.` };
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
  return { schema:JOBS_SCHEMA, jobs:[], done:[], measured:[], skipped:[], skippedIds:[], skippedTotal:0, failedDroppedIds:[], failedDropped:0, degraded:false };
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
  if (value?.schema !== JOBS_SCHEMA || !Array.isArray(value.jobs) || !Array.isArray(value.done) || !Array.isArray(value.skipped)
    || (value.measured !== undefined && !Array.isArray(value.measured)) || (value.skippedIds !== undefined && !Array.isArray(value.skippedIds)) || (value.failedDroppedIds !== undefined && !Array.isArray(value.failedDroppedIds))) {
    throw autoDebtError('IDLEPROOF_AUTO_DEBT_STATE_CORRUPT', `The automatic debt queue ${'.idleproof/auto-debt-jobs.json'} has an unsupported schema; nothing was queued.`);
  }
  const measured = [...new Set([...(value.measured ?? []), ...value.done.map((item) => item.changeId)].filter((id) => CHANGE_ID.test(String(id))))];
  const skippedIds = [...new Set([...(value.skippedIds ?? []), ...value.skipped.map((item) => item?.changeId)].filter((id) => CHANGE_ID.test(String(id))))];
  const failedDroppedIds = [...new Set((value.failedDroppedIds ?? []).filter((id) => CHANGE_ID.test(String(id))))];
  return { ...emptyJobs(), ...value, measured, skippedIds, skippedTotal:skippedIds.length, failedDroppedIds, failedDropped:failedDroppedIds.length,
    degraded:value.degraded === true };
}

// The queue is never written once the project was reset: its lock does not recreate the state directory,
// and a queue whose configuration is gone is neither read nor written.
function withJobs(cwd, fn) {
  const reset = () => autoDebtError('IDLEPROOF_AUTO_DEBT_STATE_RESET', 'The automatic debt configuration is gone (the local state was reset); nothing was queued.');
  try {
    return withOwnedLock(projectPaths(cwd).autoDebtJobsLock, () => {
      if (!fs.existsSync(projectPaths(cwd).autoDebtConfig)) throw reset();
      const jobs = readJobs(cwd);
      const result = fn(jobs);
      atomicJson(projectPaths(cwd).autoDebtJobs, jobs);
      return result;
    }, 'IDLEPROOF_AUTO_DEBT_BUSY', 'Automatic debt queue', { createParent:false });
  } catch (error) {
    if (error?.code === 'ENOENT' && !fs.existsSync(projectPaths(cwd).dir)) throw reset();
    throw error;
  }
}

// A change recorded as not measured (queue full) that is admitted or measured later is no longer reported
// as not measured.
function resolveSkipped(state, changeId) {
  if (!state.skippedIds.includes(changeId)) return;
  state.skippedIds = state.skippedIds.filter((id) => id !== changeId);
  state.skipped = state.skipped.filter((item) => item.changeId !== changeId);
  state.skippedTotal = state.skippedIds.length;
  state.degraded = state.skippedTotal > 0;
}

// A failed job that left the list is no longer counted once its change is queued again or measured manually.
function resolveFailedDropped(state, changeId) {
  if (!state.failedDroppedIds.includes(changeId)) return;
  state.failedDroppedIds = state.failedDroppedIds.filter((id) => id !== changeId);
  state.failedDropped = state.failedDroppedIds.length;
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
    if (state.measured.includes(changeId)) return { queued:false, reason:'already-measured', changeId, pending:state.jobs.length };
    // Failed jobs never run again on their own, so they do not take the place of new changes.
    if (state.jobs.filter((job) => job.state !== 'failed').length >= MAX_JOBS) {
      // The same change presented again (Stop, then SessionEnd) is one not-measured change, even once its
      // details have left the bounded list.
      if (!state.skippedIds.includes(changeId)) state.skippedIds.push(changeId);
      state.skippedTotal = state.skippedIds.length;
      state.degraded = true;
      state.skipped = [...state.skipped.filter((item) => item.changeId !== changeId), { changeId, at:now.toISOString(), base:reference(identity.base), candidate:reference(identity.candidate) }].slice(-MAX_SKIPPED);
      return { queued:false, reason:'queue-full', changeId, pending:state.jobs.length };
    }
    state.jobs.push({ changeId, repository:identity.repository?.fingerprint ?? null, base:reference(identity.base), candidate:reference(identity.candidate),
      enqueuedAt:now.toISOString(), state:'pending', attempts:0, lastError:null, lastAttemptAt:null, retryAfter:null });
    resolveSkipped(state, changeId);
    resolveFailedDropped(state, changeId);
    return { queued:true, changeId, pending:state.jobs.length };
  });
}

// A measurement sent through the manual path (`idleproof portal assurance`) settles the automatic job of
// the same change: it is never measured again automatically, and a not-measured record is resolved. A job
// that a worker is measuring right now is left to it (the same measurement deduplicates).
export function settleWithManualAssurance(cwd, changeId, { snapshotId = null, softwareDebt = null, queueReason = null, source = 'manual' } = {}) {
  if (!CHANGE_ID.test(String(changeId || ''))) return { settled:false, reason:'no-change' };
  if (!readAutoDebtConfig(cwd)) return { settled:false, reason:'not-enabled' };
  return withJobs(cwd, (state) => {
    const job = state.jobs.find((item) => item.changeId === changeId);
    if (job?.state === 'measuring') return { settled:false, reason:'measuring', changeId };
    state.jobs = state.jobs.filter((item) => item.changeId !== changeId);
    resolveSkipped(state, changeId);
    resolveFailedDropped(state, changeId);
    if (!state.measured.includes(changeId)) state.measured.push(changeId);
    if (!state.done.some((item) => item.changeId === changeId)) {
      state.done = [...state.done, { changeId, source:source === 'ide' ? 'ide' : 'manual', points:softwareDebt?.points ?? null, obligations:softwareDebt?.obligations ?? null,
        budgetPassed:softwareDebt?.budgetPassed ?? null, snapshotId, queueReason, measuredAt:new Date().toISOString(), attempts:0 }].slice(-MAX_DONE);
    }
    return { settled:true, changeId, hadJob:Boolean(job) };
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
// A Core that is missing or does not answer is unavailable, not a failed measurement: on Windows a
// missing `.cmd` launcher runs through the shell and fails with an exit status instead of ENOENT.
function configurationKey(root, dw) {
  if (!fs.existsSync(dw)) return { ok:false, code:'CORE_UNAVAILABLE', message:`${dw} does not exist.` };
  const version = run(dw, ['--version'], { cwd:root, timeout:20000 });
  if (version.error || version.status !== 0) return { ok:false, code:'CORE_UNAVAILABLE', message:String(version.error?.message || version.error || tail(version.stderr || version.stdout) || `exit ${version.status}`).slice(0, 300) };
  let settings = '';
  try { settings = fs.readFileSync(path.join(root, '.diffwitness.toml'), 'utf8'); } catch {}
  return { ok:true, key:createHash('sha256').update(`${String(version.stdout).trim()}\n${settings}`).digest('hex').slice(0, 24), core:String(version.stdout).trim().slice(0, 80) };
}

// Keeps the work of every job still in the queue (its kept measurement) and of the latest others.
function pruneWork(cwd) {
  const dir = projectPaths(cwd).autoDebtWork;
  try {
    const queued = new Set(readJobs(cwd).jobs.map((job) => job.changeId));
    const entries = fs.readdirSync(dir).filter((name) => !queued.has(name))
      .map((name) => ({ name, at:fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const entry of entries.slice(KEPT_WORK_DIRS)) fs.rmSync(path.join(dir, entry.name), { recursive:true, force:true });
  } catch {}
}

// Core's envelope for this job, bound to its change and kept before correlation: a correlation that failed
// is retried with it, without running Core again.
function keptEnvelope(file, changeId) {
  try {
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (kept?.changeId !== changeId || kept?.envelope?.change_id !== changeId) return null;
    return kept;
  } catch { return null; }
}

// A measurement already taken for this job and not yet accepted by the delivery queue.
function keptMeasurement(file, changeId) {
  try {
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (kept?.changeId !== changeId || kept?.snapshot?.change?.changeId !== changeId || !kept?.snapshot?.assurance?.softwareDebt) return null;
    return kept;
  } catch { return null; }
}

function tail(text) { return String(text || '').trim().split(/\r?\n/).slice(-4).join(' | ').slice(0, 400); }

// One job, synchronously: measure, bind, queue the receipt. Never throws; the outcome says what happened.
function measureAndQueue(cwd, config, job, { timeoutMs = MEASURE_TIMEOUT_MS } = {}) {
  const work = path.join(projectPaths(cwd).autoDebtWork, job.changeId);
  const keptFile = path.join(work, 'receipt.json');
  // Measured already (the delivery queue refused it: Portal not configured, or full): only queue it again.
  const kept = keptMeasurement(keptFile, job.changeId);
  if (kept) return queueMeasurement(cwd, job, kept);
  const boundFile = path.join(work, 'bound.json');
  // Measured and bound already, but not correlated yet (the change was not in the session history): only
  // correlate it again.
  const keptBound = keptEnvelope(boundFile, job.changeId);
  if (keptBound) return correlateAndQueue(cwd, job, keptBound, keptFile);
  let root;
  try { root = gitRoot(cwd); } catch (error) { return { state:'retry', code:error.code, message:error.message }; }
  const key = configurationKey(root, config.dw);
  if (!key.ok) return { state:'core-unavailable', code:key.code, message:key.message };
  const base = referenceCommit(root, job.base);
  const candidate = referenceCommit(root, job.candidate);
  if (!base || !candidate) return { state:'failed', code:'REFERENCE_UNAVAILABLE', message:`The frozen ${base ? 'candidate' : 'base'} tree of ${job.changeId} is no longer in the repository; measure it manually if its trees can be recovered.` };
  fs.mkdirSync(work, { recursive:true, mode:0o700 });
  const debtFile = path.join(work, 'debt.json');
  const envelopeFile = path.join(work, 'envelope.json');
  fs.rmSync(debtFile, { force:true }); fs.rmSync(envelopeFile, { force:true });
  // --no-record: the Core ledger is left to the manual `dw debt`; the measurement stays repeatable.
  const debt = run(config.dw, ['debt', '--repo', root, '--base', base, '--candidate', candidate, '--json', debtFile, '--no-record', '--ignore-budget'], { cwd:root, timeout:timeoutMs });
  if (debt.error?.code === 'UNSAFE_WINDOWS_ARGUMENT') return { state:'failed', code:debt.error.code, message:debt.error.message };
  if (debt.error) return { state:debt.error.code === 'ETIMEDOUT' ? 'retry' : 'core-unavailable', code:debt.error.code === 'ETIMEDOUT' ? 'MEASUREMENT_TIMEOUT' : 'CORE_UNAVAILABLE', message:String(debt.error.message || debt.error).slice(0, 300) };
  if (debt.status !== 0) return { state:'retry', code:'MEASUREMENT_FAILED', message:tail(debt.stderr || debt.stdout) };
  let report;
  try { report = JSON.parse(fs.readFileSync(debtFile, 'utf8')); } catch { return { state:'retry', code:'MEASUREMENT_INVALID', message:'dw debt wrote no readable report.' }; }
  if (!Number.isInteger(report?.report?.summary?.points)) return { state:'retry', code:'MEASUREMENT_INVALID', message:'dw debt reported no point total.' };
  const bound = run(config.dw, ['envelope', '--repo', root, '--base', base, '--candidate', candidate, '--debt', debtFile, '--out', envelopeFile], { cwd:root, timeout:timeoutMs });
  if (bound.error?.code === 'UNSAFE_WINDOWS_ARGUMENT') return { state:'failed', code:bound.error.code, message:bound.error.message };
  // A Core that answered `dw debt` and then runs out of time binding the envelope failed this measurement:
  // it counts as an attempt, as a `dw debt` timeout does, so it reaches the failed state.
  if (bound.error) return { state:bound.error.code === 'ETIMEDOUT' ? 'retry' : 'core-unavailable', code:bound.error.code === 'ETIMEDOUT' ? 'ENVELOPE_TIMEOUT' : 'CORE_UNAVAILABLE', message:String(bound.error.message || bound.error).slice(0, 300) };
  if (bound.status !== 0) return { state:'retry', code:'ENVELOPE_FAILED', message:tail(bound.stderr || bound.stdout) };
  let envelope;
  try { envelope = JSON.parse(fs.readFileSync(envelopeFile, 'utf8')); } catch { return { state:'retry', code:'ENVELOPE_INVALID', message:'dw envelope wrote no readable envelope.' }; }
  if (envelope?.change_id !== job.changeId) return { state:'failed', code:'REFERENCE_MISMATCH', message:`Core bound the measurement to ${String(envelope?.change_id || 'no change')}, not ${job.changeId}; nothing was sent.` };
  // Kept before correlation: if the change cannot be correlated now, a retry uses this envelope, never a new
  // measurement.
  const measuredEnvelope = { changeId:job.changeId, configKey:key.key, core:key.core, envelope };
  try { atomicJson(boundFile, measuredEnvelope); }
  catch (error) { return { state:'retry', code:'MEASUREMENT_NOT_KEPT', message:String(error?.message || error).slice(0, 300) }; }
  return correlateAndQueue(cwd, job, measuredEnvelope, keptFile);
}

// Every outcome here follows a Core measurement that is kept, so `measurementTaken` records the change as
// measured: it is never measured again automatically.
function correlateAndQueue(cwd, job, { configKey, core, envelope }, keptFile) {
  let snapshot;
  try { snapshot = buildAssurancePortalSnapshot(cwd, envelope); }
  catch (error) { return { state:'failed', code:'NOT_CORRELATED', message:String(error?.message || error).slice(0, 300), measurementTaken:true }; }
  // Kept before queueing: if the queue refuses it, the next attempt sends this measurement, never a new one.
  const measurement = { changeId:job.changeId, configKey, core, snapshot };
  try { atomicJson(keptFile, measurement); }
  catch (error) { return { state:'retry', code:'MEASUREMENT_NOT_KEPT', message:String(error?.message || error).slice(0, 300), measurementTaken:true }; }
  return queueMeasurement(cwd, job, measurement);
}

// Every outcome here follows a Core measurement: `measurementTaken` records the change as measured, so it is
// never measured again, even if its job later fails and leaves the list.
function queueMeasurement(cwd, job, measurement) {
  return { ...queueKeptMeasurement(cwd, job, measurement), measurementTaken:true };
}

function queueKeptMeasurement(cwd, job, { configKey, core, snapshot }) {
  let queued;
  // The measurement is kept beside its job: a full queue is a wait, not a lost receipt.
  try { queued = queueAssuranceReceipt(cwd, snapshot, { retainedByCaller:true }); }
  catch (error) { return { state:'retry', code:error?.code || 'RECEIPT_QUEUE_FAILED', message:String(error?.message || error).slice(0, 300) }; }
  pruneWork(cwd);
  const measured = { configKey, core, points:snapshot.assurance.softwareDebt.points, obligations:snapshot.assurance.softwareDebt.obligations, budgetPassed:snapshot.assurance.softwareDebt.budgetPassed };
  // The same measurement was queued for Portal long ago and its body is no longer kept: it can be neither
  // resent nor confirmed, so it is never reported delivered.
  if (queued.notRetained) return { state:'failed', code:'IDLEPROOF_ASSURANCE_NOT_RETAINED', message:`This measurement of ${job.changeId} was queued for Portal long ago and its receipt is no longer kept locally, so it can be neither resent nor confirmed; nothing was sent.` };
  if (queued.queued.reason === 'not-configured') return { state:'waiting', code:'PORTAL_NOT_CONFIGURED', message:'Portal is not configured any more; the measurement is kept and sent once it is.' };
  if (queued.queued.reason === 'queue-full') return { state:'waiting', code:'PORTAL_QUEUE_FULL', message:'The Portal delivery queue is full; the measurement is sent once it drains.' };
  return { state:'done', ...measured, snapshotId:queued.receipt.snapshotId, queueReason:queued.previous ? 'already-sent' : queued.queued.reason || (queued.queued.queued ? 'queued' : null) };
}

// Only the latest failed jobs stay listed; the older ones are counted in the status.
function boundFailed(state) {
  const failed = state.jobs.filter((job) => job.state === 'failed');
  if (failed.length <= MAX_FAILED) return;
  // By the time they failed, not the order they were queued: a job that fails late, after its backoff, is
  // among the latest failures.
  const failedAt = (job) => Date.parse(job.lastError?.at ?? job.lastAttemptAt ?? job.enqueuedAt) || 0;
  const oldest = [...failed].sort((a, b) => failedAt(a) - failedAt(b)).slice(0, failed.length - MAX_FAILED);
  const dropped = new Set(oldest.map((job) => job.changeId));
  state.jobs = state.jobs.filter((job) => !dropped.has(job.changeId));
  state.failedDroppedIds = [...new Set([...state.failedDroppedIds, ...dropped])];
  state.failedDropped = state.failedDroppedIds.length;
}

const stillEnabled = (cwd) => { try { return readAutoDebtConfig(cwd)?.enabled === true; } catch { return false; } };
// A job the worker would take now (a job left `measuring` is one a worker that died left behind).
const dueJobWaiting = (cwd) => {
  try { return readJobs(cwd).jobs.some((job) => job.state === 'measuring' || (job.state === 'pending' && (!job.retryAfter || Date.parse(job.retryAfter) <= Date.now()))); }
  catch { return false; }
};

const backoff = (attempts) => new Date(Date.now() + Math.min(60 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, attempts - 1))).toISOString();

// Called with the worker lock held: nobody else is measuring, so a job still marked `measuring` was
// left by a worker that died, and is measured again.
// `retry` holds the failed jobs an explicit `--retry-failed` may still take: only the one selected is reset,
// so the others stay failed if this run stops early.
function processNextJob(cwd, config, { retry = null, measureTimeoutMs = MEASURE_TIMEOUT_MS } = {}) {
  // The lock may have been taken right after a reset moved the local state: nothing is written then.
  if (!stillEnabled(cwd)) return null;
  const job = withJobs(cwd, (state) => {
    for (const item of state.jobs) {
      if (item.state === 'measuring') { item.state = 'pending'; item.interrupted = (item.interrupted || 0) + 1; }
    }
    let next = state.jobs.find((item) => item.state === 'pending' && (!item.retryAfter || Date.parse(item.retryAfter) <= Date.now()));
    if (!next && retry) {
      next = state.jobs.find((item) => item.state === 'failed' && retry.has(item.changeId));
      if (next) { retry.delete(next.changeId); Object.assign(next, { attempts:0, retryAfter:null }); }
    }
    if (!next) return null;
    next.state = 'measuring';
    next.lastAttemptAt = new Date().toISOString();
    return structuredClone(next);
  });
  if (!job) return null;
  const outcome = measureAndQueue(cwd, config, job, { timeoutMs:measureTimeoutMs });
  withJobs(cwd, (state) => {
    const item = state.jobs.find((entry) => entry.changeId === job.changeId);
    if (!item) return;
    const error = outcome.code ? { code:outcome.code, message:outcome.message ?? null, at:new Date().toISOString() } : null;
    if (outcome.measurementTaken && !state.measured.includes(job.changeId)) state.measured.push(job.changeId);
    if (outcome.state === 'done') {
      state.jobs = state.jobs.filter((entry) => entry.changeId !== job.changeId);
      state.done = [...state.done.filter((entry) => entry.changeId !== job.changeId), { changeId:job.changeId, configKey:outcome.configKey, core:outcome.core,
        points:outcome.points, obligations:outcome.obligations, budgetPassed:outcome.budgetPassed, snapshotId:outcome.snapshotId, queueReason:outcome.queueReason,
        measuredAt:new Date().toISOString(), attempts:item.attempts + 1 }].slice(-MAX_DONE);
      if (!state.measured.includes(job.changeId)) state.measured.push(job.changeId);
    } else if (outcome.state === 'failed') {
      Object.assign(item, { state:'failed', lastError:error, attempts:item.attempts + 1 });
      boundFailed(state);
    } else if (outcome.state === 'retry') {
      const attempts = item.attempts + 1;
      Object.assign(item, { state:attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', lastError:error, attempts, retryAfter:attempts >= MAX_ATTEMPTS ? null : backoff(attempts) });
      boundFailed(state);
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
export async function runAutoDebtWorker(cwd = process.cwd(), { fetchImpl = globalThis.fetch, timeoutMs = 3000, retryFailed = false, maxJobs = MAX_JOBS, measureTimeoutMs = MEASURE_TIMEOUT_MS, deliverQueued = false } = {}) {
  const config = readAutoDebtConfig(cwd);
  if (!config?.enabled) return { enabled:false, results:[] };
  const results = [];
  // The worker lock is never allowed to recreate the state directory: after a reset it is gone, and the
  // worker stops instead of writing outside the archive.
  const lockFile = projectPaths(cwd).autoDebtWorkerLock;
  const lockArgs = ['IDLEPROOF_AUTO_DEBT_WORKER_BUSY', 'Automatic debt worker', { createParent:false }];
  // Deliveries hold the worker lock too, so `idleproof reset` never moves the state while a flush can still
  // write to it.
  const flush = async () => {
    let release;
    try { release = acquireOwnedLock(lockFile, ...lockArgs); }
    catch (error) { return { ok:false, errorCode:error?.code === 'ENOENT' ? 'IDLEPROOF_AUTO_DEBT_STATE_RESET' : error?.code || 'DELIVERY_FAILED' }; }
    try {
      if (!fs.existsSync(projectPaths(cwd).autoDebtConfig)) return { ok:false, errorCode:'IDLEPROOF_AUTO_DEBT_STATE_RESET' };
      return await flushPortalQueue(cwd, { fetchImpl, timeoutMs });
    } catch (error) { return { ok:false, errorCode:error?.code || 'DELIVERY_FAILED' }; }
    finally { release(); }
  };
  let retry = null;
  if (retryFailed) { try { retry = new Set(readJobs(cwd).jobs.filter((job) => job.state === 'failed').map((job) => job.changeId)); } catch { retry = null; } }
  let delivery = null;
  let drained = false;
  let taken = 0;
  // Busy, reset, disabled, or Core or the destination unavailable: no more jobs in this run.
  let stopped = false;
  const takeJobs = async () => {
    while (taken < maxJobs) {
      if (!stillEnabled(cwd)) { stopped = true; return; }
      let outcome;
      try {
        outcome = withOwnedLock(lockFile, () => processNextJob(cwd, config, { retry, measureTimeoutMs }), ...lockArgs);
      } catch (error) {
        if (error?.code === 'IDLEPROOF_AUTO_DEBT_WORKER_BUSY') { results.push({ state:'busy' }); stopped = true; return; }
        // The local state was reset: its directory is gone.
        if (error?.code === 'ENOENT') { stopped = true; return; }
        throw error;
      }
      if (!outcome) return;
      results.push(outcome);
      // A full delivery queue is sent once; the kept measurement is then queued again in this run if the
      // queue drained, or left waiting for the next run. That second attempt of the same job is not charged
      // to the run's job budget.
      if (outcome.code === 'PORTAL_QUEUE_FULL' && !drained) {
        drained = true;
        delivery = await flush();
        if (delivery.ok) continue;
      }
      taken += 1;
      // The same unavailable Core or destination would fail every remaining job the same way.
      if (outcome.state === 'core-unavailable' || outcome.state === 'waiting') { stopped = true; return; }
    }
  };
  // With `deliverQueued` (the `auto-debt run` command), receipts queued earlier and not delivered yet (Portal
  // was offline) are sent too, even when this run measured nothing. An unreadable queue is flushed as well,
  // so the delivery reports why (IDLEPROOF_PORTAL_QUEUE_CORRUPT) instead of passing for an empty queue.
  const receiptsWaiting = () => { try { return pendingPortalSnapshots(cwd) > 0; } catch { return true; } };
  for (let pass = 0; ; pass += 1) {
    const before = results.length;
    await takeJobs();
    if (results.slice(before).some((item) => item.state === 'done') || (pass === 0 && deliverQueued && receiptsWaiting())) delivery = await flush();
    // A change completed during that delivery found the lock held, and the worker started for it left:
    // this worker takes it.
    if (stopped || taken >= maxJobs || pass >= maxJobs || !dueJobWaiting(cwd)) break;
  }
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
    ...jobs.done.slice(-20).map((item) => ({ changeId:item.changeId, state:'measured', source:['manual', 'ide'].includes(item.source) ? item.source : 'automatic', delivery:delivery(item.snapshotId), points:item.points, obligations:item.obligations,
      budgetPassed:item.budgetPassed, snapshotId:item.snapshotId, measuredAt:item.measuredAt }))
  ];
  return {
    schema,
    enabled:Boolean(config?.enabled),
    dw:config?.dw ?? null,
    core:core ? (core.ok ? 'available' : core.code) : null,
    counts:{ waiting:jobs.jobs.filter((job) => job.state === 'pending').length, measuring:jobs.jobs.filter((job) => job.state === 'measuring').length,
      failed:jobs.jobs.filter((job) => job.state === 'failed').length, failedNoLongerListed:jobs.failedDropped, measured:jobs.measured.length, skipped:jobs.skippedTotal },
    degraded:jobs.degraded,
    skipped:jobs.skipped.slice(-20),
    changes
  };
}

export const __autoDebtTest = { referenceCommit, configurationKey, measureAndQueue, processNextJob, readJobs, withJobs, windowsShellLine, MAX_JOBS, MAX_FAILED, MAX_DONE, MAX_SKIPPED, MAX_ATTEMPTS };
