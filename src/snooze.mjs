export function isConceptSnoozed(entry = {}, now = Date.now()) {
  if (!entry.snoozedUntil) return false;
  const until = Date.parse(entry.snoozedUntil);
  return Number.isFinite(until) && until > now;
}

export function taskConceptAvailability(state = {}, session = {}, now = Date.now()) {
  const concepts = Object.entries(session?.concepts || {});
  const available = {};
  const snoozed = [];

  for (const [id, detail] of concepts) {
    const entry = state.ledger?.[id] || {};
    if (isConceptSnoozed(entry, now)) snoozed.push({ id, until: entry.snoozedUntil });
    else available[id] = detail;
  }

  const resumeAt = snoozed
    .map((item) => item.until)
    .filter(Boolean)
    .sort()[0] || null;

  return {
    available,
    snoozed,
    paused: concepts.length > 0 && Object.keys(available).length === 0,
    resumeAt
  };
}

export function snoozeUntil(minutes = 10, now = Date.now()) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return null;
  const bounded = Math.max(1, Math.min(60, value));
  return new Date(now + bounded * 60_000).toISOString();
}
