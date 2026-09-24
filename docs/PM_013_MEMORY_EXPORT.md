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
- Bounds: at most 256 items and 64 KiB per page (the snapshot wire limit is unchanged).
- Durability: the exact page is saved in `.idleproof/portal-memory.json` before sending; the
  cursor advances only after an ack that binds the same page, stream and range. A retransmission
  after a lost response is byte-identical and acknowledged as `duplicate`. A server cursor is
  adopted only after the local journal proves the same prefix.
- Explicit states: `server-incompatible` (Portal without `memoryPages`), `deferred` (network,
  429, 5xx), `reset-required` (`LOCAL_PREFIX_DIVERGED`, `JOURNAL_IDENTITY_CHANGED`,
  `PREFIX_DIVERGED`), `identity-conflict`. `idleproof portal memory resync` starts a new stream
  epoch from event 0; Portal still deduplicates facts by exact event identity.

Snapshot delivery (`idleproof.portal-snapshot.v1`) is unchanged.
