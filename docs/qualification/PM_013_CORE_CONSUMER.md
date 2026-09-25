# PM-013 follow-up — Core consumer after a failed extraction

Bounded lot: explain the IdleProof main failure recorded after PM-013 (#23), correct what it
revealed, and qualify the IdleProof consumer with the Core of the PM-013 version set. No new
feature. MACHINE evidence only; no HUMAN, release or ALPHA READY claim.

## Starting state (kept, not rewritten)

- IdleProof main `d8e7c9bd8e50fb1aa87800655a63761214c16c1f` (#23), run `36148651667`: **17/18**.
  Job `108116054851`, `real Core context consumer (windows-latest)`, failed.
- IdleProof local suite at `d8e7c9b` with the real Core installed: **344/345**. Test 26,
  `extracts Rust symbol and crate dependency without pretending std is external`, failed.
  The same suite without Core (the CI `test` job) was 345/345.
- Core main `a168829247df8e6604cf47f327be9acd3f57e155` (tree `87d5e437…`, identical to #130 head
  `01288e4`): `test` 36058833701, `proofbench` 36058833684, `continuitybench` 36058833708 and
  `integrated-product-smoke` 36058833775 all SUCCESS.

## 1. The Windows failure: facts

Source: complete job log (1,041 lines), excerpt in
`evidence/PM_013C_windows_incident_108116054851.json`.

- **What ran:**
  - IdleProof `d8e7c9b`.
  - Core **`fbebc797968014600c1b89aed603984e15f78d5c`** (#117), the pin of this job. It is not
    Core main: `fbebc79` is 80 commits behind `a168829`.
  - Python 3.12.10, Node v22.23.2, runner image win25-vs2026 20260922.246.
  - `diffwitness-0.4.0a1` with tree-sitter 0.25.2; grammars typescript 0.23.2, javascript
    0.25.0, go 0.25.0 and rust 0.24.2.
- **Failed step:** `Verify actual JS/TS/Go/Rust task context`, `node scripts/structure-languages-smoke.mjs`.
  - The grammars had been installed about one second earlier.
  - The first extraction ran the 4-file request `dw state extract --json` with a 500 ms deadline.
    Result: `core-extraction-unavailable`, stage `process`, 509.8 ms, `ETIMEDOUT`, `SIGTERM`,
    0 bytes on stdout and stderr.
- **Assertion:** `structure-languages-smoke.mjs:21`, `first.symbol`. Expected `actual`, got
  `invented`.
- **Non-qualifying diagnostic, on the same runner right after the gate:** 400 calls on the same
  fixtures, 0 failures. Medians were about 103 ms per fixture and the maximum 196 ms.
- **Earlier occurrences:** the same first call failed on 2026-09-23 (run 35927891752) and in run
  35936695431 (709 ms, `ETIMEDOUT`). See `PM_010B_MACOS_BLOCKER.md` and `PROVIDER_FAILURE.md`.

**Demonstrated:** this invocation exceeded its 500 ms deadline. `invented` is a quoted decoy in the
fixture, and it became the task symbol because of IdleProof's fallback path (section 2).

**Not demonstrated:** why the first call on Windows is slow. Local Linux measurements do not
reproduce it: 95 ms for the first call after a fresh install, 84–104 ms afterwards. They do not
explain Windows. The hypotheses stay open:
1. the first load of freshly installed native grammar modules by Windows;
2. the first scan of installed package metadata (`importlib.metadata.version` is called twice per
   file by Core);
3. runner contention.

The new non-qualifying job `Core first-extraction phases (<os>, diagnostic, non-qualifying)`
measures the first extraction after three fresh installs, split by phase, on every OS. It runs in
its own job, never before the gate, so it cannot warm it up.

## 2. Product defect: fallback facts after a failed extraction (reproduced, fixed)

Deterministic reproduction at `d8e7c9b` (`evidence/PM_013C_fallback_before.jsonl`):
- **Faults injected:** timeout, non-zero exit, invalid output and a missing executable.
- **Fixture:** TS and Rust files whose decoy declaration sits in a string literal and in a comment.
- **Result:** `symbol: "invented"`, `symbols: ["invented","actual"]`,
  `structureCoverage.provider: "legacy-heuristic"`.
- **Presentation:**
  - the explanation stated *"the observed symbol is `invented`"* with certainty
    `observed-plus-inferred`;
  - the delivery key and the Portal snapshot task summary ("Work around invented in …") carried it.

Cause: for a language that has a canonical provider, a failed or rejected extraction fell back to
text regexes. They cannot tell a declaration from one quoted in a string, so an absent symbol was
presented as observed.

Correction (`src/context.mjs`, `src/explain.mjs`):
- **Supported language whose provider is unavailable or rejected:** no structural facts.
  `symbol: null`, `symbols: []`, `dependencies: []`, `importReferences: []`.
  `structureCoverage` is `{provider: "unavailable", canonical: false, parsed: null, reason}`, with
  the source hash. Routes, tables and technologies keep their existing inference, which is the same
  on the nominal path.
- **Other distinctions preserved:**
  - valid parsed extraction: canonical facts;
  - valid canonical response that is not parsed (grammar absent, invalid syntax):
    `canonical: true, parsed: false`, no facts;
  - language without a provider: the labelled `legacy-heuristic` fallback (`language-adapter-pending`)
    is kept.
- **Explanation wording:**
  - canonical symbols are "observed";
  - a heuristic symbol is "a text-matched symbol candidate (not parsed)", with certainty
    `bounded-inference`.
- **Cache:** results are keyed by source bytes and extraction result. A failure never reuses an
  earlier extraction, and recovery returns fresh facts.

This supersedes, for supported languages only, the PM-004E rule "timeouts retain the existing
heuristic fallback": that fallback is what produced the absent symbol.

Regressions: `test/context-degraded-extraction.test.mjs`, 6 tests.
- **Coverage:** four process failure modes plus a response bound to other bytes; five languages;
  string and comment decoys; explanation and snapshot; recovery then renewed failure; edited bytes;
  an unparsed response; an unsupported language.
- **Before and after:** with only the fallback reverted, 4 of the 6 fail. They cover the failure
  modes, the response bound to other bytes, recovery and the candidate wording. The nominal-path
  and unparsed-response tests pass before and after, since they check preserved behaviour. After
  the fix, 6/6 pass.
- **After-fix evidence:** `evidence/PM_013C_fallback_after.jsonl`.

## 3. Rust test 26 (cause demonstrated)

- **Without Core:** the test was satisfied by the regex fallback (`use mystery_bus::` gave
  `mystery_bus`).
- **With the real Core and the Rust grammar:** the canonical import target is `mystery_bus::Client`.
  The existing real-Core contract keeps full external targets (`structure-dependencies-smoke.mjs`
  asserts `serde::Serialize`), so `includes('mystery_bus')` failed.

The test was not hermetic: its result depended on whether Core happened to be installed. The unit
cases that relied on this implicit mode now declare canonical facts through a deterministic
provider double (`test/support/canonical-core.mjs`). They keep their positive assertions and go
through the full consumer admission path. For Rust, the expected dependency is the canonical target
`mystery_bus::Client`, and `std` stays excluded.

Complete mode with the real Core: the exact case is added to `structure-dependencies-smoke.mjs`
(provider `tree-sitter-rust`, parsed, symbol `drain_pending_jobs`, dependency
`mystery_bus::Client`). Minimal mode, without grammars, keeps its explicit absence
(`structure-languages-smoke.mjs --without-grammars`: `parsed: false`, no symbol).

## 4. `explain-torturebench` (failure found, cause demonstrated)

The CI quality job runs without Core. Run locally at `d8e7c9b` with the real Core, the bench fails:
**150/234** live symbols against a required 210.

The fixtures prefixed code with notes that are not comments in their language:
- `#` in TypeScript, JavaScript, Go, Rust, Java, Kotlin and C#;
- `//` and `/* */` in Python and Ruby;
- text before `<?php`.

A parser correctly leaves such invalid files unparsed. Separately, tree-sitter-kotlin 1.1.0
rejects a valid one-line class body with an expression member (`MISSING _class_member_semi`);
Core then reports it unparsed, as its contract requires.

Correction: identical misleading text, written as a real comment in each language, and one member
per line for Kotlin. Threshold and assertions are unchanged. The bench now runs with Core main
`a168829` in the quality job, and it alone is given Core. Local result: **234/234**. Without Core
it would score 36/234, which is the degraded mode above, covered by the regressions.

## 5. Version pins

| Job | Core | Role |
|---|---|---|
| `real Core context consumer (<os>)` | `fbebc79` | baseline of the task and lifecycle contract (kept) |
| `real Core context consumer (<os>, Core main a168829)` | `a168829` | **current version set** |
| `real Core paged memory export (<os>)` | `a168829` (was `01288e4` until 2026-09-25, same tree `87d5e437`), and legacy `956f798` | PM-013 export and its fallback |
| `quality` (torturebench only) | `a168829` | live symbols |
| `Core first-extraction phases` | `a168829` | diagnostic only |

Update 2026-09-25 (PM-014 preparation): the paged-export job now installs Core main `a168829`
itself. Runs up to and including main run 36169527480 installed `01288e4`; those results stay
attributed to `01288e4`. The legacy `956f798` fallback pin is unchanged.

The `structure_*` modules are identical between `fbebc79` and `a168829`. Only CLI entry and
continuity code changed. That identity does not stand in for running Core main, which is why the
matrix runs both.

## 6. Local results for this candidate (Linux)

- Full suite: 352/352 without Core and 352/352 with the real Core (tree identical to Core main).
- Context-job steps: all pass with Core main without grammars (`--no-deps` venv) and with grammars.
- Hook budgets: unchanged at 150 ms p95 and 500 ms max. Python/Core 67.7 ms, TypeScript/Core
  95.3 ms, JSON/Core 92.8 ms.
- Benches: ExplainBench, IdleBench, IdleBench Corpus and perf-gate pass in both modes; TortureBench
  234/234 with Core.

Hosted results are recorded below as they are obtained; the Windows incident stays open until a
hosted run qualifies the gate without retry.

## 7. Hosted results (dated, none erased)

### Candidate `f7ed121936f7635341a3f3725685ff1b021b7e3c` — run 36165830568 (PR merge checkout `225749f`), 2026-09-25

- **23/24 jobs SUCCESS.**
- **Windows gates:** both passed: `real Core context consumer (windows-latest)` on `fbebc79`, and
  the same job on Core main `a168829`.
- **FAIL:** `real Core context consumer (macos-latest)` (job 108173217987, Core `fbebc79`), step
  `Verify installed historical observations beyond eight entries`.
  - `feature-history-smoke.mjs:60` expected 13 retained observations and got 12.
  - This path goes through `feature-memory` and `feature-model`, which this PR does not change.
  - An observation is recorded only after a canonical parsed extraction within the 500 ms
    feature-map budget; one of the 13 calls did not yield one.
  - The smoke did not report why, so the cause is **not established**.
  - The same step passed on macOS with Core main in the same run, and at `b996638` (run 36147335199).
  - Added: a non-qualifying print of each such call's fixed-field coverage (canonical, parsed, reason)
    before the unchanged assertion.
- **Cold-start diagnostic** (job 108173218012, Windows, Core `a168829`, each observation in its own
  fresh install):
  - **A, product call through the generated `dw.exe` launcher:** call 1 took 509.1 ms,
    `ETIMEDOUT`/`SIGTERM`, which reproduces the incident. Calls 2–11 took 123–169 ms.
  - **B, first call through `python.exe -m diffwitness.entry` under `-X importtime`:** 125.2 ms,
    success. Imports 76.7 ms in total: `importlib.metadata` 19.9, `diffwitness.entry` 18.3,
    `structure_transport` 14.3, grammars 0.7–1.1 each.
  - **C, first in-process phase split:** 104.1 ms in total.
  - **Observed:** the slow first call happens through the freshly generated `dw.exe` launcher. A
    first call through `python.exe` in an equally fresh install is fast.
  - **Not yet shown:** that the launcher's first execution alone carries the cost. Observation D,
    added in the next candidate, runs `dw --version` first in a fresh install, then the product call.
- **Same diagnostic on macOS and Ubuntu:** first product call 117.7 ms (macOS) and within budget on
  Ubuntu; no timeout.

### Candidate `f6667179d0d08998f71b537f3c01bdfaee0361f6` — run 36167041291 (merge checkout `220f402`)

- **24/24 jobs SUCCESS**, including both macOS context jobs and both Windows gates.
- **Windows cold-start diagnostic** (job 108177210427, one fresh install per observation):
  - **A, first product call through `dw.exe`:** 196.8 ms, no timeout; calls 2–11 took 157–170 ms.
  - **B, first call through `python.exe -m`:** 176.7 ms.
  - **C, first in-process phases:** 142.2 ms.
  - **D, first `dw --version`:** 82.1 ms (second 78.0 ms), then the product call 163.4 ms.
- **Conclusion:** the launcher hypothesis is **not demonstrated**. The slow first call is
  intermittent: seen in the `d8e7c9b` gate (509.8 ms), in diagnostic A at `f7ed121` (509.1 ms), and
  in earlier runs 35927891752 and 35936695431. It was absent from the gates of runs 36165830568 and
  36167041291 and from this diagnostic.
- **Excluded by measurement:** in-process Core work on Windows (imports, metadata, grammar loading,
  parsing) stays around 100–140 ms, far inside 500 ms. No code path in IdleProof or Core accounts for
  the spike, so no code change is justified by the evidence. The threshold is unchanged.
- **Status: open, characterized, cause undetermined.** Establishing it would need OS-level tracing
  of process start on the hosted runner, which is outside this lot.
- **Product consequence, now safe:** when that first call misses the deadline, IdleProof reports
  `unavailable` with no structural facts (section 2), and the next call extracts normally.

Codex review of `f7ed121` (P2): the `doing` summary still presented a heuristic symbol, from a
language without a provider, as the active symbol ("around", "centered on"). Fixed in the next
candidate: the summary and the learning context name it as a candidate. The regressions fail on
`f7ed121` and pass after the fix. A learning fixture that asserts an "active symbol" now carries the
canonical coverage that makes it one.

Codex review of `f6667179` (P2): the learning card still used a heuristic symbol as a code location
(`learningTarget`, `applicationPrompt`: "Open fake in widget.vue"). Fixed at the source in the next
candidate with one rule (`src/symbol-provenance.mjs`): a symbol whose coverage is explicitly
non-canonical is a candidate. Explanations may name it as such, but it never becomes a location,
subject or summary anchor, whether in the learning card, the IDE question or the Portal task summary.
Hand-built or legacy signals without `structureCoverage` keep their previous behaviour, because every
signal produced by extraction declares it. The earlier fixture additions are therefore reverted.
Regressions fail on `f6667179` and pass after the fix.

Codex review of `bcecbc8` (P2): TortureBench counted every correct `signals.symbol` as a live symbol,
including the 36 text-matched candidates from Swift and C++, which have no provider. The unchanged
`>= 210/234` threshold, which predates canonical providers and measures correct live-symbol selection,
is kept. A stricter requirement is added and reported separately: every supported-language fixture
must yield its live symbol from the canonical extraction. Local result with Core: 234/234 live, of
which 198/198 are canonical on supported languages, plus 36 text-matched candidates.
