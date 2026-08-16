# IdleProof

**The local accountability kernel and control plane for agentic software delivery.**

Coding agents are becoming execution engines. IdleProof sits around them and adds the independent layer a multi-agent software organization needs: **pre-execution policy, tamper-evident execution provenance, change-bound signed evidence, maintenance responsibility, and human assurance.**

The community core is local-first: no model proxy, no account, no API key, no runtime dependency and no outbound network requirement.

```text
intent
  │
  ▼
agent runtime ─► semantic capability ─► runtime policy ─► allow / ask / deny
  │                                      │
  ├──────────────────────────────────────┴─► Flight Recorder (hash chain)
  │                                             │
  │                                             ├─ Agent BOM
  │                                             ├─ policy replay
  │                                             └─ signed checkpoint
  │
  ├─ wait window ─► Human Assurance / knowledge-debt repayment
  │
  └─ code change ─► exact Git diff proof ─► CODEOWNERS/responsibility
                                              │
                                              ▼
                                  DSSE + in-toto attestation
                                              │
                                              ▼
                                      Evidence Bundle
```

## Why this is bigger than “learn while the agent works”

Wait-time learning is still a strong individual activation loop: the agent works while the developer receives a short concept/review intervention relevant to the task. But the enterprise problem is larger. As code generation accelerates, the bottleneck moves toward **control, validation, provenance and accountability**.

IdleProof therefore treats learning as one signal in a broader assurance system rather than the product boundary. The core question becomes:

> **What autonomous system changed this software, what capabilities did it exercise, which policy allowed it, what exact artifact resulted, and which human/team is accountable for maintaining it?**

See [`docs/MARKET_2026.md`](docs/MARKET_2026.md) and [`docs/THESIS.md`](docs/THESIS.md).

## Quick start

Requires Node.js 20+ and Git.

```bash
npm link

# Claude Code
idleproof on

# Codex
idleproof on --agent codex

# both
idleproof on --agent all
```

`idleproof on` installs project-local hooks, starts the localhost cockpit in the background, opens it, then immediately returns the terminal. Codex requires a one-time `/hooks` trust review.

## 1. Runtime firewall

IdleProof intercepts observable `PreToolUse` events before execution. Policies use semantic software capabilities rather than only vendor-specific tool names or command strings.

Examples:

- `scm.history_rewrite`
- `database.destructive`
- `deploy.production`
- `secrets.write`
- `ci.modify`
- `database.migration`
- `dependency.install`
- `mcp.invoke`

Built-in `balanced` policy blocks narrow catastrophic actions and escalates high-risk mutations. `strict` further escalates high-risk observations and fails closed for mutating actions when the Flight Recorder cannot persist evidence.

```bash
idleproof policy show
idleproof policy init balanced
idleproof policy init strict
```

Project policy is reviewable/versionable as `idleproof.policy.json` and may match event, source, tool, path, command or semantic capability.

Claude can surface a native `ask` decision. Codex does not currently expose hook-level `ask`, so IdleProof fails closed and provides a short-lived approval fingerprint:

```bash
idleproof approve 7c1b0f99ab21d3e2
```

For agents without native hooks, `idleproof run -- <agent>` applies the same preflight policy before the wrapped process starts.

## 2. Privacy-preserving Policy Replay

The Flight Recorder stores semantic capability/path/tool/source facts but not raw commands. That allows a security team to test a future policy against historical execution without retaining prompts/commands:

```bash
idleproof policy replay strict
idleproof policy replay strict --json
```

Rules depending on raw `command` fields are explicitly reported as non-replayable rather than silently pretending to have complete historical coverage.

## 3. Flight Recorder

Each normalized lifecycle event is appended to `.idleproof/events.jsonl` and chained to the previous event with SHA-256. Verification detects mutation, deletion/reordering relative to the chain state, or a mismatched head.

```bash
idleproof trace
idleproof verify
```

By default the recorder stores:

- lifecycle event / agent source / session;
- tool and relative target;
- semantic capabilities;
- MCP server/tool metadata;
- command executable, not full command;
- payload digest/size, not raw prompt/tool payload;
- policy decision/risk/rule IDs;
- failure state.

## 4. Agent Bill of Materials

```bash
idleproof bom
```

The Agent BOM inventories observed agent sources, tools, MCP servers, permission modes, capabilities, sessions, failures and policy interventions, anchored to the recorder chain head.

It is observational evidence from the local recorder, not proof that an agent vendor/model identity is genuine.

## 5. Responsibility Layer

Attribution alone does not answer who owns the software in production. After a completed change, IdleProof maps touched files through `CODEOWNERS`, applies risk weighting to sensitive domains, and creates explicit maintenance obligations.

```bash
idleproof responsibility
idleproof accept
idleproof accept --as alice@example.com
```

Acceptance is bound to the exact diff SHA-256 and recorder-signed. **Local acceptance is self-asserted.** An enterprise control plane must federate identity/authority through GitHub/SSO/SCIM/WebAuthn or equivalent before treating it as strong organizational approval.

## 6. Signed Agentic Development Provenance

When a turn completes, IdleProof links:

- exact Git diff SHA-256 + source `HEAD`;
- agent execution chain;
- effective policy SHA-256 (including built-ins);
- semantic Agent BOM;
- deterministic findings;
- human-assurance context;
- maintenance responsibility state.

It emits an in-toto Statement wrapped in DSSE and signed with a local Ed25519 recorder identity:

```bash
idleproof attest
idleproof identity export --out .idleproof-trust/recorder.pub.pem
idleproof verify .idleproof/attestation.dsse.json --key .idleproof-trust/recorder.pub.pem
```

The public key embedded in an attestation proves cryptographic integrity only. **A real trust decision must pin/provision the expected public key independently.** The included GitHub Action therefore requires `public-key`.

## 7. Evidence Bundle

```bash
idleproof evidence
```

The portable `idleproof.evidence-bundle.v1` combines:

- diff-bound receipt;
- Agent BOM;
- effective policy digest;
- responsibility report;
- signed Flight Recorder checkpoint;
- DSSE/in-toto attestation.

No source code or raw prompt is required in the portable bundle.

## 8. Human Assurance

Real agent latency is converted into contextual micro-learning/review. A persistent ledger models:

```text
knowledge debt = Σ(risk × bounded exposure × uncertainty)
```

This is evidence of interaction/recall, **not** proof of engineering competence or code safety.

## Assurance gates

```bash
idleproof check --max 20 --fail-on high
idleproof check --max 20 --fail-on high --require-attestation --require-owner
```

A gate can fail on excessive cognitive debt, deterministic findings, broken provenance, missing/invalid attestation, or uncovered high-risk ownership obligations.

## GitHub Action

```yaml
- uses: TFourniax/tooltest-2@main
  with:
    attestation: .idleproof/attestation.dsse.json
    public-key: .idleproof-trust/team-recorder.pub.pem
```

The trusted public key must be provisioned independently of the evidence being verified.

## Open protocol strategy

The goal is not to own a proprietary dashboard format. IdleProof exposes protocol material under [`spec/`](spec/):

- `idleproof.policy.v1`
- semantic software capability vocabulary
- `idleproof.event.v1` Flight Recorder records
- `idleproof.agent-bom.v1`
- `idleproof.agentic-development-provenance.v1`
- `idleproof.evidence-bundle.v1`

DSSE/in-toto are reused for signed evidence. OpenTelemetry's evolving GenAI/agent semantic conventions should be consumed for telemetry interoperability. AI authorship formats such as Agent Trace/Git AI are complementary inputs; IdleProof should not reinvent AI `git blame`.

## Commercial expansion

The free local kernel should maximize distribution. Enterprise value sits above it:

- organization-managed policy distribution/inheritance;
- KMS/HSM/workload-identity trust roots and key rotation;
- SSO/RBAC/SCIM + verified responsibility acceptance;
- evidence ingestion, retention, search and incident replay;
- GitHub/GitLab merge/deploy gates;
- cross-repository agent/MCP/capability inventory;
- organization responsibility/ownership graph;
- policy shadow rollout and fleet-wide replay;
- correlations between agent behavior, policy, ownership, review latency, rework, incidents and rollbacks;
- self-hosting, residency and audit integrations.

The long-term moat is the cross-vendor graph:

```text
intent → agent capability → policy decision → exact change → accountable owner → outcome
```

A model vendor can copy a quiz or a local hook. A multi-vendor longitudinal accountability graph, protocol ecosystem and organizational policy dependency are harder to replace.

## Commands

```text
idleproof on / start / stop / serve / demo
idleproof install|uninstall claude|codex|all
idleproof run -- <command>
idleproof policy show|init|replay
idleproof approve <fingerprint>
idleproof trace / bom / responsibility / accept
idleproof receipt / attest / evidence / verify
idleproof identity show|export
idleproof status / check / doctor / reset
```

## Security and privacy

The community core binds to `127.0.0.1`, makes no required outbound request, has zero runtime dependencies, stores private recorder material locally and ships a restrictive CSP with no third-party UI assets. Read [`SECURITY.md`](SECURITY.md) before treating IdleProof evidence as a security control.

## Development

```bash
npm test
npm pack --dry-run
node ./bin/idleproof.mjs --help
```

## License

MIT for the local core. Distribution is the strategy; organization-scale trust, policy operation, evidence intelligence and governance are the commercial layer.
