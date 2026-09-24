# Exact provider failure evidence (PM004/PM010/PM012)

The original macOS and Windows failures remain open. Run35934885827/job107429581854 again failed macOS on a.rb, reporting core-extraction-unavailable after639.6ms. This alone cannot distinguish spawn failure, deadline, nonzero exit or response rejection.

An optional in-process diagnostic callback now receives only fixed-field failure metadata at the original invocation: admission/process/protocol stage, bounded error-code enum, exit/signal, elapsed time and output byte counts. It never receives source, paths, command, stdout, stderr or error text. Existing qualification scripts print these records immediately; original assertions, timeout500ms and hook p95/max budgets are unchanged. No retries, background work, network, production logging or new runner. A throwing observer cannot change the extraction result. Normal product calls do not enable diagnostics.

Before/after regressions include an actual nonexistent executable through the real task-context boundary. All274local tests pass. Installed actual Core optional-provider scripts pass locally; this is bounded non-reproduction and MACHINE evidence only. Hosted exact-head review/CI and fresh main remain required.

Review4088451507: a rejected async observer promise could crash the host. The real child-process regression fails before and passes after explicitly containing returned promise/thenable rejections. All275local tests pass without skips. Extraction results, timeout and original qualification assertions remain unchanged.

Run35936695431/job107435206200 fails the original Windows optional-language
qualification at headc47febb. The original four-file JS/TS/Go/Rust invocation
reports ETIMEDOUT, SIGTERM,709.2494ms, stdout0/stderr0; its500ms deadline
and the invented-versus-actual assertion are unchanged. This establishes a
process timeout for this occurrence, not the underlying host/import cause or
a resolution of this or older incidents. The earlier ENOENT diagnostic is an
intentional missing-command test and is not this failure. The actual Core
consumer remains pinned tofbebc797968014600c1b89aed603984e15f78d5c.

Currentmainf4d5854 is integrated to preserve qualified path-identity fixes.
All285local tests pass. Original raw logs and hashes are retained; the current
PR remains unqualified until reviewed final-candidate CI and fresh main pass.
A green later run cannot close the historical performance incident by itself.
