import { readProvenanceEvents } from './provenance.mjs';
import { evaluateNormalizedAction, loadPolicy } from './policy.mjs';

const WEIGHT = { allow: 0, observe: 1, ask: 2, deny: 3 };

export function replayPolicy(cwd = process.cwd(), { profile = null, limit = 100000 } = {}) {
  const base = loadPolicy(cwd);
  const selectedProfile = profile || base.profile;
  if (!['observe', 'balanced', 'strict'].includes(selectedProfile)) throw new Error('Replay profile must be observe, balanced, or strict.');
  const policy = { ...base, profile: selectedProfile };
  const records = readProvenanceEvents(cwd, { limit }).filter((record) => record.event?.eventType === 'PreToolUse');
  const impacts = [];
  const counts = { allow: 0, observe: 0, ask: 0, deny: 0, escalated: 0, relaxed: 0, unchanged: 0 };

  for (const record of records) {
    const event = record.event || {};
    const action = {
      event: event.eventType,
      source: event.source || 'agent',
      sessionId: event.sessionId || null,
      turnId: event.turnId || null,
      toolUseId: event.toolUseId || null,
      tool: event.tool || '',
      command: '',
      path: event.resource || '',
      permissionMode: event.permissionMode || null,
      capabilities: event.capabilities || []
    };
    const result = evaluateNormalizedAction(action, { cwd, policyOverride: policy, allowApprovals: false });
    const original = event.policy?.originalDecision || 'allow';
    counts[result.originalDecision] += 1;
    const before = WEIGHT[original] ?? 0;
    const after = WEIGHT[result.originalDecision] ?? 0;
    if (after > before) counts.escalated += 1;
    else if (after < before) counts.relaxed += 1;
    else counts.unchanged += 1;
    if (after !== before || after >= WEIGHT.ask) {
      impacts.push({
        sequence: record.sequence,
        at: event.at,
        source: event.source,
        tool: event.tool,
        resource: event.resource,
        capabilities: event.capabilities || [],
        previousDecision: original,
        replayDecision: result.originalDecision,
        risk: result.risk,
        matchedRuleIds: result.matches.map((match) => match.id),
        reason: result.reason
      });
    }
  }

  const nonReplayableRules = (policy.rules || [])
    .filter((rule) => rule?.enabled !== false && rule?.match?.command)
    .map((rule) => rule.id || 'unnamed-command-rule');

  return {
    schema: 'idleproof.policy-replay.v1',
    generatedAt: new Date().toISOString(),
    profile: selectedProfile,
    eventsEvaluated: records.length,
    counts,
    nonReplayableRules,
    replayCoverage: nonReplayableRules.length ? 'semantic-partial' : 'semantic-complete',
    impacts
  };
}
