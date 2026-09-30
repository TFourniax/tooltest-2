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

`idleproof portal auto-debt status [--json]` lists each change. Changes still waiting, retrying or failed come first, with their reason; the latest measured changes fill the rest:

| State | Meaning |
|---|---|
| `waiting` | Queued, not measured yet. |
| `measuring` | A worker is measuring it. After a crash, the next worker measures it again. |
| `retrying` | The last attempt did not measure it. The reason is shown: `CORE_UNAVAILABLE` (not counted as an attempt), `MEASUREMENT_FAILED`, `MEASUREMENT_TIMEOUT` or `ENVELOPE_TIMEOUT` (a Core command ran out of its ten minutes), … |
| `failed` | One of three causes, each shown with its reason: five failed measurements; references that cannot be measured (`REFERENCE_UNAVAILABLE`, `REFERENCE_MISMATCH`, `NOT_CORRELATED`); or the same measurement queued for Portal long ago whose receipt is no longer kept locally (`IDLEPROOF_ASSURANCE_NOT_RETAINED`), so it can be neither resent nor confirmed. Nothing was sent. |
| `measured` | Sent to the delivery queue. The status then shows **waiting for Portal delivery** or **delivered**. |

**Not measured (queue full).** When 100 jobs are already waiting or retrying, a newly completed change
is recorded as not measured and the status is marked degraded. It is never dropped silently. Measure
such changes manually. Each one stays counted until it is queued later or measured manually; the latest
200 are listed with their references in `auto-debt status --json`. Failed jobs do not count toward this limit. The latest 100 failed jobs stay
listed with their reason, and older ones are counted in the status as no longer listed, until their
change is queued again or measured manually. A damaged queue
file stops the feature with an explicit error; it is never replaced by an empty one.

**A measurement is taken once.** Before it is queued for Portal, the finished measurement is saved
beside its job. If the delivery queue refuses it (Portal no longer configured, or its queue full), the
job waits, and the next attempt queues that same measurement. Core is not run again. A full delivery
queue is sent by the worker itself, and the measurement is queued in the same run once the queue drains.
A change Core has measured counts as measured even if its job later fails, so it is never measured
again automatically.

## Portal or Core down

- **Portal down.** The measurement is kept in the delivery queue and sent by the next delivery: the next
  completed change, `idleproof portal sync`, or `idleproof portal auto-debt run`. Portal shows *Not
  measured* until then, never zero.
- **Core missing or not answering.** The job waits with `CORE_UNAVAILABLE`. It is measured at the next
  trigger once Core answers. A Core that answers but runs out of time measuring the change counts as a
  failed attempt, so the job ends `failed` after five of them.
- **Neither case blocks development.** The hook only writes a small file.

## Manual mode, diagnosis, recalculation

- `idleproof portal auto-debt run [--retry-failed] [--json]` runs the worker by hand.
  `--retry-failed` gives each failed job one more attempt during this run. A failed job it does not
  reach, for example because Core is unavailable, stays failed.
- `IDLEPROOF_AUTO_DEBT_WORKER=off` makes hooks only queue, and measurement waits for that command.
- The manual path is unchanged: `dw debt` → `dw envelope` → `idleproof portal assurance --envelope FILE`.
  The same measurement of the same change is the same receipt. A manual assurance that the current Portal
  delivery queue accepts (queued now, already queued, or already held by Portal) settles the automatic job
  of that change, which is then never measured again automatically; the status
  shows it as *measured manually*. A job a worker is measuring at that moment is left to the worker.
- A change recorded as not measured (queue full) is no longer reported so once it is queued later or
  measured manually.
- The measurement files of the last 64 changes are kept in `.idleproof/auto-debt/<dwchg_…>/`.
- `idleproof portal auto-debt disable` stops queueing new changes. It keeps the jobs and the history.

## Limits

- **Reference trees.** They are unreachable objects until the change is committed; Git's garbage
  collection keeps them for its grace period. A job whose trees are gone fails with
  `REFERENCE_UNAVAILABLE` and sends nothing.
- **Session history.** Assurance addresses the last 20 changes of an IDE session and the last 30
  sessions. An older change fails with `NOT_CORRELATED` and sends nothing. Core's envelope is kept beside
  the job, so `auto-debt run --retry-failed` correlates it again without measuring the change again.
- **Measurement configuration.** A change already measured is not measured again automatically, even if
  the Core configuration changes. Use the manual mode to recalculate.
- **Windows `.cmd`/`.bat` Core launchers.** Windows runs them through `cmd.exe`. IdleProof quotes every
  argument, but it refuses paths holding `"`, `%`, `!` or a line break (`UNSAFE_WINDOWS_ARGUMENT`), and
  nothing runs. The `dw.exe` that pip installs runs without a shell and has no such limit.
