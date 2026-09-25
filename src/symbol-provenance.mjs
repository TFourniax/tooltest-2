// Every task signal produced by extraction declares its structureCoverage. A symbol whose coverage is
// explicitly non-canonical was matched in text (a language without a provider): it is a candidate that
// explanations may name as such, never an observed code location, subject or summary anchor.
export const symbolIsCandidate = (signals = {}) => Boolean(signals?.symbol && signals.structureCoverage && signals.structureCoverage.canonical !== true);
export const observedSymbol = (signals = {}) => signals?.symbol && !symbolIsCandidate(signals) ? signals.symbol : null;
