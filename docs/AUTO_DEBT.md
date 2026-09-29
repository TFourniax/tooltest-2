# Automatic Core debt (ALPHA-AUTO-DEBT)

Once a project is attached to Portal, one explicit command turns automatic debt on for that project:

```bash
idleproof portal auto-debt enable            # finds `dw` on PATH, or: --dw /path/to/dw
```

From then on, each change that IdleProof completes is measured with Core, and the result is sent to
Portal. This covers `idleproof run -- <command>` and the agent hooks. There is no `dw debt`, no
`dw envelope`, no `idleproof portal assurance` and no base/candidate SHA to choose.

## How it works

1. **The hook that completes the change.** It writes one job to `.idleproof/auto-debt-jobs.json`,
   holding the exact references IdleProof froze: the repository, the base tree and the candidate tree.
   Then it starts a detached worker. No measurement and no network happen in the hook.
2. **The worker.**
   1. It builds unreachable commits from those trees, with fixed metadata. It creates no ref, no index
      entry and no user commit, as Core does for its own analytical baselines.
   2. It runs `dw debt --no-record --ignore-budget`, then `dw envelope`, on those commits.
   3. It checks that Core bound the envelope to the same `dwchg_`.
3. **Delivery.** The envelope goes through the same receipt path and the same Portal delivery queue as
   `idleproof portal assurance`: one measurement is one receipt, whichever route sent it.

No project test or proof command is run. The Core debt ledger is not written: `--no-record` keeps each
measurement repeatable. Recording lineages stays a manual `dw debt`.

## States

`idleproof portal auto-debt status [--json]` lists each change:

| State | Meaning |
|---|---|
| `waiting` | Queued, not measured yet. |
| `measuring` | A worker is measuring it. After a crash, the next worker measures it again. |
| `retrying` | The last attempt did not measure it. The reason is shown: `CORE_UNAVAILABLE` (not counted as an attempt), `MEASUREMENT_FAILED`, … |
| `failed` | Five failed measurements, or references that cannot be measured (`REFERENCE_UNAVAILABLE`, `REFERENCE_MISMATCH`, `NOT_CORRELATED`). Nothing was sent. |
| `measured` | Sent to the delivery queue. The status then shows **waiting for Portal delivery** or **delivered**. |

**Not measured (queue full).** When 100 jobs are already waiting, a newly completed change is recorded
as not measured and the status is marked degraded. It is never dropped silently. Measure such changes
manually. A damaged queue file stops the feature with an explicit error; it is never replaced by an
empty one.

## Portal or Core down

- **Portal down.** The measurement is kept in the delivery queue and sent by the next delivery: the next
  completed change, `idleproof portal sync`, or `idleproof portal auto-debt run`. Portal shows *Not
  measured* until then, never zero.
- **Core missing or not answering.** The job waits with `CORE_UNAVAILABLE`. It is measured at the next
  trigger once Core answers.
- **Neither case blocks development.** The hook only writes a small file.

## Manual mode, diagnosis, recalculation

- `idleproof portal auto-debt run [--retry-failed] [--json]` runs the worker by hand.
  `--retry-failed` gives failed jobs another chance.
- `IDLEPROOF_AUTO_DEBT_WORKER=off` makes hooks only queue, and measurement waits for that command.
- The manual path is unchanged: `dw debt` → `dw envelope` → `idleproof portal assurance --envelope FILE`.
  The same measurement of the same change is the same receipt.
- The measurement files of the last 64 changes are kept in `.idleproof/auto-debt/<dwchg_…>/`.
- `idleproof portal auto-debt disable` stops queueing new changes. It keeps the jobs and the history.

## Limits

- **Reference trees.** They are unreachable objects until the change is committed; Git's garbage
  collection keeps them for its grace period. A job whose trees are gone fails with
  `REFERENCE_UNAVAILABLE` and sends nothing.
- **Session history.** Assurance addresses the last 20 changes of an IDE session and the last 30
  sessions. An older change fails with `NOT_CORRELATED` and sends nothing.
- **Measurement configuration.** A change already measured is not measured again automatically, even if
  the Core configuration changes. Use the manual mode to recalculate.
