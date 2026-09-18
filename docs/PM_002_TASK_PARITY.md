# PM-002c — Native task Unicode and length parity

Acceptance before implementation; base qualified IdleProof main e008a720 and Core
de248b10. Core registry #74 remains canonical. Both native producers must identify
the same task for the same session, ordinal and accepted prompt prefix.

Core already accepts the first 12,000 Unicode code points for native task identity,
digest and length, then keeps at most 1,200 code points of compact temporary
anchor/focus. IdleProof currently hashes the full prompt and counts/slices UTF-16
code units. This splits long-prompt identities and can cut a surrogate pair.

Preserve Core's existing task-v1 identity algorithm and admission bounds. Align
IdleProof native task input with the same 12,000-code-point prefix; use code-point
counts and compact limits, with Python-compatible Unicode whitespace. Digest and
length describe the accepted prefix, not the entire raw prompt. No normalization
of accents or line endings before identity hashing. Unsupported non-scalar input
is outside this valid-Unicode interoperability claim.

Existing saved task identities/anchor metadata must never be rewritten by a weak
follow-up. A new explicit task boundary uses the corrected contract. Historical
divergence is not retroactively relabeled as agreement. Keep legacy receipt prompt
metadata separate and unchanged; no new raw prompt or digest export to Portal.

Required: failing long/non-BMP/prefix-boundary/whitespace regressions, live Core
native CLI + task history parity, follow-up/pivot behavior, bounded surrogate-safe
anchors, full IdleProof suite/16 remote jobs, exact-main verification. All scripted
journeys are MACHINE; HUMAN NOT RUN. Full PM-002/010 remain broader work.
