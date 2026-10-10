# Human acceptance of the coordinated candidate

Status: NOT RUN. No signature, HUMAN PASS, Alpha Ready or release is implied.
Use the exact source/package hashes in the final candidate manifest. Technical
and nontechnical evaluators sign separately. Retain their observations and first
failures; a later repair cannot turn the original campaign into all PASS.

## Isolated setup

Use a new disposable checkout/VM and the synthetic corpus generator in
`test/support/project-corpus.mjs`, then a second non-sensitive project voluntarily
provided by its owner. Never use `~/code/dw-human-test`, its Git/IdleProof state,
the real `~/alpha/backups`, or `~/alpha/portal`. Do not request their contents or
credentials. Install candidates into an isolated environment, not the existing
installation. Do not publish packages.

Destructive Portal restore tests are limited to the dedicated hosted job or an
explicitly disposable VM running `alpha-local-qualification.sh` with
`ALPHA_LOCAL_QUALIFICATION=disposable`. Its project/container/volume preflight must
pass. No volumes, fixed ports or credentials may be shared with a retained stack.
An unavailable Docker daemon blocks only this validation, not offline development.

## Product journey

1. Open Local with no task history, no provider key and Portal unavailable. Select
   the two owner documents and the optional CI lane. Start the global scan. Record
   inventory/read/parsed/excluded/omitted/error counts, complete denominator or its
   explicit limitation, capture ID/profile and document selection.
2. Use Guided and Technical views to answer the 30 questions in
   `PROJECT_UNDERSTANDING_HUMAN_CORPUS.json`. Score factual correctness and provenance
   separately against its 40 facts. Record clicks for Q01/Q07/Q08/Q24/Q30, zero
   invented systems, explicit unknowns and differences from the old product.
3. Start a normal native agent task in the disposable project. Confirm that its
   task identity/focus remains visible while navigating global rules and tests.
   Follow up without a pivot, then explicitly pivot and inspect both identities.
4. Change a boundary, add/rename/delete a file and compare WORKTREE with HEAD.
   The dirty frame must not claim HEAD authority. Commit it and observe background
   refresh, preserved old citations and correct invalidation. Pause a larger scan,
   close the process, resume the returned snapshot from a new shell.
5. Run authorized discriminating tests and actual Core Proof/debt on this separate
   change. Check exact change/certificate identity, positive debt/budget rejection,
   zero versus absent measurement and IDE source attribution. A scan, quiz answer
   or declaration must not create Proof or waive a budget.
6. Record a decision/task through the existing Core CLI. Ask a supported recorded
   question in Local, open the original event, then retire/supersede it and inspect
   history. Restart Local and use the sourced handoff from another shell/agent.
7. On the candidate Portal, enroll this isolated project, sync and inspect the
   received baseline/task/history. Check local-only bodies/docs remain absent,
   counts and omissions are visible, and an advisory receipt does not revoke
   exact-change assurance. With zero checks, mastery is Not assessed; wrong/right
   answers update only the corresponding human assessment.
8. Stop/restart the disposable stack, then perform its A/B restore and exact
   original-B replay recipe. Inspect snapshot and assurance 1-to-1 counts, unchanged
   certificate bytes, identity recovery and memory cursor replay. Reboot the VM
   separately: operator action and autonomous failure remain recorded if present.

## Optional provider acceptance

The operator enters a dedicated capped OpenRouter key locally via protected stdin.
No key is supplied to an agent conversation, screenshot, CI log, Git or Portal.
Choose a model and budget explicitly. Test the connection without context; preview
the exact metadata packet, then opt in separately to source descriptions and Core
memory if desired. Approve its digest and run one bounded request. Record model,
latency, tokens and provider-reported cost, or explicit unavailable values.

Check refusal/rate-limit/offline/invalid response/cancellation and deterministic
fallback. Repeat unchanged context and verify no new paid analysis. Change the
context and verify prior consent is invalid. Rotate/remove locally and revoke
the provider key. Compare factual quality to the deterministic corpus without
promoting a cited interpretation into Proof, declared intent, debt or mastery.

## Acceptance record

Record source and artifact SHAs, OS/runtime/browser, evaluator, date, question
scores, zero invented systems, click counts, exclusions, evidence paths, failures,
manual repairs and remaining unknowns. Required factual/provenance score: >90% on
20–40 questions; fewer than three clicks for the five priority drilldowns. A
missing grammar, operator, key or runtime is NOT RUN/LIMIT, never an implicit PASS.

H12 remains historically PARTIAL. H15 never claimed complete recovery of every
advisory snapshot. Independent review and all applicable release gates remain
required after this candidate's human recipe.
