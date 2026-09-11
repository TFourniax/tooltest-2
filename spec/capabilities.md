# IdleProof semantic software capabilities v1

The runtime policy layer should not depend on one agent vendor's tool names or one shell command spelling. IdleProof therefore maps observed tool actions to a small set of **semantic software capabilities** before policy evaluation.

Status: experimental v1 vocabulary. It is intentionally small and expected to evolve through conformance fixtures rather than uncontrolled label growth.

## Source-control

- `scm.read` — inspect source-control state/history.
- `scm.commit` — stage/commit local changes.
- `scm.push` — publish changes to a remote.
- `scm.history_rewrite` — force-update remote history.
- `scm.local_destroy` — discard local work/history.

## Files/code

- `code.read` — read/search source.
- `code.modify` — write/edit source.
- `filesystem.catastrophic_delete` — high-blast-radius recursive deletion.

## Software supply chain / execution

- `dependency.install` — add/install dependencies.
- `test.execute` — execute test suites.
- `build.execute` — execute build/compile workflows.
- `shell.execute` — generic shell execution with no more-specific classification.
- `shell.remote_exec` — execute a fetched remote response through a shell.
- `network.fetch` — fetch/search remote data.

## Data

- `database.read`
- `database.mutate`
- `database.destructive`
- `database.migration`

## Delivery / sensitive domains

- `deploy.production`
- `deploy.nonproduction`
- `ci.modify`
- `secrets.write`
- `identity.modify`
- `financial.modify`

## Agent ecosystem

- `mcp.invoke` — call an MCP-exposed tool.

## Design rules

1. Capabilities describe **what the action can do in software-delivery terms**, not the product/tool that exposed it.
2. A single action may map to multiple capabilities.
3. Unknown actions remain observable; classification must not create a false guarantee that unclassified means safe.
4. Raw arguments may be sensitive. The Flight Recorder persists the normalized capabilities and a payload digest by default, not the raw command/tool payload.
5. Project policy can match capabilities with regexes, e.g. `^deploy\.production$` or `^(?:database|financial)\.`.
6. Capability classifiers are security-sensitive code. Changes to the built-in rules/classifier alter the effective policy hash.

## Replay semantics

Capability/path/tool/source facts are retained in the recorder and can be evaluated under a future policy. Rules that depend on raw `command` fields are marked non-replayable because the default recorder intentionally does not retain commands.

This tradeoff is deliberate: **privacy-preserving retrospective posture analysis** is more valuable than silently retaining every prompt and command.

## Interoperability

OpenTelemetry's GenAI semantic conventions standardize agent/tool execution telemetry but do not currently provide this software-delivery capability vocabulary. IdleProof should map its events to OpenTelemetry attributes/spans where possible and keep this capability field as an extension until a broader standard exists.

Cursor Agent Trace / Git AI and similar provenance formats solve a different problem (authorship attribution). IdleProof capability facts should be linkable to, not replace, those formats.
