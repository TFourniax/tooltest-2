# Whole-project scan: diagnosed gap and staged corrective design

Status: source review + tested narrow recall correction; the whole-project integration below is NOT yet implemented or HUMAN-qualified. Related: IdleProof #29, #31, #32, #34, #35 and Portal #47/#48. No release or modification of the user's qualified WSL project.

## 1. Exact source baselines inspected

- Core TFourniax/tooltest: 61dbf48c0dcff3a7c7e569d7074570a9e5762e1c.
- IdleProof TFourniax/tooltest-2: main 7725057396e196004f6456f0e19dca45beefa66e; PR31 candidate 0ae23a51e526659aa54a5f977b19f9fa5f2adc74.
- Portal TFourniax/idleproof-portal: PR44 candidate 7d8f2847ad1e717a97270750958b4cf243db4aab; user's retained working checkout remains 49e48a7e9a87837aba0b5a269c62b15221acae52.

## 2. Root causes, not just the symptoms

### Existing Core primitives are not a complete human project view
Core `src/diffwitness/structure_provider.py:refresh_structure_index` already reads an immutable HEAD Git tree through `structure_sources.py:tree_sources`, extracts supported languages, and builds SQLite components, symbols and typed import/name-call edges with provenance. It checks tree/provider/extraction versions for freshness. Default and hard maximum: 2000 eligible files, 1 MiB/file, 32 MiB total. Oversized, omitted and unparsed sources are explicit coverage failures. This is a useful existing foundation; do not invent a second incompatible extractor.

Limits matter: this is HEAD, not uncommitted working bytes; hidden/generated directories are excluded, including `.github` under the generic hidden-directory rule. The denominator is eligible tracked source files, not every repository file. The `dw state graph` CLI reads memory entities/relations, not the entire structure index. `dw state rebuild --structure` also synchronizes debt and reconstructs derived state: it is NOT a zero-write query to run on an immutable HUMAN witness just to explore it.

### IdleProof has a task lens, not a whole-repository lens
`src/feature-model.mjs:buildFeatureModel` seeds extraction from `session.currentResource`, `taskSignals.file` and at most the last eight touched files, then follows bounded local imports. `src/structure-provider.mjs` sends bounded source batches to `dw state extract --json`. `src/project-model.mjs` aggregates remembered feature surfaces; untouched/unobserved modules can be absent. Raising the per-task limits is not a replacement for a versioned repository inventory.

### Observations are promoted into architecture claims
`featureSnapshot()` retains flattened story/routes/tables/technology names but not the full per-reference origin. `compareFeatureSnapshots()` treats any technology-reference change as material. `feature-review.mjs` formerly called the first newly observed technology an external boundary and asked when it was added to the feature. This cannot distinguish a new observation, an existing test framework, a changed parser, and an actual newly introduced runtime boundary.

The HUMAN example is decisive: pure `loyalty_points(subtotal)` plus pytest tests, while Pytest already existed for two earlier features, produced `new external boundary Pytest`. The local scan returned only loyalty source/test, despite a three-feature repository. No LLM is involved in this incorrect inference.

### Existing tests encoded the wrong oracle
`test/feature-review.test.mjs` explicitly expected `/new external boundary/i` from an entry carrying only `added.technologies: ['Redis']`. A green check proved conformity with that heuristic, not the existence of a new runtime integration.

## 3. Immediate correction in this branch

Only the recall renderer, its challenge identity and recall tests change:
- A technology/route/data/file reference newly recorded in the bounded model is described as a reference, not a newly deployed dependency, reachable route or proven persistence surface.
- Never reuse an old summary such as `new external boundary Redis` as authority in a fresh explanation.
- A model observation changing is distinct from software architecture changing.
- Include a semantics version and question/explanation/refresh meaning in challenge identity, so answers to an old misleading question are rejected before updating mastery.
- Keep queue scheduling, confidence increments, local stored history and Proof/Debt identities unchanged. A successful quiz remains a memory exercise, not executable evidence.

MACHINE reproduction in isolated Linux container, Node 22.16.0:
- Original fetched review module Git blob verified: 34726373cc783c274113a91599e8bf73469dc5b8.
- Original fetched test blob verified: b5f3d6d5f7b23b4c413b23b933b6900251237bb5.
- New regression set + existing tests before patch: 16 total, 5 PASS / 11 FAIL.
- After patch and correcting the old false wording assertion: 16/16 PASS, 0 skips; `node --check` PASS.
- Cases include Pytest/React/Redis/Stripe (no hardcoded Pytest exception), stored legacy summaries, route/data references, read-only generation, stale challenge rejection, and unchanged proof/debt fixture fields.

This is NOT a complete Core/IdleProof/Portal test run, not a WSL HUMAN replay, not a repair of the scanner or a new classification algorithm. `feature-memory.mjs` materiality/weighting is intentionally not silently changed; typed evidence-aware drift is in the next stage.

## 4. Corrective architecture to implement under #35

### A. Canonical repository inventory in Core
Expose a bounded, paginated, versioned structural snapshot through a supported read contract. Proposed command shape (not implemented): `dw state structure --json --cursor ...`. Do not couple IdleProof directly to private SQLite tables. Reuse `tree_sources`, `extract_structure`, source hashes, tree identity and provider profiles. Every page must share an immutable tree/profile scope; changes during paging require restart or a preserved prior frame.

Include explicit manifest/configuration and opted-in documentation lanes. The code lane must never silently broaden into `.git`, credentials, `.env`, node_modules, generated files or symlinks. CI files under `.github/workflows` require an explicit scoped inclusion instead of removing all hidden-directory exclusions. Untracked/dirty files use a distinct safe WORKTREE snapshot/overlay and are never presented as HEAD facts.

Output at minimum: files eligible/read/parsed/skipped, sizes and omission reasons, source hash/lines, declarations, imports, unresolved targets, entry-point candidates, route/data references, test roles and manifest dependency categories. Do not execute repository code during inventory.

### B. One project graph, two views
IdleProof consumes that repository snapshot as the project baseline. The existing task view remains a focus/overlay on the same identities, not a substitute for project coverage. Distinguish:
- source/test/build/development dependencies;
- local modules and unresolved/package references;
- actual observed declarations/call syntax from inferred target resolution;
- recorded project intent (blueprint, requirements, decisions) from implementation and tested/proven behavior.

Join requirement -> component -> related test -> exact accepted certificate only when supporting links exist. Merely importing a function in a test is not proof it is covered. Merely seeing a file called auth does not establish its business role. No count of quiz answers establishes scan completeness.

### C. Real duplicate-responsibility triage
Use tiers, not filename alarms:
1. same bytes or normalized token block (Core docs/DEBT_SENSORS.md already describes `duplicate.literal_block`; implementation scope must be checked before reuse);
2. structurally similar function candidates with source spans and preserved literals/security-relevant differences;
3. candidate responsibility overlap based on exported operations, callers, routes, inputs/outputs and scope;
4. complementary layers or wrappers (do not recommend deletion);
5. apparently unused implementation, with dynamic imports, reflection/configuration and unsupported-language gaps explicitly excluding certainty.

Concrete negative fixture from the real Portal: `src/lib/auth.functions.ts` imports `loadViewer` from `auth.server.ts`; `getViewer` calls it and other functions implement signup/signin/password operations. `auth.server.ts` reads Supabase claims and returns viewer identity. These are complementary layers, not a redundant auth implementation on filename evidence.

A useful finding describes both implementations, relevant callers and differences, what is known/unknown, and a proposed consolidation test. Never delete a file automatically because it looks duplicated. A suggestion is not immediately a measured technical obligation: promotion into Debt Ledger needs an explicit existing rule/policy or reviewed admission, followed by normal verification on a separate change.

### D. Evidence-aware changes
Compare facts under the same extraction profile and coverage first. Different extractor coverage or first observation is analysis enrichment/unknown comparison, not architectural drift. Separate source edits, changed runtime-dependency candidates, added test tooling, renames and analyzer-version changes. Preserve old history; record a new classification/projection rather than rewriting old evidence.

### E. Grounded explanation and optional OpenRouter
The explanation should answer what the application does, where its behavior lives, how components connect, what is tested/proven and what remains unknown. Deterministic facts feed an optional synthesis layer. LLM output may propose an INFERRED role with citations; it cannot invent a service or promote a hypothesis into Proof/Debt. Transmission of source content to a remote provider needs an explicit scope/consent; Portal's existing bounded metadata privacy contract is unchanged.

### F. User-visible result
On the three-calculator fixture, report three independent rules and their thresholds/tests. Do not invent a fully integrated checkout flow: the existence of separate calculators is not proof of their business composition. On a real multi-layer project, show blueprint intent, detected entry points, connections, duplicate candidates, inconsistent implementations, coverage gaps and the most useful verification actions. A 'Why?' link should open exact source lines/tree version and evidence class.

## 5. Acceptance cases before integration

1. Initial scan with no agent history still finds an untouched auth module and its tests.
2. Two complementary auth files are not marked as duplicate implementations.
3. A literal duplicate appears with matching spans; a near-duplicate missing a role check is flagged as a candidate conflict, not called equivalent.
4. Test-only Pytest detection creates no newly-added external runtime boundary.
5. A real changed external call remains visible as a supported candidate with production source references.
6. Same tree + different extraction coverage reports analysis enrichment; it does not assert the project changed.
7. Dynamic/unresolved import blocks an unsupported 'unused' conclusion.
8. Truncated/unsupported/secret-excluded paths leave explicit incomplete scope; source hash changing invalidates derived facts.
9. A newly failed test or non-zero debt follows normal Proof/Debt policy; a scanner hypothesis does not bypass it.
10. Existing H7-H15 synthetic golden contracts and then one focused HUMAN WSL acceptance continue passing. The private user's real backups/journals stay untouched.

Execution order: narrow recall correction now; inventory exporter + pure auth fixtures next; project UI/duplicate triage and blueprint links afterward; optional LLM only on grounded context. Batch targeted tests during development, one full suite per frozen candidate. No upgrade of the user's WSL or merge to main without qualification.
