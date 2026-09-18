# PM-012i — Bounded Git work at the IdleProof Stop boundary

Acceptance before implementation; base is PM-010a PR #5, head
e2329f0b1bc259dad2f34de3375e2c0ee0fdf9e0. Canonical registry is Core #74.

Local Windows Stop fails 750ms on baseline (1329.4ms) and candidate (1414.2ms).
Profile: 1277.4ms total, 1213.6ms in 20 Git processes. Repeated diff/stat reads,
HEAD resolution, one reset per transient file and identity reads dominate.

Batch equivalent Git reads and literal transient exclusions; preserve exact
meaningful worktree tree, dirty baseline, nested repositories, user's real index,
diff bytes, counts and existing change-ID algorithm. Do not introduce persistent
unchecked caches. A failed exclusion must fail closed. Pin HEAD/tree pairing to
one captured commit so a concurrent HEAD advance cannot mislabel a candidate.

Regression-first process-count bound, unchanged diff/tree/index behavior, Git
pathspec characters, failure injection and actual HEAD advance. Existing analysis,
identity, signed attestation and native journey tests; unchanged latency budget,
full remote gates and fresh main. Record failures explicitly. This does not close
Core incremental journal work or complete PM-012. HUMAN NOT RUN.

## Bounded review and local qualification

Snapshot now enumerates tracked and untracked paths against a disposable index
initialized to the captured HEAD. Literal NUL-delimited admission excludes runtime
files before adding, including newly staged runtime artifacts. Files committed in
HEAD and deletions retain their meaning. Non-UTF-8 paths and Git/path admission
errors reject identity; the real index is untouched. Tree resolution uses the
captured commit ID, preventing a later HEAD update from changing that pairing.

Advisory status provides HEAD and raw paths in one process. Diff and numeric
statistics are read together with NUL framing, retaining exact patch bytes and
avoiding invented quoted/rename aliases. Git user identity is read once and remains
self-asserted metadata. Existing signatures, chain validation and Proof authority
are unchanged. There is no persistent metadata/content cache.

Four regressions fail before repair; Unicode rename regression additionally fails
before NUL correction. Expanded local focused suite 21/21 PASS (15.715s), full
suite 189/189 PASS (76.643s), zero skips. Windows performance initially still fails
at 812.2ms; final measured Stop 684.8ms passes the unchanged 750ms gate. Hook p95
17.0ms, max 21.5ms; state p95 0.7ms. Remote gates and fresh main remain required.
