# PM-013 slice — paged Portal memory export

`idleproof portal memory sync` (also run after every successful `portal flush`/`portal sync`,
including the background flush after hooks) exports the retained Core Project Memory journal to
Portal as `idleproof.portal-memory-page.v1`, oldest first, then only new events.

- Source: `dw state events --after N --expect-head H --limit L --json` (Core
  `project-event-page-1`). An older Core without paging is used only when it proves the complete
  journal (genesis included, fewer than 500 events); otherwise status is
  `source-unavailable / SOURCE_HISTORY_UNAVAILABLE`, never a partial export presented as complete.
- Projection: task/objective/decision/invariant/failed-approach assertions, DECLARED
  confirmations and recorded relations, with the snapshot identity and redaction rules. Payload
  text, other lifecycle transitions and Proof/Debt/Git/code events are counted in `omitted`.
- Coverage: every source event in a page range is either represented by at least one item or
  counted once in `omitted` (per event); items dropped from represented events (sensitive
  endpoints, page bounds) are counted in `partial`. Portal refuses a page that does not add up
  (`INCOMPLETE_COVERAGE`), so an acknowledged cursor can never skip history.
- Relations carry `sourceKind`/`targetKind` (the Core entity kinds; `null` outside Portal's kind
  set), so Portal never attaches a relation to another entity that only shares its opaque ID.
- Bounds: at most 256 items and 64 KiB per page (the snapshot wire limit is unchanged).
- Durability: the exact page is saved in `.idleproof/portal-memory.json` before sending; the
  cursor advances only after an ack that binds the same page, stream and range. A retransmission
  after a lost response is byte-identical and acknowledged as `duplicate`. A server cursor is
  adopted only after the local journal proves the same prefix. A restored page is re-validated
  before it is sent; its `generatedAt` (outside the page identity) must be a strict UTC timestamp.
- Journal identity: any page (even an empty one) naming another journal than the cursor's is
  `reset-required / JOURNAL_IDENTITY_CHANGED`, never `up-to-date`.
- Explicit states: `server-incompatible` (Portal without `memoryPages`), `deferred` (network,
  429, 5xx), `reset-required` (`LOCAL_PREFIX_DIVERGED`, `JOURNAL_IDENTITY_CHANGED`,
  `PREFIX_DIVERGED`), `identity-conflict`. `idleproof portal memory resync` starts a new stream
  epoch from event 0; Portal still deduplicates facts by exact event identity.
- Concurrency: every cursor update after local journal or network I/O requires the cursor it
  started from (same enrollment, journal, epoch and position). A result made stale by a
  concurrent resync, re-enrollment or another sync is dropped and reported as `superseded`.
  The Portal configuration is re-read before every state write and every send, and
  `portal configure`/`portal disconnect` take the cursor lock that also covers each request's
  initiation: once a change is committed no page is started with the old token, and a resync
  started under the old configuration is refused (`CONFIG_CHANGED`). A request already started
  before the change may still complete; its result is then dropped as `superseded`.
- Cursor lock: a directory published atomically with its owner file by rename (no hard links are
  needed) (`<pid> <incarnation> <token>`; the incarnation
  is the process start as the OS records it — Linux start tick, `ps`/Windows start time elsewhere,
  read once per process — so a recycled PID is not taken for the owner), never evicted by age, and
  recovered only when its owner provably no longer runs, under an exclusive claim that is itself a
  lock of the same kind. Claims left by evictors that died are recovered the same way, to any
  depth, so a crash never leaves the cursor permanently busy. When the owner's state cannot be
  determined the lock stays held and the command reports `IDLEPROOF_PORTAL_MEMORY_BUSY`.
  A PID reused within the OS start value's resolution (one second from `ps`) is indistinguishable;
  with sequential PID allocation that requires a full wrap of the PID space within that interval,
  and the effect is a lock that stays held (`BUSY`), never the eviction of a live owner.
- `portal memory status` reports the enrollment configured now: `not-configured` after
  disconnect, `not-started` (`ENROLLMENT_CHANGED`) after a new token or endpoint; an older cursor
  is shown only as `retained`.

Snapshot delivery (`idleproof.portal-snapshot.v1`) is unchanged.
