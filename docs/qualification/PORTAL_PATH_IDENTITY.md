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
