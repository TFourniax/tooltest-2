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
