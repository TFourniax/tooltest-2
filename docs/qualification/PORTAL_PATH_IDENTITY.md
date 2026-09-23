# Portal path identity without truncation

Registry #74, C4 / audit A/AUD-05. Based on qualified Idle #19 head
55ada41f8952745448409f2a34fde76fbaddfd22, merged as d375177a1a92442eead09f178b37e8957c4824d1.
The main merge has the same source tree; fresh main qualification is separate.

The Portal v1 consumer represents paths of at most 300 UTF-16 code units.
Longer paths are omitted intact across files, explanations, feature stories/tests,
continuity components and recent changes. Control characters and traversal are
also omitted. No arbitrary bound increase or display-prefix identity is used.
Coverage counts/reasons are visible in existing v1 task summary and continuity
warning fields, including when Core continuity is absent. Known omitted rows
cannot leave dangling relations. Local input and historical data remain unchanged.
Task summaries never truncate an embedded path to fit their independent bound.

Four new regression tests fail on the baseline. All 276 local tests pass after
correction, without skips. One old summary oracle was updated to require the new
explicit omission notice while preserving its exact accepted path; the first
post-change failure is retained. The installed npm package passes six scenarios
through Portal main 0e12c644f1f65f399af76a70ef81a684b5fc64cd's exact validator blob
1596ce52cf8e177b0fd87ac566a5607493d0f84c. The initial extracted validator had one
extra trailing newline; that run is retained and the exact-byte run is separate.
Unicode/multibyte bounds, shared prefixes, relations, stable snapshot identity and
64 KiB admission are asserted. The existing schema is unchanged for old consumers.

Use scripts/portal-paths-smoke.mjs with an installed npm root and exact Portal
validator path. It reports MACHINE, not HUMAN, and explicitly HTTP=false/DB=false.
No authenticated HTTP, Edge, DB, deployment or publication is claimed by this
local test. Those real boundaries remain part of C4/PM-010/global qualification.
Independent last-head review, hosted OS matrix and fresh main are still required.

Installed npm SHA-256: `f1476f3bc79d5700c12d65bd0d640035302d87eac3ae5266b9f6a3eadee3ef00`.

## Legacy-context review correction

Review4087944276 found an absent historical tasks array dereferenced by the
new relation filter. The admitted legacy-context regression fails on be56757
and now passes with the same empty-array fallback as existing projection code.
All 277 local tests PASS with zero skips; the four original path regressions
remain. Raw before/after/full evidence is retained in legacy-review.

## Rejected context coverage guard

Review4088068228 found that the omission scan dereferenced rejected advisory contexts. Seven malformed/absent context forms now retain the prior continuity:null behavior and cannot add unadmitted path warnings. The regression fails on e017086, passes after guarding on admission; all278local tests pass with zero skips. Original path and legacy tests remain. Raw before/after/full logs are retained in malformed-review. Fresh final-head review/CI and real HTTP/DB remain required.

## Task description with coverage notice

Review4088130000 found that a long supported current path plus another omitted path could replace the task description entirely. A compact description now accompanies the warning whenever the exact summary would exceed300characters. The exact path remains in its admitted file fields. Regression covers187/250/300-character current paths, fails on f5c89af and passes after correction. All279local tests PASS/no skips; before/after/full logs retained in summary-review. No path truncation or schema change.

## C1 controls and current-main integration

Review4088213313 identified C1 controls outside the original C0/DEL omission range. The path guard now also rejectsU+0080..U+009F. A regression includesDEL/0080/0085/009F and fails on4feb2e9, then passes after correction. All279localtests PASS/no skips. Current main4737555 is integrated; original histories/evidence retained. Final review/CI/main still required.

## Projection row caps (review 4088314335)

A real 41-path session omitted its last file without a coverage notice. The failing-before regression now covers 40/41/80 paths, mixed invalid and capped paths, explanation rows, feature story rows and test paths. Coverage counts each distinct path omitted by an applicable projection row limit alongside invalid paths. Paths that remain admitted retain their exact identity; all existing row and byte budgets remain unchanged. Local 280 tests pass without skips.

This does not resolve the independent provider incidents: run35933394396 failed on Windows (invented/actual) and macOS (Core extraction unavailable); these failures remain recorded and block qualification.
