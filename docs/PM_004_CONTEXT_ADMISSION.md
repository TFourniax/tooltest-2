# PM-004c — Shared local source admission and context freshness

Acceptance before implementation, 2026-09-18. The feature graph now uses canonical
bounded source admission, but task-signal extraction still has a separate lexical
path check, unbounded read after stat, lossy UTF-8 and a size/mtime-only cache.

Reuse one project-source reader for both consumers. Apply the same canonical
containment/exclusions, strict UTF-8 and descriptor byte/race checks without
changing the existing heuristic extraction semantics or truth claims. Retain
internal aliases and an aliased root. Normalize admitted labels to project-relative
paths. Task-signal fallback may retain caller-provided context but must not add
symbols/routes/dependencies from a rejected file.

Bind any reusable extracted-signal cache entry to actual admitted source bytes,
not size/mtime alone. An equal-size edit with restored mtime must not return stale
observations. Replacing or externally retargeting an alias must not reuse prior
source facts. Keep cache entries bounded; do not retain raw source or prompt in
cache keys. Cached objects must not let a caller poison later extracted results.

Use failure-first owned fixtures for external/excluded aliases, invalid UTF-8,
same-metadata changed bytes and caller mutation. Run both consumers' regression
suites, full quality/privacy/product tests and remote/fresh-main qualification.
No shared immutable-Git provider, runtime proof, or HUMAN qualification is claimed.
