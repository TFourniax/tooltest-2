# PM-004 source admission: project-local, bounded UTF-8

Acceptance recorded before implementation on 2026-09-18.

The working-tree feature model must not import source text through a project
directory link whose resolved target is outside the project. Its import edges
must apply the same admission rule. Aliases to excluded state/dependency
directories must not bypass the existing exclusions. Internal source aliases
remain usable, including when the project root itself is an alias.

A source file is admitted only when it is a regular file, at most 128 KiB,
contains no NUL, and decodes as strict UTF-8. Reading uses a bounded descriptor
operation; a size check followed by an unbounded read is insufficient. A file
that changes identity, size, or modification metadata during the read is
discarded. Account actual admitted bytes against the existing 640 KiB budget.
Keep the existing 24-file and two-import-level bounds.

Tests use owned temporary fixtures, including an external sibling fixture with
a synthetic marker, internal directory aliases, invalid UTF-8, exact byte
boundaries, and controlled mutation between metadata inspection and reading.
No real private files are read. Run failure-first regressions, existing feature
and privacy tests, and the complete suite, followed by exact-commit CI.

This remains a bounded working-tree heuristic, not an immutable Git observation
or runtime proof. Canonical-path and descriptor checks reduce link/race risks;
they do not establish an OS-level sandbox against an adversarial filesystem.
HUMAN validation remains NOT RUN until performed by a person in real conditions.
