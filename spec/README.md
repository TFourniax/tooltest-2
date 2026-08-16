# IdleProof protocol specifications

IdleProof's open-core strategy depends on portable evidence rather than a proprietary dashboard format.

## Agentic Development Provenance (ADP)

The reference attestation is an in-toto Statement v1 wrapped in DSSE. Its subject is the SHA-256 of the observed working-tree diff. The predicate links that change to:

- agent/session metadata;
- changed-file footprint;
- runtime policy profile and policy digest;
- deterministic findings;
- human-assurance signals;
- maintenance-owner / responsibility evidence;
- tamper-evident Flight Recorder chain head;
- recorder signer fingerprint;
- Agent Bill of Materials.

Predicate identifier for this repository version:

`https://github.com/TFourniax/tooltest-2/spec/agentic-development-provenance/v1`

This does not claim SLSA compliance. It borrows established supply-chain primitives because agentic development provenance is conceptually adjacent to build provenance.

## Flight Recorder

`idleproof.event.v1` records are append-only JSONL objects linked by SHA-256. Payload contents are represented by a digest; raw prompts and tool inputs are omitted from the recorder by default.

## Agent BOM

`idleproof.agent-bom.v1` inventories observed agent sources, tools, MCP servers, permission modes, sessions, failures and policy interventions.

## Runtime policy

`idleproof.policy.v1` is deliberately small and deterministic. Rules match event/source/tool/command/path/**semantic capability** and resolve to `observe`, `ask`, or `deny`. The capability vocabulary is documented in [`capabilities.md`](capabilities.md) and enables privacy-preserving historical policy replay. Project rules compose with built-ins and the strongest effective decision wins.

## Interoperability direction

The schemas are designed so adapters can later map equivalent lifecycle fields to OpenTelemetry's evolving GenAI/agent semantic conventions. DSSE/in-toto remain the signed evidence envelope rather than overloading telemetry as an attestation format.
