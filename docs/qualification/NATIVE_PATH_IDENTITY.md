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
