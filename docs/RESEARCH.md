# Research notes — 15 August 2026

This document records the scan that led to IdleProof. It is a product-research snapshot, not a claim that no adjacent product can ever exist.

## 1. The pain is real and increasingly named

Several independent signals point to the same bottleneck: agent output can grow faster than the human mental model and review capacity.

- **Agents That Teach (July 2026)** introduces *Knowledge Debt*: changes executed by agents that the developer cannot fully understand accumulate over time. The authors argue incidental learning must be deliberately designed back into agent workflows.  
  https://arxiv.org/abs/2607.06101
- **From Technical Debt to Cognitive and Intent Debt (March 2026)** argues that AI-assisted development should be reasoned about as technical debt in code, cognitive debt in people, and intent debt in externalized knowledge.  
  https://arxiv.org/abs/2603.22106
- Hacker News users describe losing track after only a few thousand lines of agent-generated code and explicitly discuss **verification debt**: more generated code without a corresponding increase in capable reviewers.  
  https://news.ycombinator.com/item?id=45880609  
  https://news.ycombinator.com/item?id=47289406
- Anthropic's June 2026 analysis of roughly 400,000 Claude Code sessions found that people typically make more planning decisions while Claude makes more execution decisions, while domain expertise still correlates with better outcomes. That supports the thesis that human understanding remains economically useful even as execution is delegated.  
  https://www.anthropic.com/research/claude-code-expertise

## 2. The user's initial “teach me while the agent works” idea is already occupied

We rejected a simple teaching clone.

### Contral

Contral explicitly markets itself as “the teaching layer for any AI coding agent,” with floating teaching cards, auto-teach on edits, Learn/Build modes, and proof/challenge mechanics. Its VS Code extension supports terminal agents including Claude Code and Codex.  
https://contral.ai/  
https://marketplace.visualstudio.com/items?itemName=Contral.contral

### Cognitive Coverage

The open-source `ryannadel/cognitive-coverage` project describes itself as “like test coverage, but for understanding.” It generates teaching guides, manifests, dashboards, quizzes, and an optional MCP server.  
https://github.com/ryannadel/cognitive-coverage

### Anthropic itself

Anthropic publicly positions Claude Code as an apprenticeship/learning surface and exposes lifecycle hooks that can deterministically react to prompts, tool use, and task completion.  
https://www.anthropic.com/education  
https://code.claude.com/docs/en/hooks

**Conclusion:** “show explanations while Claude works” is not a defensible wedge by itself.

## 3. Independent validation is becoming a valuable category

CodeRabbit announced a $143M round at a $1.5B valuation on 12 August 2026. Reuters reported more than 2 million reviews per week and 17,000+ customers. The investor thesis quoted by Reuters centers on independent governance/validation as AI becomes critical software infrastructure.  
https://www.reuters.com/technology/ai-code-review-platform-coderabbit-valued-15-billion-latest-funding-round-2026-08-12/

This does **not** prove IdleProof will be a billion-dollar company. It does show that the layer *around* AI-generated code—review, validation, governance—is already valuable enough to support venture-scale businesses.

## 4. The whitespace we chose

In this scan, we did **not** find a free product combining all of the following as its core primitive:

1. consumes the *live lifecycle* of an external coding agent rather than replacing it;
2. treats the agent's latency windows as schedulable human-attention inventory;
3. maintains a persistent risk-weighted **human knowledge-debt ledger**;
4. switches from learning to a compact handoff the moment the agent stops;
5. deterministically inspects the exact local diff, including untracked files;
6. emits a machine-readable proof receipt bound by SHA-256 to that diff; and
7. requires no LLM, account, cloud, or paid API for the core loop.

Adjacent products cover meaningful subsets. That is why IdleProof should compete on the **Human CI protocol**, not on generic explanations or courses.

## 5. Product hypothesis

> In an agentic organization, “did the code pass?” and “does an accountable human understand the risky parts?” become separate delivery signals.

If that thesis is right, the long-term product is bigger than developer education. It becomes an assurance/control plane:

- individuals see and repay their own knowledge debt;
- PRs carry evidence tied to a specific change;
- teams route high-risk changes to the humans with relevant verified context;
- organizations set policies for cognitive coverage on sensitive domains;
- training happens opportunistically inside paid working time rather than as a separate LMS workflow.

The wait-time lesson is the initial behavior change. **Human assurance is the category.**
