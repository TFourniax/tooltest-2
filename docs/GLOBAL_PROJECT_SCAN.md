# Understand an existing project before the first agent task

This candidate adds an explicit global baseline to the existing Local cockpit.
The active task stays visible above it and as a lens over the captured paths.
Core owns extraction, identities, source provenance, canonical memory, Proof and
Debt. Local composes these facts. No Portal connection or AI key is required.

## First use

Use the coordinated Core candidate from `docs/qualification/PROJECT_UNDERSTANDING_20261010.md`.
The existing Core executable selection is honored (`DIFFWITNESS_BIN` or integration
configuration). An older Core yields an explicit unavailable scan, never a fake
complete project model. No installation occurs during a scan.

```sh
idleproof project scan --document docs/OWNER_INTENT.md --ci
idleproof project show --json
idleproof project scan --source WORKTREE --document docs/OWNER_INTENT.md
idleproof project cancel
idleproof project scan --resume dwscan_<returned-id> --json
idleproof project ask --query "Why was this decision recorded?" --json
idleproof project handoff --query TASK-ID --json
```

Open the usual cockpit (`idleproof serve` or the existing `idleproof on` flow).
In **Understand the whole selected project**, choose committed Git or working
files, list exact owner-document paths, optionally select CI, then scan. Inspect
the inventory counters and exclusions before interpreting any result. Use search
to find a rule/component, expand it, then **Why?** to read the captured source.
The handoff contains local source descriptions; review it before sharing.

## What each view means

The map describes declarations, branches, return/raise expressions, manifest
entries and static imports with source hashes and positions. It preserves literal
thresholds. It never invents a composed business flow from independent functions,
nor a deployed service from a technology name. Route/decorator candidates and
resolved imports remain INFERRED; the source syntax is OBSERVED, execution UNKNOWN.

Owner documents are opt-in DECLARED intentions. They are not the DiffWitness
product blueprint. Exact component paths mentioned in a declaration nominate
review links; no text match makes the requirement implemented or proven. The map
separates intended behavior, observed code, candidate tests, historical exact-change
assurance and unknown fulfillment. Missing links remain explicit next work.

**Recorded objectives, decisions, related tasks and assurance** queries actual
Core context. It retains declaration authority, original event ID/hash, lifecycle,
related changes, debt and required evidence. **Open original event** calls Core's
read-only citation API. For complete history, use `dw state history ID --json` and
its cursor. An eight-item context is not complete project history. An unavailable
context is visible, not reconstructed from guessed intent.

Create readable durable intent through existing canonical commands, for example:

```sh
dw task add "Preserve the calculation boundary" --id TASK-BOUNDARY --why "Owner requirement"
dw decision record "Keep rules independent" --id DEC-RULES --why "Different callers need different policies"
dw task link TASK-BOUNDARY dwchg_<actual-id> --why "This change implements the declared task"
```

These append DECLARED memory. Native task participation remains OBSERVED for its
exact session boundary. Neither association proves task completion. Testing and
`dw prove` are a separate authorized step; a scan runs neither. Actual Proof and
measured Debt are joined only by Core's exact change identity.

## Refresh, history and budgets

HEAD and WORKTREE pointers are separate. The cockpit checks the committed tree
every 15 seconds and refreshes an existing completed HEAD baseline in a background
job using the same selected documents/CI scope. Task events update the task lens.
Dirty/new/deleted files require an explicit WORKTREE scan; a WORKTREE frame is
always labeled captured-only. Profile changes require a rescan and are displayed
as analysis enrichment, not a source behavior change. Identical-content commits
reuse the original frame. Old frames and captured source remain accessible.

Extraction proceeds in 32-file batches outside hooks. Pause/resume survives
process exit. Initial capture is atomic and bounded; cancellation is observed
between batches, not in the middle of a source read. An interrupted initial
capture must restart. A working-tree mutation during capture rejects the operation.
Concurrent scans cannot overwrite each other. A failed job retains its diagnostic.

Core limits: 20,000 enumeration entries including traversed WORKTREE directories,
2,000 admitted files, 1 MiB/file, 32 MiB source, 64 documents, 2 MiB/page. Local
retains at most 32 MiB for a projection and renders 60 matching components at once;
search narrows that view. Limits never expand native hook budgets. Cached results
are bound to source hashes, roles and provider profiles. A rerun does not invoke AI.
No cache cleanup or history rewrite is automatic.

Responsibility review shows identical-byte candidates and bounded Core similarity
candidates with differing guards/literals, callers available in the static map,
source positions and discriminating-test suggestions. Complementary wrappers are
not automatically duplicates. Dynamic references prevent claims of unused code.
These findings are advisory and have no Debt points. Use existing reviewed Debt
rules and a separately verified change for any later consolidation.

## Portal and trust

The existing snapshot transport can include a HEAD-only metadata summary: capture
identity, profile/selection digests, counts, at most 12 components, three operation
names/counts per component and 16 static links. Code bodies, conditions, selected
documents, WORKTREE bytes, raw prompts and secrets are not exported. Projection
omissions are explicit. Portal cannot open local files; its source references are
instructions for Local review. It preserves received snapshots longitudinally,
without treating absence in a later bounded receipt as deletion.

Upgrade Portal's validator before this Local producer: the old strict validator
may reject new optional nested metadata. A rejected/offline delivery stays queued;
it cannot revoke local Proof. Legacy receipts remain readable. No database
migration is required because metadata uses the existing validated JSON projection.

Human concept/feature mastery is separate from inventory and AI interpretation.
No checks means **Not assessed**, not zero analysis. Older receipts with no
denominator say **Assessment unavailable**. Opening a map or receiving an LLM
answer does not increase human mastery or alter Proof/Debt.

Optional explicit interpretation is documented in [OPENROUTER_LOCAL.md](OPENROUTER_LOCAL.md).
The deterministic map remains available without it. MACHINE test results and
HUMAN acceptance are recorded separately; this document is not Alpha readiness.
