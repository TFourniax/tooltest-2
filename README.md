# IdleProof

**Your coding agent should make you faster — not make you a stranger to your own product.**

IdleProof is a free, local learning layer for Claude Code, Codex and terminal-based coding agents. It watches the task the agent is performing and turns natural wait windows into short lessons and one-tap questions about **the code being changed right now**.

```text
Claude Code is editing src/stripe.ts

LIVE TASK LESSON · HTTP & API contracts
≈ 24 sec · quick lesson

Task: “Make handleStripeWebhook idempotent and verify the Stripe webhook signature.”
Observed locally:
  symbol      handleStripeWebhook
  route       /api/webhooks/stripe
  technology  Stripe

If Stripe retries /api/webhooks/stripe in handleStripeWebhook,
what property must this handler preserve?

[ Idempotency ]
[ Font weight ]
[ Source-map size ]

[ not now · 10 min ]
```

The goal is not to slow vibe coding down. The goal is to let people keep the speed of coding agents **without progressively losing the mental model of the software they own**.

## The product loop

```text
agent receives a task
        ↓
IdleProof observes task + lifecycle + semantic action + local code context
        ↓
detects the concepts that matter now
        ↓
selects the highest-value learning opportunity
        ↓
adapts depth to the actual wait window
        ↓
specializes the question to the current task / symbol / route / table
        ↓
one-tap understanding check — or “not now”
        ↓
updates the user's project knowledge map
        ↓
next task adapts to demonstrated mastery
```

IdleProof distinguishes planning, inspection, implementation, verification, recovery, reasoning and handoff. The same concept is therefore taught differently depending on what the agent is actually doing.

At handoff, the interaction changes from “learn this while the agent works” to “before you accept this change, verify that you understand this boundary.”

## Questions about *this* task, not generic coding trivia

IdleProof does not ask generic questions simply because you happen to use JavaScript.

It can ground a lesson in:

- the current task;
- the coding agent and lifecycle event;
- semantic activity such as `test.execute`, `build.execute`, `database.migration` or `code.modify`;
- the file currently being read or changed;
- locally extracted functions/classes;
- detected API routes;
- detected SQL tables;
- stack signals such as Stripe, Supabase, OAuth/OIDC, PostgreSQL, React, Next.js, Prisma, Redis, Playwright and others;
- the real Git change at handoff;
- concepts previously encountered in this project;
- the user's demonstrated confidence on those concepts;
- risk, so auth, secrets, migrations and production changes matter more than trivia.

For example, a generic HTTP lesson can become:

```text
If Stripe retries /api/webhooks/stripe in handleStripeWebhook,
what property must this handler preserve?
```

An OAuth lesson can become:

```text
After OAuth identifies the user in authorizeAdmin,
where must the permission check for the protected action still happen?
```

A migration lesson can target the actual table being changed and ask about rolling-deploy compatibility or rollback behavior.

This task specialization is deterministic and local. **The core learning experience does not require a paid LLM API.**

## It uses the time the agent actually gives you

IdleProof does not assume every wait is 30 seconds.

It adapts the lesson to the estimated window:

```text
~5–12 sec   → quick glance
~13–35 sec  → quick lesson
>35 sec      → deeper pass + concrete review move
task done    → handoff check
```

A short tool call gets a principle plus one tap. A longer build/test can carry a little more explanation and a concrete review action. The product should fit inside the agent workflow, not compete with it.

## “Not now” is not a wrong answer

Learning must not become another notification system users learn to hate.

Every live lesson can be snoozed:

```text
not now · 10 min
```

IdleProof then:

- does **not** lower confidence;
- does **not** count a wrong answer;
- temporarily removes that concept from selection;
- immediately offers another relevant concept from the same task if one exists;
- pauses learning only if every currently useful concept is snoozed;
- lets the user resume immediately.

The agent keeps working either way.

## Install

Requires Node.js 20+ and Git.

During development:

```bash
npm install
npm link
```

Then, inside a project you work on with Claude Code or Codex:

```bash
idleproof on
```

IdleProof installs the requested project-local hooks, starts its localhost learning cockpit and returns your terminal immediately. Continue using your coding agent normally.

The UI is served on `127.0.0.1`; source code does not need to be sent to an IdleProof service.

## What a live card knows

A live turn can now produce context like:

```json
{
  "task": "Make handleStripeWebhook idempotent and verify the Stripe webhook signature",
  "phase": "implement",
  "file": "src/stripe.ts",
  "target": "handleStripeWebhook in src/stripe.ts",
  "tool": "Bash",
  "capabilities": ["code.modify"],
  "signals": {
    "symbol": "handleStripeWebhook",
    "route": "/api/webhooks/stripe",
    "technologies": ["Stripe"]
  },
  "source": "claude"
}
```

The local context extractor is deliberately narrow: it reads only a project-local current file, refuses paths outside the project root, caps inspected files at 128 KiB, avoids binary files and returns signals rather than source code.

The current task also gets a learning journey:

```text
Authentication & sessions    learn-now   20%
HTTP & API contracts         building    52%
Testing strategy             mastered    84%
```

This is deliberately not a certification system. It is a memory of exposure and demonstrated recall designed to help the user decide what deserves attention.

## Spaced recall instead of repetition

IdleProof keeps a local learning ledger and avoids immediately repeating the same question just because a concept remains important.

Current review intervals expand with demonstrated confidence, from minutes for a weak concept to roughly a day for a strongly demonstrated one. Current-task relevance, risk, uncertainty, recent exposure and recent answers all influence which concept appears next.

## Knowledge Debt

IdleProof maintains a local cognitive ledger.

A simplified version of the current metric is:

```text
Knowledge Debt = Σ(risk × bounded exposure × uncertainty)
```

If your agent repeatedly modifies a high-risk domain that you never successfully review, the debt rises. If you demonstrate understanding over time, cognitive coverage rises.

The metric is a learning signal — **not proof that a person is competent and not proof that the code is correct**.

## Task-aware handoff

When the agent completes a turn, IdleProof captures the real Git change and can surface:

- concepts touched by the task;
- which ones are already mastered vs still weak;
- the files and symbols behind the lesson;
- a short review action tied to the actual change;
- deterministic findings worth noticing;
- the diff digest for the completed change.

The intended final interaction is simple:

```text
TASK COMPLETE

4 important concepts encountered
1 mastered
1 building
2 still worth reviewing

Next best review: Authentication & sessions
```

## Built-in learning domains

The curated catalog currently covers:

- authentication & authorization;
- SQL & transactions;
- migrations;
- async JavaScript;
- React state/effects;
- TypeScript boundaries;
- testing;
- secrets;
- HTTP/API contracts;
- dependencies;
- Git/change boundaries;
- CI/CD;
- concurrency;
- accessibility;
- caching.

Each domain has phase-aware applied questions for implementation, verification and handoff in addition to the underlying concept card.

## Under the hood

IdleProof already contains more infrastructure than the learning UI needs because reliable context matters. These primitives stay secondary to the free learning experience:

- Claude Code and Codex lifecycle adapters;
- semantic capability normalization;
- local runtime safety policy with allow / observe / ask / deny;
- a privacy-conscious append-only Flight Recorder;
- hash-chain integrity checks;
- local signed change evidence;
- Agent Bill of Materials;
- CODEOWNERS-aware responsibility mapping;
- policy replay.

Those systems help IdleProof know *what the agent is actually doing* and protect high-risk boundaries. They are not the primary product promise.

## Privacy

The learning cockpit is local-only by default.

The provenance recorder intentionally avoids storing raw prompt/tool payloads in its portable trace. It retains narrow metadata and digests instead. The local learning state may retain a compact task prompt because that context is what makes the lesson useful; it remains in the project's local `.idleproof` state.

Local task-signal extraction does not upload source code. See `SECURITY.md` for the exact trust boundaries.

## Free by design

IdleProof is MIT-licensed and designed to work without a hosted model bill. The distribution goal is simple: it should be easy enough that a vibecoder can install it once and then forget about the plumbing.

IdleProof's own job is narrow:

> **Learn what your coding agent is building while it builds it.**

## Current limits

IdleProof can only observe lifecycle surfaces exposed by the underlying coding agent. It is not a sandbox, SAST replacement, formal verifier, malware detector, or proof that generated code is safe.

Concept detection and free-form specialization are still intentionally heuristic/curated rather than unrestricted model generation. That keeps the default path local, deterministic and zero-cost while the project develops richer task decomposition and adaptive learning.

## Development

```bash
npm test
npm pack --dry-run
```

CI validates Node.js 20 and 22. The current suite covers contextual learning, semantic activity, local code signals, wait-window adaptation, task specialization, spaced recall, snoozing, hooks, provenance, policy, packaging and the localhost cockpit.

## License

MIT.
