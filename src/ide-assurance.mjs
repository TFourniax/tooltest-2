import fs from 'node:fs';
import path from 'node:path';
import { acceptedByPortalQueue, buildAssurancePortalSnapshot, queueAssuranceReceipt } from './portal-assurance.mjs';
import { keepNativeMeasurement, settleWithManualAssurance } from './auto-debt.mjs';
import { schedulePortalSync } from './portal-client.mjs';

function envelopePath(cwd) {
  return path.join(cwd, '.git', 'diffwitness', 'change-envelope.json');
}

// Kept for the automatic job of this change, which sends it later if the Portal queue refuses it, instead of
// measuring the change again, then queued for Portal in the same automatic debt queue-lock hold, so a reset
// never falls between the two. A receipt its job retains is not lost if the Portal queue is full, so the
// queue does not count it as a skipped snapshot. Keeping is fail-open: without it, the receipt is queued as
// before.
function keepAndQueue(cwd, snapshot, identity) {
  const queue = (retainedByCaller) => queueAssuranceReceipt(cwd, snapshot, { retainedByCaller });
  let held;
  try { held = keepNativeMeasurement(cwd, snapshot, { identity, queue }); }
  catch (error) { held = { kept:false, errorCode:error?.code || 'IDLEPROOF_AUTO_DEBT_KEEP_FAILED' }; }
  const { queued, ...kept } = held;
  return { kept, queue:() => {
    if (!queued) return queue(false);
    if (queued.error) throw queued.error;
    return queued.value;
  } };
}

// `autoDebtIdentity`: the identity of the completion that the native Stop accepted. It lets this receipt admit
// that change's automatic job; without it, the receipt is kept only for a job already queued.
export function queueMatchingDiffWitnessAssurance(cwd = process.cwd(), { autoDebtIdentity = null } = {}) {
  const file = envelopePath(cwd);
  if (!fs.existsSync(file)) return { matched:false, reason:'no-envelope' };
  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { matched:false, reason:'invalid-envelope' };
  }

  let snapshot;
  try {
    // buildAssurancePortalSnapshot enforces the exact completed IdleProof dwchg_ identity. A stale
    // or foreign envelope therefore cannot be attached merely because it exists in .git/.
    snapshot = buildAssurancePortalSnapshot(cwd, envelope);
  } catch {
    return { matched:false, reason:'change-mismatch' };
  }

  const { kept, queue } = keepAndQueue(cwd, snapshot, autoDebtIdentity);
  try {
    const { receipt, queued } = queue();
    snapshot = receipt;
    if (queued.reason === 'not-configured') {
      return { matched:true, queued:false, configured:false, snapshotId:snapshot.snapshotId, changeId:snapshot.change.changeId, kept };
    }
    // processHookLifecycle already schedules the normal receipt. A second idempotent background
    // flush is cheap and closes either hook ordering: DiffWitness-first or IdleProof-first.
    const delivery = queued.queued ? schedulePortalSync(cwd) : { scheduled:false, reason:queued.reason || 'already-retained' };
    // Held by the current Portal queue: the automatic debt job of this change is settled, so Core does not
    // measure it again. Fail-open, like the rest of this path.
    let autoDebt = null;
    if (acceptedByPortalQueue(queued)) {
      try {
        autoDebt = settleWithManualAssurance(cwd, snapshot.change.changeId, { snapshotId:snapshot.snapshotId, softwareDebt:snapshot.assurance?.softwareDebt ?? null,
          queueReason:queued.queued ? 'queued' : queued.reason, source:'ide' });
      } catch (error) { autoDebt = { settled:false, errorCode:error?.code || 'IDLEPROOF_AUTO_DEBT_SETTLE_FAILED' }; }
    }
    return {
      matched:true,
      configured:true,
      queued:Boolean(queued.queued),
      snapshotId:snapshot.snapshotId,
      changeId:snapshot.change.changeId,
      delivery,
      autoDebt,
      kept
    };
  } catch (error) {
    // Portal is fail-open for coding. Proof/Debt authority remains in the local envelope and the
    // hook must not block a valid coding task because optional cloud delivery is unavailable.
    return { matched:true, queued:false, configured:null, errorCode:error?.code || 'ASSURANCE_QUEUE_FAILED', kept };
  }
}
