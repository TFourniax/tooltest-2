# PM-010b macOS qualification blocker

Fresh main e160f5316e840fe8333250eee74a45a36c87d6a0 failed run35848985745,
attempt1, despite final PR35848611783 passing16jobs.15main jobs passed; the
macOS actual-provider job107141888785 failed the settings.yaml canonical
assertion in structure-all-providers-smoke.mjs. Later steps were skipped.
The original log does not identify the unavailable/rejected extraction reason.
A500ms timeout is a hypothesis, not established root cause.

This diagnostic change logs the safe failure reason/elapsed time at the actual
assertion and adds20independent synthetic YAML requests on macOS. Every sample
retains subprocess status/signal/error code/byte lengths, elapsed time, canonical
admission and expected-symbol match. It logs no command, raw source/response or
stderr. The fixed500ms timeout, original assertions and workload stay unchanged.
The diagnostic has qualification:false and cannot replace the failed gate.
No retry/rerun-to-green, threshold relaxation or production runtime change.

Do not treat a subsequent successful diagnostic as proof that the historical
failure is resolved. Portal35's corrected producer pin remains held pending
an evidence-backed resolution and independently qualified provider main.

## Full-pipeline observations

The first 20 direct loader observations all passed on macOS (maximum102.590333ms)
but bypassed the actual source reader. They therefore cannot rule out source
admission failure, nor establish the original process outcome.

An additional fixed diagnostic now runs100fresh synthetic JSON/TOML/YAML sequences,
500calls in total, through the real `extractTaskSignals` entry. It preserves the
original sequence's repeated JSON/TOML reads and fresh YAML read. Every outcome is
retained independently of success. Safe file stat/fstat identity metadata and
subprocess status/signal/error code/byte counts distinguish the source-reader and
provider boundaries. Temporary builtin instrumentation runs only in the diagnostic
process, is restored in finally, and its overhead is included in timings.

No runtime source,500ms timeout, original assertion or gate workload is changed.
There is no retry-until-success, no raw data/path/command/stderr/exception text in
output, and qualification remains false. A complete successful observation set
would still be non-reproduction, not a demonstrated correction of the old failure.

Local instrumentation check: all500missing-command observations retain ENOENT and
the unavailable reason; all500actual optional-Core observations are canonical,
parsed and match the expected provider/symbol (max104.905708ms). Every call retains
four source stat/fstat observations and exactly one500ms-bounded invocation.
Six adapter contract tests pass. These Linux observations do not reproduce or
resolve the historical macOS failure. All local samples are archived losslessly
as base64-encoded gzip JSONL in `evidence/PM_010B_pipeline_*.jsonl.gz.b64`, with
hashes/summary in `PM_010B_pipeline_local.json`. Decode base64, then gzip to inspect
the original records. CI emits one record per log line and preserves the raw
JSONL as the `macos-source-pipeline-observations` artifact.

On head 44a9b508c928ac283308e32b32aaf3bdb99a6fbb, CI 35855627299 passed
all 16 jobs at attempt 1. macOS job 107163290092 recorded all 500 outcomes:
500 canonical/parsed/expected-provider/expected-symbol matches, no timeout,
maximum elapsed 175.836375 ms. All record lines are preserved in
`evidence/PM_010B_pipeline_macos_35855627299.jsonl.gz.b64`; its manifest
identifies the source job, record-byte hash and original Actions artifact ZIP.
The original failure is still not reproduced or explained. This is diagnostic
evidence only; no runtime correction or provider-main qualification follows.

Review findings 4082041348/4082041354 identified diagnostic plumbing defects:
the default bash pipeline could hide a failed Node process behind successful
`tee`, and a diagnostic or upload failure could override a successful original
gate. A shell reproduction preserves exit 0 before and exit 17 after `pipefail`
in `evidence/PM_010B_pipeline_shell_regression.json`. The pipeline now explicitly
enables pipefail; all diagnostic/upload steps use continue-on-error, while an
always-run record retains their original outcome alongside the authoritative
gate's outcome. The original required gate is unchanged. A partial/failed
collection is not a complete observation set or a qualification PASS.
