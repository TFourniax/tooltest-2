# IdleProof

**Your coding agent should make you faster — not make you a stranger to your own product.**

IdleProof is a free, local learning layer for Claude Code, Codex and terminal-based coding agents. It watches the task the agent is performing and turns natural wait windows into short lessons and one-tap questions about **the code being changed right now**.

```text
Claude Code is editing src/auth/session.ts

LIVE TASK LESSON · Authentication & sessions
≈ 24 sec

The task is “Add Google OAuth login and protect the admin route…”
The latest observed file is src/auth/session.ts.

While the agent changes the code in src/auth/session.ts:
Which check must still happen after a user is successfully authenticated?

[ Authorization for the requested action ]
[ CSS validation ]
[ Client-side route rendering ]
```

The goal is not to slow vibe coding down. The goal is to let people keep the speed of coding agents **without progressively losing the mental model of the software they own**.

## The product loop

```text
agent receives a task
        ↓
IdleProof observes prompt + lifecycle + touched files
        ↓
detects the concepts that matter now
        ↓
selects the highest-value learning opportunity
        ↓
turns the current wait window into a contextual lesson
        ↓
one-tap understanding check
        ↓
updates the user's project knowledge map
        ↓
next task adapts to what the user already understands
```

IdleProof currently distinguishes the agent's working phase — planning, inspection, implementation, verification, recovery and handoff — so the same concept can be taught differently depending on what is happening.

At handoff, the lesson changes from “here is a useful idea” to “before you accept this change, verify that you understand this boundary.”

## Why this is different from a coding course

IdleProof does not ask generic questions simply because you happen to use JavaScript.

It derives learning context from:

- the current user task;
- the coding agent and lifecycle event;
- tools currently being used;
- files actually touched;
- the real Git change at handoff;
- concepts previously encountered in this project;
- the user's demonstrated confidence on those concepts;
- risk, so auth, secrets, migrations and production changes matter more than trivia.

The built-in catalog currently covers authentication, SQL/transactions, migrations, async JavaScript, React state/effects, TypeScript boundaries, testing, secrets, HTTP/API contracts, dependencies, Git, CI/CD, concurrency, accessibility and caching.

The contextual layer is deterministic and local. **IdleProof does not require a paid LLM API to produce its core learning experience.**

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

For every active turn IdleProof can build a context object such as:

```json
{
  "task": "Add Google OAuth login and protect the admin route",
  "phase": "implement",
  "file": "src/auth/session.ts",
  "tool": "Write",
  "source": "claude"
}
```

That context is attached to the selected concept and used to produce the lesson, question and review action.

The current task also gets a learning journey:

```text
Authentication & sessions    learn-now   20%
HTTP & API contracts         building    52%
Testing strategy             mastered    84%
```

This is deliberately not a certification system. It is a memory of exposure and demonstrated recall designed to help the user decide what deserves attention.

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
- the files behind the lesson;
- a short review action tied to the actual file;
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

## Under the hood

IdleProof already contains more infrastructure than the learning UI needs because reliable context matters. These primitives stay secondary to the free learning experience:

- Claude Code and Codex lifecycle adapters;
- semantic capability normalization;
- local runtime policy with allow / observe / ask / deny;
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

See `SECURITY.md` for the exact trust boundaries.

## Free by design

IdleProof is MIT-licensed and designed to work without a hosted model bill. The distribution goal is simple: it should be easy enough that a vibecoder can install it once and then forget about the plumbing.

Future code-quality or verification products may integrate with IdleProof, but they should remain separate tools. IdleProof's own job is narrow:

> **Learn what your coding agent is building while it builds it.**

## Current limits

IdleProof can only observe lifecycle surfaces exposed by the underlying coding agent. It is not a sandbox, SAST replacement, formal verifier, malware detector, or proof that generated code is safe.

Its concept detection is currently heuristic and curated. The roadmap is to improve task decomposition, context selection, spaced recall and project-specific question generation while preserving a zero-cost local path.

## Development

```bash
npm test
npm pack --dry-run
```

CI validates Node.js 20 and 22.

## License

MIT.
