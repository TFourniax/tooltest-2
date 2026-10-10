# Project understanding candidate — 2026-10-10

Status: IN DEVELOPMENT. MACHINE qualification pending; HUMAN NOT RUN. NOT ALPHA READY. No release or installation on the human witness.

## Verified sources and integration base

GitHub main heads checked through the authorized connector: Core `61dbf48c0dcff3a7c7e569d7074570a9e5762e1c`, Local `7725057396e196004f6456f0e19dca45beefa66e`, Portal `459cb7bffa5188e6b036e14463133fd3ec9dab24`. Private Engine identified by Core #74 as `TFourniax/diffwitness-private`, main `ce3d2771821b3a9508290311513ce26f98b5c768`. Its proprietary implementation remains outside public repositories.

Candidate ancestry: Core PR #132 `018eae598b6c048b6c072c49cf1c124c9b46f13b`; Local PR #36 `13debfe3a6d609cf4ea08846aedfc48e46e9df21` contains #31 `0ae23a51e526659aa54a5f977b19f9fa5f2adc74`, merged locally with PR #28 `7f6d041550b1c33ef64a72d441e7b4e6d737eda6`; Portal #44 `7d8f2847ad1e717a97270750958b4cf243db4aab`. All PRs remain open; formal review and inline-thread endpoints returned empty lists, not independent approval.

Terminal GitHub clone failed (`getaddrinfo() thread failed to start`), and local gh credentials were invalid. Sources were obtained via the existing authorized connector. All 1,674 candidate files were verified against original Git blob hashes. Original commit bytes, ancestor commits back to each main, and all trees were reconstructed and hash-verified; checkout is shallow at the original main. No fabricated source commit identity. The isolated work branches preserve the exact upstream parents.

## Trust and historical boundaries

Core #74 body and 216 follow-up comments, Local #29/#30/#32–36, Core #132 and Portal #44–48 are source inputs. The 2026-09-23 body is historical; later issue/PR evidence is retained separately. Core state graph is memory navigation. State rebuild writes derived projections and may synchronize debt; neither is a substitute for a safe structural read.

H7–H15 is bounded historical evidence. H12 remains PARTIAL (autonomous reboot failed, scoped human repair recovered service). H15 demonstrates identity/assurance recovery and idempotence, not all advisory snapshots. Historical witness IDs are not fixture IDs. No access to, modification of, installation on, reset of or cleanup of the private WSL witness or backups is authorized by these tests.

## Conformity matrix and source arbitration

The normative task-by-task matrix is [PROJECT_UNDERSTANDING_CONFORMITY.csv](PROJECT_UNDERSTANDING_CONFORMITY.csv), also supplied as JSON. It contains 66 separately identified requirements with source/section, horizon, implementation, gap, corrective task, acceptance, evidence and independent MACHINE/HUMAN status. A targeted PASS is scoped to its listed evidence, not the combined Alpha criterion. The generic HUMAN oracle has 40 facts and 30 questions in PROJECT_UNDERSTANDING_HUMAN_CORPUS.json.

Source conflicts are explicit:

- Local PRODUCT.md historically places BYOK in Pro, while current #33 makes an optional operational BYOK path an Alpha requirement. The newer specific issue governs this lot; the deterministic first-use path still needs no key.
- Core STRUCTURE_PROVIDERS.md retains an early Python-only milestone description. STRUCTURE_EXTRACTION.md, the current registry/profile and installed-provider gates document the later languages. Missing grammars still mean unparsed, not silently supported.
- The Portal blueprint §20 calls itself destination/doctrine and delegates implementation horizons to its roadmap. Roadmap §6 lists Requirement Matrix/Trust Graph/Registry/intelligence as post/parallel commercial work and Team/Enterprise expansion separately. Current #35 nevertheless explicitly requires a scoped Alpha intent/map/navigation path; that specific requirement is included here and is not deferred using the broader roadmap.
- Historical H12 is PARTIAL; H15 is identity/assurance/idempotence evidence. New synthetic MACHINE results cannot rewrite them.
- Registry #74's historical body is not the current integration head. The later comments and actual PR parents are preserved; empty review endpoints do not constitute independent review.

## Candidate and qualification journal

Core draft PR #133: `570bb0e132ff307776d88e0ba6bd3e28c1ad0884`, tree `1f59e3e375af1846889f3707e4e02527e50a2c12`, exactly matching local candidate `d087902`. It retains #132 as parent. Core full source suite is running; installed/package/OS CI is pending. Companion Local/Portal heads and final reports will be recorded at freeze.

Targeted MACHINE evidence on Windows/Python 3.11.9/Node 24.16.0:

- Core capture suite: 13 tests, 12 PASS / 1 explicit inability to create an OS symlink fixture. This is not a cross-platform symlink PASS.
- Real Core→Local: task-free initial scan, immutable source, independent WORKTREE, cross-process resume and commit refresh: 4/4 PASS.
- Generic multi-layer corpus: PASS; sources/thresholds/imports/intent/test candidates and no source execution. A real Python numeric JSON spelling bug was found and corrected; duplicate keys remain rejected.
- IDE origin bridge unit and CLI/offline-delivery regression: PASS. The private incident cause is not retroactively asserted.
- Optional provider storage/consent/budget/fallback/citations and navigation: 7/7 targeted tests PASS. Live OpenRouter: NOT_RUN.
- Actual Core→Local→Portal validator: PASS, legacy admission, source absence, rejected forged authority and zero-check mastery label. Database/build/browser qualification remains separate.
- Browser automation runtime did not initialize locally (missing Windows platform directory). Hosted Chromium recipe prepared; no local visual PASS.
- Docker executable is present after terminal recovery, but daemon access returns permission denied. No stack started, restored or cleaned. Hosted disposable recipes are required.
- Earlier npm bootstrap failed with `Exit handler never called`; no successful Portal dependency/build claim.

The initial terminal interruption left no completed full-suite result. WIP recovery commits preserved the work. The first new golden-script attempts found cursor and report-field fixture mistakes; they were corrected, and only a later complete report may qualify that gate. No partial run is a global PASS.

Other Alpha blockers remain linked to #74 and Portal #45/#46/#47: HUMAN reboot/recovery, prior Windows/macOS first-call incidents, 100k latency budgets, and the earlier old-server delivery incident. This lot does not close them. No release or Alpha Ready declaration.
