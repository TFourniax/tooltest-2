# PM-010a — Bounded Core context consumer

Acceptance recorded before implementation on IdleProof main
0a6d6eaa7bf5afab72e185be0d0d97d3b679cd5f. Canonical registry:
https://github.com/TFourniax/tooltest/issues/74.

The current consumer checks only schema and context-ID spelling, omits durable
tasks and lifecycle reviews, discards warnings, and its Portal relation projection
does not read Core's string endpoints. This can lose task-linked history or show
malformed advisory data. Establish regression coverage before changing admission.

Validate bounded typed fields consumed by IdleProof and Portal, explicit advisory
trust boundary, active lifecycle reviews and epistemic statuses. Bind live CLI
responses to the requested query; reject malformed output without breaking the
hook. Preserve warnings, tasks, review reasons, relation endpoints and related
changes. Request exact native task ID alongside semantic intent without changing
existing task identities or semantic matching in unrelated features. Portal must
use a bounded redacted whitelist, never task digests or arbitrary details.

This validates an advisory context contract, not a cryptographic certificate or
the truth of a declared statement. No recomputed context digest, signed handoff,
cross-repository freshness proof or full PM-010 completion is claimed here.
Cross-runtime long/Unicode prompt normalization remains a separate task.

Required: regression-first malformed/oversized/mislabeled/inactive contexts,
task/review/endpoint retention, privacy, graceful unavailable Core, real Core CLI
interoperability, existing unit/product/quality/package CI and fresh exact main.
All scripted journeys are MACHINE; HUMAN NOT RUN.

## Bounded review

One shared admission module is used by live CLI loading, agent rendering, counts
and Portal projection. It rejects malformed arrays, objects, bounds, unknown
authority labels, query mismatches and inactive/upgraded applicability reviews.
Legacy absence of the additive tasks/lifecycle fields remains compatible. Input
has byte, node-count and depth budgets; output truncation is visible. No dependency
or network service is added. Context IDs and source anchors are typed references,
not independent cryptographic or freshness verification.

Task identifiers are added only to the Core continuity query. Existing feature
semantics and the native task-ID function remain unchanged. Core relation endpoints
are preserved; Portal exports only selected bounded/redacted task/review fields,
never arbitrary payload details, prompt or session digests. Warnings survive
rendering/projection, and unavailable/rejected memory is surfaced as such.

Local Windows tests: 183/183 PASS (107.285s) after serializing test files. Baseline
and candidate both reproduced a 15-second demo timeout under parallel Git-heavy
journeys, including a four-worker trial. Demo alone passes; no timeout was raised
and no test was skipped. Quality/package/remote qualification remains required.
