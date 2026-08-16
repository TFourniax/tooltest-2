# IdleProof category thesis — Agentic Software Control Plane

## The category

The long-term company is not “education while Claude waits.” That is the consumer activation loop.

The category is **Agentic Software Control Plane**: the independent layer that governs, records and proves software changes executed by autonomous coding agents.

Traditional software delivery assumes a human is the primary actor and tools assist them. Agentic delivery reverses that assumption: agents increasingly plan, read, edit, invoke tools, call MCP services, run migrations and deploy. The scarce resource becomes trustworthy control and accountability, not keystrokes.

## Market signal

Research performed in August 2026 found several converging signals:

- GitLab's 2026 AI Accountability research reports that 85% of surveyed organizations say the bottleneck has shifted from writing code to reviewing/validating it; 84% describe governing what happens after code generation as the primary challenge; and 34% of organizations that had an incident could not determine whether AI-generated code contributed.
- Gartner predicts that by 2027 more than 65% of engineering teams using agentic coding will treat the IDE as optional, shifting control, governance and validation toward automated platforms.
- AI code-review companies are already reaching unicorn-scale valuations, proving budget exists around the verification layer rather than only the generation layer.
- Parallel startups are forming around agent authorization, observability and audit evidence. This validates the control-plane market but also means a PR report or generic trace viewer alone is not defensible.

The strategic implication: **own the cross-agent trust protocol and the longitudinal evidence graph, not merely a UI feature.**

## The wedge ladder

### 1. Zero-friction individual adoption

`idleproof on` must feel lighter than installing another IDE. It attaches to the agent the developer already uses, costs nothing to run, and immediately gives value from wait-time learning and a clear post-turn handoff.

### 2. Runtime firewall

IdleProof moves from post-hoc review to pre-execution control. The same normalized event stream works across Claude Code, Codex and future adapters. A company can express “agents may read this domain, but production deploys, destructive DB operations and protected paths require a human decision.”

### 3. Flight Recorder + Agent BOM

Every change gains an execution history and an inventory of agent/tool/MCP surfaces involved in its production. This creates an answer to questions Git alone cannot answer: *what autonomous system touched this, through which capability, under which permission mode and policy?*

### 4. Agentic Development Provenance standard

The portable unit is not a screenshot or proprietary dashboard export. It is a signed, machine-readable evidence format bound to the software artifact/change. IdleProof uses DSSE + in-toto as established envelope/statement primitives and adds an agentic-development predicate plus Agent BOM.

If CI vendors, Git hosts, security systems and agent runtimes can emit or consume this shape, IdleProof's open core becomes distribution for the hosted control plane.

### 5. Organization trust graph

The enterprise product sees relationships that no single agent vendor sees:

```text
person ─ understands ─ domain
agent ─ executed ─ tool/MCP
agent action ─ governed by ─ policy
change ─ produced by ─ execution chain
change ─ reviewed by ─ person/team
incident/rework ─ correlated with ─ prior evidence
```

Over time, this graph supports questions like:

- Which repositories are being modified by agents with the broadest permissions?
- Which MCP servers create the largest blast radius?
- Where do we have no accountable human coverage for frequently agent-modified critical domains?
- Which policy patterns predict rework or incidents?
- Which models/agents/tools actually reduce risk-adjusted cycle time?

That longitudinal, cross-vendor outcome graph is a stronger moat than generated explanations.

## Why the incumbent labs do not automatically win

Anthropic, OpenAI, Google and IDE vendors can each build excellent safety controls inside their own product. Their structural limitation is neutrality: an enterprise using multiple agents wants one policy/evidence layer above them, just as cloud customers still buy independent observability, security and identity products.

IdleProof must therefore stay agent-neutral and avoid proxying model traffic unless a customer explicitly chooses that architecture.

## Why this is not just Snyk, Datadog, Okta or an LMS

- **SAST/code review** examines artifacts; IdleProof also controls and records the actor/execution path.
- **Observability** tells you what happened; IdleProof can intervene before a high-risk action and bind the trace to a software change.
- **IAM** grants identities access; IdleProof applies software-delivery context and repository policy to agent tool use.
- **Training** teaches concepts; IdleProof uses learning evidence as one dimension of accountable ownership during real work.
- **GRC** collects controls/evidence; IdleProof creates first-party machine evidence at the moment an agent acts.

The convergence is the opportunity.

## Product architecture

### Local enforcement plane — open core

- native lifecycle adapters;
- policy engine;
- one-time approvals;
- append-only Flight Recorder;
- Agent BOM;
- Git change proof;
- deterministic checks;
- human-assurance ledger;
- DSSE/in-toto attestations;
- portable evidence bundles.

### Organization control plane — commercial

- policy distribution and inheritance;
- org-managed identities/signing roots;
- exception/approval workflows;
- evidence ingestion/retention/search;
- Git status checks and merge/deploy gates;
- agent/MCP/tool inventory;
- cross-repo ownership graph;
- incident reconstruction;
- dashboards and risk analytics;
- SSO/RBAC/SCIM;
- KMS/HSM and key rotation;
- self-hosted/data-residency modes.

### Intelligence plane — compounding moat

With explicit customer consent and privacy controls, learn which observable patterns correlate with:

- rollbacks;
- review latency;
- escaped defects;
- security incidents;
- excessive rework;
- unsafe permission escalation;
- low human ownership.

Policies can then move from static rules to evidence-backed recommendations without making an opaque LLM the enforcement root.

## Distribution strategy

1. Open-source the local core and protocol.
2. Become the easiest way to add guardrails to Claude Code + Codex.
3. Ship a GitHub Action and evidence artifact format.
4. Make Agent BOM / provenance visible in pull requests.
5. Add team cloud only when a team wants shared policy/retention, not to unlock basic functionality.
6. Encourage third-party adapters and policy packs.
7. Pursue integrations with Git hosts, agent vendors, security tools and compliance systems.

The free product should create the standard; the paid product should operate the standard at organizational scale.

## Business model

Potential paid units should map to enterprise value, not model-token usage:

- per active developer/agent seat for Team;
- repository/organization tiers for policy and evidence retention;
- enterprise platform contracts for SSO, KMS, self-hosting, data residency and audit integrations;
- optional usage dimension for high-volume evidence ingestion, not core local events.

This lets gross margin remain software-like because policy enforcement and evidence generation are deterministic/local by default.

## Anti-moat tests

We should reject roadmap items that fail these questions:

1. Can Claude/Codex add this feature natively in a month and erase our value?
2. Does the feature become more useful as a customer uses *more* agent vendors?
3. Does usage create a portable artifact, a policy dependency, or longitudinal evidence?
4. Does it improve enterprise control without requiring source/model traffic to pass through us?
5. Can the open core spread without increasing infrastructure cost linearly?

Micro-lessons pass #1 poorly but are excellent acquisition. Cross-agent policy/provenance passes all five.

## Milestones toward a category company

### Product-market wedge
- 1-command setup reliably survives real projects.
- <50 ms typical hook overhead for deterministic decisions.
- useful built-in policies with near-zero false blocking.
- evidence generated automatically on completed turns.
- developers voluntarily keep it installed.

### Team proof
- organizations create shared protected-domain policies;
- PR/deploy pipelines require valid evidence;
- security/engineering leads use the trace for real incident reconstruction;
- teams can quantify agent/MCP/tool exposure across repos.

### Standard proof
- third-party tools emit or consume the Agentic Development Provenance predicate;
- external policy packs/adapters exist;
- “show me the agent provenance” becomes a normal review request.

### Billion-dollar proof
The company reaches that trajectory only if the control/evidence layer becomes infrastructure across many agent vendors and software organizations. Revenue size is an outcome of category adoption—not something the current repository can honestly guarantee.
