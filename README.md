# IdleProof

**Human CI for agentic coding.**

Coding agents can produce changes faster than a human can build a mental model of them. IdleProof turns the agent's own wait windows into short, contextual learning/review moments, tracks the resulting **knowledge debt**, and produces a diff-bound proof receipt when the turn ends.

It is not another coding agent and it does not proxy your model traffic. The local core observes lifecycle events, Git state, and the concepts touched by the work. No LLM, account, API key, or cloud service is required.

> **Status:** launchable local-core alpha. Claude Code and Codex have granular native lifecycle integrations; other terminal agents can be wrapped generically. The product thesis and competitive scan are documented in [`docs/RESEARCH.md`](docs/RESEARCH.md).

## The interaction

```text
Agent starts work
      │
      ├── IdleProof sees prompt/tool metadata
      │      └── opens a ~20–70 second learning window
      │
      ├── cards adapt to auth / SQL / tests / React / CI / etc.
      │      └── one tap proves or weakens confidence
      │
Agent stops
      │
      ├── local Git diff is scanned for high-signal trust risks
      ├── learning surface collapses into a handoff
      └── SHA-256 proof receipt binds the human ledger to that diff
```

The central metric is deliberately different from code quality:

```text
knowledge debt = Σ(risk × bounded exposure × uncertainty)
```

Tests can be green while knowledge debt is high. IdleProof makes that invisible condition visible.

## Why this is not “AI explains my code”

Existing teaching layers already explain AI edits. Existing cognitive-coverage tools create learning guides. Existing review agents inspect correctness. IdleProof's wedge is the **runtime coupling** of four things:

1. the agent's real lifecycle and latency window;
2. a persistent human knowledge-debt ledger;
3. deterministic trust checks over the actual local diff; and
4. a proof receipt cryptographically bound to that diff.

That makes understanding a first-class software delivery signal instead of a course you remember to take later.

## Quick start

Requires Node.js 20+ and Git.

```bash
# from this repository
npm link

# Claude Code (default)
idleproof on

# Codex
idleproof on --agent codex

# Both in the same repository
idleproof on --agent all
```

`idleproof on` starts the local dashboard on `127.0.0.1:4777` and installs only project-local lifecycle hooks, preserving existing agent configuration. Claude uses `.claude/settings.local.json`; Codex uses `.codex/hooks.json`. Codex requires project-hook trust, so open `/hooks` once in Codex to review and trust the IdleProof command before it can run.

For a zero-risk walkthrough:

```bash
idleproof demo
```

## Commands

```text
idleproof on [--agent NAME]   Install hooks + dashboard (claude|codex|all)
idleproof install claude      Install project-local Claude Code hooks
idleproof install codex       Install project-local Codex hooks
idleproof install all         Install both native integrations
idleproof uninstall claude    Remove only IdleProof Claude hooks
idleproof uninstall codex     Remove only IdleProof Codex hooks
idleproof uninstall all       Remove IdleProof hooks from both
idleproof serve [--port N]    Start the local dashboard
idleproof demo                Seed a demo session + dashboard
idleproof run -- <command>    Wrap any terminal agent/command generically
idleproof status              Show debt, coverage, latest agent state
idleproof receipt [--json]    Export the diff-bound proof receipt
idleproof check [options]     Run the human-CI gate
idleproof doctor              Check prerequisites and integration
idleproof reset               Delete .idleproof local state
```

### Human-CI gate

```bash
idleproof check --max 20 --fail-on high
```

The command exits with code `2` if knowledge debt exceeds the configured threshold or the completed turn contains a deterministic finding at/above the chosen severity (`low`, `medium`, `high`, `critical`). It is intentionally policy, not a claim that a quiz proves code is safe.

## Proof receipt

At the end of a turn IdleProof writes `.idleproof/receipt.json` (gitignore it by default). The receipt contains:

- the completed agent session and source;
- files and line-count footprint;
- deterministic review findings;
- concepts encountered and current confidence;
- knowledge debt / cognitive coverage; and
- `SHA-256` of the exact captured Git diff plus the current `HEAD`.

This gives teams a machine-readable object that can later be attached to PRs, policy engines, attestations, or a team control plane without uploading source code from the free local core.

## Claude Code integration

IdleProof uses Claude Code lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SessionEnd`). Hook input arrives as JSON and is processed synchronously by a tiny Node command.

Installation is **project-local** and idempotent. Existing Claude settings and hooks are preserved. Uninstall removes only IdleProof-owned entries.

## Codex integration

Codex is a first-class native adapter too. IdleProof writes `.codex/hooks.json` and subscribes to `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, and `SessionEnd`, including `Bash`, `apply_patch`/`Edit`/`Write`, and MCP tool activity. The exact same normalized ledger and receipts are used for Claude and Codex.

```bash
idleproof install codex
idleproof serve
# then, inside Codex: /hooks → review/trust IdleProof once
```

Installation is idempotent, preserves unrelated project hooks, and adds `.codex/hooks.json` to the repository's local `.git/info/exclude` when possible so the generated local integration does not become accidental source control noise.

## Other agents

Agents without a stable lifecycle hook API can still be wrapped at process level:

```bash
idleproof run -- gemini
idleproof run -- opencode
idleproof run -- your-agent
```

The generic wrapper captures task start/finish and the final Git footprint. It cannot see granular tool calls unless that agent exposes lifecycle events. The normalized event boundary is intentionally agent-neutral so additional native adapters do not fork the product model.

## Privacy and cost

The local core has **zero runtime dependencies** and makes **zero network requests**. Source code is read only to analyze the local Git diff. Persistent state lives under `.idleproof/` with restrictive file permissions where supported.

The dashboard binds to `127.0.0.1`, not the LAN. The core does not need an LLM because its first job is scheduling, measurement, deterministic checks, and retrieval from a curated concept catalog—not generating prose on every event.

See [`SECURITY.md`](SECURITY.md) for the threat boundary.

## Architecture

```text
Claude hooks / Codex hooks / generic wrapper
            │ JSON events
            ▼
      Event normalizer
            │
      ┌─────┴────────┐
      ▼              ▼
Concept detector   Git snapshot
      │              │
      ▼              ├── deterministic review rules
Knowledge ledger     └── SHA-256 diff proof
      │
      └──────────┬──────────────┐
                 ▼              ▼
          local dashboard   receipt.json
```

Core modules:

- `src/hook.mjs` — event lifecycle + receipts
- `src/analyze.mjs` — concept detection, Git snapshot, trust rules
- `src/state.mjs` — atomic local ledger with cross-process lock
- `src/install.mjs` — Claude Code hook installer
- `src/install-codex.mjs` — Codex hook installer
- `src/server.mjs` — dependency-free localhost dashboard/API
- `public/` — adaptive wait-window UI

## What is deliberately not in v0.2

- no cloud account or telemetry;
- no paid API dependency;
- no claim that multiple-choice recall equals engineering competence;
- no automatic blocking of the coding agent itself;
- no opaque LLM security scanner pretending to be deterministic.

Those constraints make the free core easy to trust and cheap to distribute. A commercial team layer can add shared policy, richer evidence, native adapters, SSO, and longitudinal risk analytics without making the local product hostage to a SaaS backend.

## Development

```bash
npm test
npm pack --dry-run
node ./bin/idleproof.mjs doctor
```

The test suite covers concept detection, wait-window estimation, untracked-file diff capture, deterministic trust findings, hook lifecycle, proof receipts, Claude/Codex hook install/uninstall preservation, and the live dashboard API.

## Product and market

See [`docs/PRODUCT.md`](docs/PRODUCT.md) for the open-core business model, moat, launch strategy, and expansion path. See [`docs/RESEARCH.md`](docs/RESEARCH.md) for the problem/competitor scan performed on 15 August 2026.

## License

MIT for the local core. This makes distribution frictionless; commercial differentiation should live in hosted/team capabilities, integrations, policy intelligence, and the network of verified human-understanding signals—not by crippling the local tool.
