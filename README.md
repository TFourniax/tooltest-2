# IdleProof

**Your coding agent should make you faster — not make you a stranger to your own product.**

IdleProof is the human-understanding layer for agentic software development. It observes what Claude Code or Codex is doing, inspects bounded project-local context, and explains **what the agent is changing, why it matters, where it lives in your project, and what could go wrong**.

The default experience is explanation-first. Technical checks are optional.

```text
YOU
"Receive a widget and store its event"

        ↓ coding agent works

IDLEPROOF LOCAL

What the agent is doing
The agent is changing the project to carry out
“Receive a widget and store its event”.

Where this happens in your project
`src/odd/entry.go`
  observed symbol: `ReceiveWidget`

`src/odd/storage.py`
  observed symbol: `save_widget`
  stored data: `widget_events`

Why it matters
The first file handles part of the incoming work. The second one
persists information that can outlive the current process.

What to keep in mind
If persistence happens twice, fails halfway through, or is retried,
the stored state still needs to remain correct.

[ check my understanding · optional ]
```

IdleProof keeps the **real project names**. If your file is called `weird_invoice_orchestrator_v7.py`, the explanation calls it `weird_invoice_orchestrator_v7.py`. If the available evidence does not justify a business role, IdleProof says so rather than inventing one.

---

## Explain now. Remember later.

IdleProof is designed as an open-core product with two distinct jobs.

### IdleProof Local / Community

The immediate product. Runs on the developer's machine.

- observe Claude Code / Codex lifecycle events;
- capture the current task;
- inspect bounded project-local files;
- retain exact filenames, functions/classes, routes, tables and dependencies when observed;
- explain the current task in plain language;
- show the current feature map;
- surface deterministic risks and local evidence;
- offer optional understanding checks;
- require no hosted model API for the core path;
- keep source code local by default.

Local answers:

> **What is my agent doing right now, and what does that mean in my project?**

### IdleProof Portal / Pro

The longitudinal product. The Portal implementation is intentionally outside this Community repository.

It is designed to add:

- persistent project history;
- Feature and Project Mental Models over time;
- Knowledge Debt history;
- understanding drift after a feature changes;
- spaced recall and optional personalized checks;
- multi-project and multi-device visibility;
- team/ownership views;
- DiffWitness proof history;
- Debt Ledger history;
- aggregated change intelligence.

Portal answers:

> **What has my agent built over the last weeks or months, what has changed, what was actually proven, and what do I still understand?**

The public runtime defines a versioned `idleproof.portal-snapshot.v1` boundary for this future sync. The snapshot is structured metadata: the contract explicitly excludes source code, raw diffs and raw agent-event payloads and redacts common secret patterns before data can cross the boundary.

---

## Why explanation comes before the quiz

A vibecoder cannot answer a useful technical question about something they have never been taught.

IdleProof therefore follows this order:

```text
1. What is the agent doing?
2. What does that mean in plain language?
3. Which exact parts of this project are involved?
4. What consequence or risk matters?
5. What should the owner remember?
6. Optional: check that the explanation was understood.
```

A user who never opens an understanding check should still get the core value of IdleProof.

Not answering a question is not treated as proof that the user failed to understand something.

---

## Install

Requires Node.js 20+ and Git.

During development:

```bash
npm install
npm link
```

Inside a project:

```bash
idleproof on
```

IdleProof detects an existing Claude Code or Codex project adapter when possible, installs project-local hooks without replacing unrelated settings, starts the localhost cockpit and returns control to the terminal.

The cockpit binds to `127.0.0.1`. If the default port is occupied, `idleproof on`/`start` can select another local port automatically unless the user explicitly requested a fixed port.

---

## What IdleProof observes

IdleProof combines evidence rather than depending on one hard-coded list of business cases.

Current signals include:

- the user's real task;
- agent lifecycle and semantic action (`code.modify`, `test.execute`, `database.migration`, etc.);
- exact touched-file paths;
- functions/classes/symbols extracted from several common language families;
- API/HTTP routes when statically observable;
- SQL/ORM data surfaces when statically observable;
- external package/module references;
- recognized frameworks and services;
- multiple files touched during the same task;
- the Git change at handoff;
- related files in a bounded static Feature Model.

The context extractor currently recognizes useful structures across JavaScript/TypeScript, Python, Go, Rust, Java/Kotlin/C#-style declarations, Ruby/PHP-like functions, SQL/config files and other text files. Unknown extensions do not crash the product: IdleProof falls back to exact file-level facts and bounded inference.

The point is not to claim perfect semantic compilation for every language. The point is to extract enough **verifiable local facts** to explain a very large variety of real tasks without hallucinating a fake architecture.

---

## Facts vs inference

IdleProof deliberately separates what it observed from what it inferred.

Examples:

```text
Observed
- file `src/odd/storage.py`
- symbol `save_widget`
- table `widget_events`

Inferred
- this file is probably close to persistence/data responsibilities
```

If a file called `src/x7/frobnicator.zzz` has no useful structural signal, IdleProof does **not** rename it “payment service”, “controller”, or anything else. It explains that the file was touched and that its exact business responsibility is not supported by the available evidence yet.

That conservative behavior is part of the product contract.

---

## Example: a non-hard-coded integration

The system does not need a bespoke template for every provider.

Suppose the project contains:

```text
src/vendor/strange_bridge.mjs
```

and the file references:

```text
@unknown-co/signing-kit
```

IdleProof can say that `strange_bridge.mjs` is the observed file, that `signWithVendor` is the symbol being changed, and that the file references `@unknown-co/signing-kit` — even if that vendor has never appeared in IdleProof's built-in technology catalog.

Known concepts such as authentication, concurrency, caching, migrations or API retries add a plain-language explanation when detected, but exact project evidence remains the anchor.

---

## Current Feature Model

IdleProof Local can build a bounded static map of the feature currently being touched:

```text
actual route/file
      ↓
actual imported file
      ↓
actual service/data surface
      ↓
external dependency / table
      ↓
related test
```

This map is useful context, **not a runtime call graph**. The UI says so explicitly.

Historical feature memory, feature drift, Project Mental Model history and long-term Knowledge Debt belong to the Portal product rather than the Local cockpit.

---

## Optional understanding checks

Checks remain useful after an explanation, especially for someone who wants to learn or retain the system.

They are collapsed by default in the Local cockpit behind actions such as:

```text
check my understanding · optional
check this feature map · optional
```

The current deterministic learning catalog covers areas such as:

- authentication/authorization;
- persistent data and transactions;
- migrations;
- asynchronous work;
- React state/effects;
- TypeScript/runtime boundaries;
- testing;
- secrets;
- HTTP/API behavior;
- dependencies;
- change scope;
- CI/CD;
- concurrency/shared state;
- accessibility;
- caching.

These concepts enrich the explanation; they do not define the universe of tasks IdleProof can describe.

---

## Privacy and the Portal boundary

Source code is processed locally by the Community runtime.

The portable provenance trace intentionally stores narrow metadata/digests rather than raw prompt/tool payloads. Local state can retain compact task context because that is needed to explain the project to its owner.

For future Portal synchronization, the Community runtime already defines a privacy-oriented snapshot contract with fields for task summary, exact project-relative paths, feature surfaces, proof digest and understanding metrics. It explicitly declares:

```json
{
  "sourceCodeIncluded": false,
  "rawDiffIncluded": false,
  "rawAgentEventsIncluded": false,
  "secretsRedacted": true
}
```

The Portal backend should accept this narrow contract rather than requiring repository source ingestion by default.

See `SECURITY.md` and `spec/idleproof-portal-snapshot-v1.schema.json` for boundaries.

---

## DiffWitness and Debt Ledger

IdleProof explains. DiffWitness proves.

```text
IdleProof
"This change modifies `reserveInventory` and stored reservations.
The important risk is two buyers changing the same stock at once."

DiffWitness
"Here is the executable evidence showing which mutations are necessary
for the discriminating behavior we tested."

Debt Ledger
"Here are the obligations this change introduced or left unresolved."
```

The long-term Portal is designed to join those three views by stable change identity without turning explanation into proof or proof into a vague AI review.

---

## Reliability boundaries

IdleProof is intentionally fail-safe and bounded:

- project-local path traversal is refused;
- inspected files have size/count limits;
- binary files are skipped;
- localhost HTTP writes enforce Host/Origin/cross-site protections;
- local state uses atomic writes and last-known-good recovery;
- stale server/PID records are checked before processes are acted on;
- hook installation preserves unrelated Claude/Codex settings;
- provenance is hash-chained and tampering is visible;
- static explanations never claim runtime proof;
- unfamiliar projects degrade to exact observed facts rather than invented certainty.

IdleProof is not an OS sandbox, SAST replacement, formal verifier or guarantee that generated code is correct. DiffWitness and real tests cover a different trust question.

---

## Quality gates

The project is tested as a product, not only as a library.

Current gates include:

- Node 20/22/24 on Linux, macOS and Windows;
- exact `npm pack` artifact installation/uninstallation;
- first-run Local journey with real CLI hooks;
- port collision and crash/restart recovery;
- state/provenance corruption recovery behavior;
- ExplainBench: 30 cross-domain scenarios including unusual filenames, unknown SDKs, Go/Rust/Java/C++/Swift-style cases, jobs, queues, migrations, infra, storage, search, uploads, CLI and config;
- explicit anti-hallucination assertions;
- contextual learning-quality checks;
- privacy-contract tests for Portal snapshots.

Run locally:

```bash
npm test
node scripts/explainbench.mjs
node scripts/idlebench.mjs
node scripts/idlebench-corpus.mjs
npm pack --dry-run
```

---

## Repository / commercial boundary

This repository contains the IdleProof Local / Community runtime and public interoperability contracts. It is currently MIT-licensed.

The hosted Portal, longitudinal intelligence and commercial service implementation are intended to live in a separate proprietary codebase. Keeping that implementation separate is deliberate: Community should remain independently useful while paid value comes from durable project memory, longitudinal intelligence and hosted/team workflows rather than crippling the immediate local explanation.

## License

MIT.
