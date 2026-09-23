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

Task-context symbols and imports use the shared Core providers for Python and,
with Core's optional `structure` installation, JavaScript/TypeScript, Go, Rust,
Java/Kotlin/C#, Ruby/PHP, SQL and JSON/TOML/YAML.
Missing grammars or invalid syntax produce explicit empty unparsed coverage.
Missing/older Core retains labelled heuristic fallback for code languages;
SQL/config task facts stay empty when unavailable. Configuration task symbols are
escaped key paths, without values; SQL task tables are named DDL declarations.
These data sources do not feed code route/table/technology heuristics. Neutral
`importReferences` retain raw canonical targets; the new managed/dynamic languages
do not classify unresolved imports as third-party dependencies. Explanations show
neutral import names with unresolved origins; current and related import changes
refresh delivery without turning those names into package-ownership claims.

The feature map also requests the shared detailed import contract: references
retain source hashes and available positions/member names, while unique local
candidate links remain INFERRED. SQL/config feature facts use admitted DDL/key
syntax, never configuration values. Every build rereads bounded sources instead
of reusing a mutable session-keyed model. Coverage records unavailable/unparsed
providers and truncated facts; limits remain24 files,640KiB and depth2, with a
shared500ms extraction budget. Older/missing Core uses labelled code heuristics.
Code-language route/table/technology heuristics remain explicitly INFERRED;
Literal CommonJS and dynamic import references use the same Core contract;
known loader shadowing stays unresolved. Complete canonical surfaces, computed
loaders and package origins remain open.
Unknown extensions retain file facts and bounded inference. Syntax observations do not establish runtime behavior or Proof.

The point is not to claim perfect semantic compilation for every language. The point is to extract enough **verifiable local facts** to explain a very large variety of real tasks without hallucinating a fake architecture.

---

## Facts vs inference

IdleProof deliberately separates what it observed from what it inferred.

Local paths retain their native identity. On Linux/macOS a literal backslash in
a filename is not treated as a directory separator. Such names remain visible
in local metadata and meaningful Git changes, but source extraction and portable
Portal paths omit them because the shared source protocol cannot represent them.
Windows directory separators continue to map to portable `/` paths. Existing
historical observations are not rewritten by this correction.
Local policy approvals created before this correction must be granted again:
their old path identity could be ambiguous. CODEOWNERS matching and new approvals
use the preserved native path; an approval for one file cannot name its lookalike.

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

For technical inspection of Project Memory, `idleproof feature-lineage` can link
locally retained feature observations to file-relocation hypotheses imported by
DiffWitness Core. It requires a Core version with `state lineage` (qualified
reference `6ea6fbbec251fe06b55b7852ca7822b4b40705c4`). Import the relevant Git
history with `dw state bootstrap-git --all-branches --include-lineage`, following
its cursor when more pages remain, then inspect:

```bash
idleproof feature-lineage --list --json
idleproof feature-lineage --from OLD_KEY --to NEW_KEY --json
idleproof feature-lineage --from OLD_KEY --to NEW_KEY --language fr
```

Both features must already have source-bound observations captured during normal
use. Old memories without those observations remain unavailable. Up to eight
distinct observations per feature are retained; discarded observations and result
limits are reported. The command queries imported history without changing the
state or importing more history. Its **INFERRED** links cite observation IDs and
Core event IDs, hashes and commits. They relate recorded snapshots with the same
anchor bytes, and do not establish current applicability, feature intent, symbol
identity or complete lifetime history. Keys, learning scores, declarations and
Proof authority stay separate. The Local cockpit and Portal product boundaries
above are unchanged by this technical inspection command.

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
