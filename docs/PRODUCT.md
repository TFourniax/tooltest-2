# Product strategy

## Positioning

**IdleProof is Human CI for agentic software teams.**

The user should not need to switch agents. Claude Code, Codex, Gemini CLI, OpenCode, Cursor, and future agents are execution engines; IdleProof is the independent human-understanding layer that can sit above all of them.

The product is deliberately framed around accountability rather than education. “Learn while you wait” is a compelling activation loop. “Know which AI-generated changes your organization can actually own” is a much larger budget.

## Wedge

The first ten-minute experience should be:

1. `idleproof on` installs hooks, opens the local surface, and gives the terminal back;
2. start a normal agent task in that same terminal;
3. the browser changes instantly from idle to an estimated learning window;
4. the user receives one concept relevant to the task, not a generic lesson;
5. one-tap retrieval updates confidence;
6. when the task finishes, the learning surface collapses into a handoff with changed files and trust checks;
7. the user can copy/export a diff-bound proof receipt.

No signup, API key, model selection, or new IDE.

## Why the local core is free

The free product needs ubiquity. A proprietary per-seat teaching widget would compete directly with editors and agents that can add the same UI. A zero-cost local protocol can instead become the common evidence format around them.

Local-first also answers the strongest enterprise objection before the sales call: the base product does not upload code.

## Commercial layers

### Community — free

- local dashboard and ledger;
- Claude Code + Codex native lifecycle hooks;
- generic process wrapper;
- deterministic diff checks;
- proof receipts;
- local human-CI gates.

### Pro — suggested $9–15/month

- richer personalized curriculum;
- encrypted cross-device ledger sync;
- native adapters for multiple agents/editors;
- historical project maps;
- optional local or BYOK LLM enrichment;
- export templates for PRs/portfolios.

### Team — suggested $25–40/seat/month

- shared risk/coverage dashboard;
- GitHub/GitLab PR checks;
- domain ownership map: “who actually understands auth/billing/deploy?”;
- team policies and evidence retention;
- manager/tech-lead summaries;
- SSO and role controls.

### Enterprise — contract

- self-hosted control plane;
- audit/event export;
- policy packs for security-critical surfaces;
- data residency and retention controls;
- custom agent adapters;
- compliance evidence integration.

Pricing is a hypothesis to validate, not hard-coded into the core.

## Moat

The UI itself is not the moat. The strongest defensibility could compound from:

1. **Agent-neutral event adapters** — a stable normalization layer across fragmented agent runtimes.
2. **Cognitive-risk ontology** — mappings from real software changes to the human concepts and review boundaries that matter.
3. **Longitudinal ledger** — evidence of what a person/team has repeatedly encountered and demonstrated, with decay and task context.
4. **Policy graph** — which areas of a codebase require which verified knowledge and what evidence is acceptable.
5. **Outcome data** — with opt-in/team deployments, correlate debt patterns and proof signals with rework, incidents, review latency, and escaped defects.

A generic LLM can generate an explanation. Reconstructing years of trustworthy human-change evidence is harder.

## The bigger loop

```text
more agents → more code → more verification pressure
                     │
                     ▼
                IdleProof events
                     │
        ┌────────────┴─────────────┐
        ▼                          ▼
 opportunistic learning      assurance evidence
        │                          │
        ▼                          ▼
 stronger human model       smarter review routing/policy
        └────────────┬─────────────┘
                     ▼
               safer agent scale
```

The product wins if it makes organizations more comfortable increasing agent autonomy because the human assurance layer scales with it.

## Optional attention marketplace

There is a later monetization option close to the original idea: sponsor **useful** micro-lessons during genuine agent latency (a database vendor sponsoring an excellent transaction lesson, for example). It should be opt-in, clearly labeled, relevance-constrained, and never influence trust scores. Trust is more valuable than ad inventory, so this should never be the primary business model.

## Launch sequence

1. Open-source the local core and make install-to-first-window < 2 minutes.
2. Ship first-class Claude Code and Codex support because both expose rich local lifecycle events.
3. Add Gemini/OpenCode/native editor adapters as their stable event surfaces permit.
4. Publish a public “knowledge debt benchmark” over synthetic agent tasks, not private user code.
5. Add GitHub proof checks and shareable PR receipts.
6. Validate Team willingness-to-pay around review routing and sensitive-domain policies.
7. Only then build cloud analytics/SSO/billing.

## Success metrics

Avoid vanity “lesson views.” Measure:

- activation: first completed proof receipt;
- % of agent turns with at least one useful human interaction;
- debt repaid per minute of agent latency;
- return sessions/week;
- review time on agent-heavy PRs;
- rate of high-risk changes with a human proof signal;
- later: correlation between elevated debt and rework/incidents.

## Hard truth

No implementation can guarantee a “million/billion-dollar idea.” The current evidence supports a large and urgent category around agent-code validation, and IdleProof has a differentiated wedge after explicitly rejecting the obvious clone. Product-market fit, distribution, naming/trademark clearance, pedagogy validation, and enterprise willingness-to-pay still need real-world validation.
