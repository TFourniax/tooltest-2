# Native source path identity correction

Classification: MACHINE. Baseline: e160f5316e840fe8333250eee74a45a36c87d6a0.

On POSIX, `part\file.py` and `part/file.py` are different files. The baseline
replaced every backslash with `/`, admitting source bytes under another path,
reading a different feature seed, joining unrelated impact entries, and changing
explanation/provenance/export labels. A meaningful untracked file named
`.idleproof\meaningful.py` was also omitted from the alternate Git index as if it
were local application state.

One host-native path conversion now preserves literal POSIX backslashes. Local
metadata and Git content retain those names. Source admission and Portal path
projection omit them because the shared source protocol cannot represent them.
Normal Windows separators remain supported. Existing historical state/journals
are not rewritten; incorrectly recorded old aliases cannot be reconstructed
automatically. No authority, provider timeout or performance budget changes.

Six regression scenarios cover native nested paths, a colliding pair of real
POSIX files, feature seeds, explanation/impact, provenance/cloud projection,
and alternate-index identity with an unchanged user index. Five POSIX-only cases
are explicitly skipped on Windows, where literal backslashes cannot name files;
the native nested-path test runs on all platforms. CI repeats the scenarios
through the actual pinned Core and requires canonical admission for normal paths.

Local results retained in `evidence/NATIVE_PATH_IDENTITY_*`:

- `before.log`: first exploratory harness, four product failures and one test
  accessor error. This is not five established product failures.
- `baseline.log`: corrected accessor, five product failures out of six tests.
- `after.log`: first correction, one harness precondition error: without a
  read capability the existing task selector intentionally prefers the touched
  file over currentResource. The test now declares the actual read scenario.
- `final.log`: six PASS.
- `actual_core.log`: six PASS through the installed PM-012j Core wheel, with
  explicit canonical admission of the ordinary path and unaffected related file.
- `full.log`: 263 tests PASS, zero failures, zero skips on Linux.
- `manifest.json`: runtime source hashes and exact Core wheel identity.

This correction is independent of the earlier macOS YAML failure in
35848985745. That failure was not reproduced or explained here; this change
must not be presented as its root-cause resolution. PR #18 remains diagnostic
work. Private runner, full 100k budgets, coordinated release and HUMAN acceptance
are separate open gates. No Alpha, release, deployment or HUMAN PASS is claimed.

## Adjacent approval and ownership correction

Further probing found the same alias in CODEOWNERS matching and local policy
actions. With a project rule requiring review of writes, approving the literal
POSIX filename also approved its nested-path lookalike. The two failures are
retained in `adjacent_before.log`. A third regression (`approvals_before.log`)
shows that merely correcting new paths leaves old ambiguous grants usable.

CODEOWNERS and policy actions now preserve the native path too. The action
fingerprint includes `idleproof.action-identity.v2`, and effective policy material
advances to engineVersion 3. All old grants require a new explicit approval;
they are not deleted or silently reassigned. Current grants remain single-use
and bound to the exact current action. Existing project rules and conservative
capability detection are unchanged.

The final path suite has nine scenarios (seven POSIX-only, two portable).
`approvals_after.log` retains all 17 focused path/policy/ownership PASS results;
`actual_core_final.log` retains all nine path scenarios against the installed
Core. `full_final.log` retains the final complete suite. Earlier results remain
historical evidence for the earlier runtime tree. Cross-platform CI and review
must qualify the final head independently; initial PR run35893896077 was 16/16
SUCCESS on b4c5ccd and cannot qualify these additional runtime changes.

## Final-head CI failures and provenance follow-up

Run35894811674 on10850a0 completed14/16 jobs successfully; the unchanged Linux
Python hook gate failed p95=261.4ms against150ms. Its independent diagnostic
also failed (p95=262.3ms): 242 atomic rename calls consumed2563.97ms, with a
525.85ms maximum; 40 Core subprocesses consumed1958.84ms, maximum60.98ms.
These are measured filesystem delays in that diagnostic, not proof of a path
normalization slowdown, nor grounds for changing a budget or retrying to green.
The original and diagnostic observations are retained losslessly in the base64
gzip Linux job log. This latency incident remains unqualified.

The Windows Node24 concurrency job found31 provenance events instead of32,
despite all sessions being retained. Its raw log is retained too. It did not
print the stored recorder error, so the exact original syscall failure is not
known. The unchanged provenance lock still had a defect already repaired in
the separate state lock: an EPERM/EACCES/EBUSY after the old lock disappears
was treated as permanent. Fault injection reproduces a dropped append at this
boundary. It now retries acquisition within the original30s deadline, without
claiming ownership, retrying an append, or retrying ENOSPC/other storage errors.
The concurrency test keeps its32-event assertion and adds safe error-code-only
failure diagnostics. No exception text, command or raw event payload is logged.

`PROVENANCE_LOCK_before.log`: two failing boundary scenarios, one passing
permanent-storage scenario. `PROVENANCE_LOCK_after.log`: all three plus the
actual24-process/8-session concurrency scenario pass. The full final suite is
retained in `PROVENANCE_LOCK_full.log`. This demonstrates the lock correction,
not retrospective proof of the old Windows failure's exact cause. Both CI
failures and the older macOS YAML failure remain visible qualification risks.
