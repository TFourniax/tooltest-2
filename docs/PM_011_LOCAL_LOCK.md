# PM-011 local lock contention correction

Acceptance before implementation, 2026-09-18. PR #8 exact-head run 35341450926
fails one of 16 jobs: Windows/Node 24 concurrent session test raises EPERM while
creating `.idleproof/state.lock`. The existing classifier retries EPERM only if
the lock still exists; its owner can have removed it before that second check.

Treat EEXIST/EPERM/EACCES/EBUSY from lock acquisition as retryable inside the
existing 15-second deadline, even if a subsequent existence check would see no
entry. Never enter the state mutation until mkdir and owner recording succeed.
Permanent errors must still fail visibly at the unchanged deadline; non-contention
errors fail immediately. No event may be dropped, no wait budget raised, and no
assertion weakened. Test the absent-entry transient race deterministically, the
permanent failure boundary, and the existing real 24-child/8-session provenance
journey. Archive both earlier CI failures.

This is local process concurrency only. It does not implement the separate
multi-writer replica reconciliation required by full PM-011. HUMAN NOT RUN.
