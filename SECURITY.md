# Security

IdleProof is a control and evidence layer around coding agents. That makes its own trust boundary important.

## Community-core guarantees

- Dashboard binds to `127.0.0.1` only.
- No outbound network requests are required.
- No LLM/API credential is required.
- Git diffs are processed locally.
- Flight Recorder events store hashes/digests and narrow metadata rather than raw prompts, tool inputs or tool responses.
- Recorder private keys and state are stored under `.idleproof/` with restrictive permissions where supported.
- Static UI has no third-party dependencies and is served with a restrictive Content Security Policy.
- Agent hook installation is project-local, idempotent, and preserves unrelated hooks/settings.

## Runtime-policy boundary

Policy decisions are only as complete as the lifecycle events exposed by the agent. IdleProof cannot block an operation the underlying agent performs outside an observable/interceptable hook surface. `balanced` is not a sandbox. `strict` additionally fails closed for observable mutable tool calls when the recorder cannot persist evidence.

A policy `allow` is not a declaration that an operation is safe.

## Provenance and identity boundary

The SHA-256 event chain detects mutation/reordering/deletion relative to its recorded chain state. Ed25519 signatures make checkpoints and DSSE envelopes tamper-evident relative to the generated recorder identity.

The local recorder key is **self-asserted**. Accepting the public key embedded inside the same envelope proves integrity but not trusted identity. CI/security enforcement must pin an independently provisioned expected key (`idleproof verify ... --key ...`). Enterprise identity requires an organization-controlled trust root (KMS/HSM/workload identity/Sigstore-like federation), enrollment and key rotation.

Local responsibility acceptance is also self-asserted unless a future organization control plane verifies the principal/authority through an independent identity source.

## What IdleProof is not

IdleProof is not a sandbox, EDR, SAST replacement, secrets manager, malware detector, formal verification system, or proof that generated code is correct. Human-assurance scores are not certification of competence.

## Evidence handling

Evidence can reveal repository names, paths, agent/tool/MCP names, semantic capabilities, policy decisions and artifact hashes. Treat bundles as internal engineering/security metadata even though source code, raw prompts and raw commands are omitted by default.

## Reporting

Use a private GitHub security advisory for vulnerabilities that could expose source or keys, execute unintended commands, bypass deny decisions, corrupt provenance, modify unrelated agent configuration, or accept remote dashboard connections.
