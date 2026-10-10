# Optional Local OpenRouter interpretation

Status: implementation candidate. MACHINE transport/permission tests are separate from the unperformed HUMAN provider/cost/utility recipe in #33. No key belongs in ChatGPT, GitHub, Portal, a CLI argument, a screenshot or a test artifact.

Deterministic Core snapshots remain the input authority. The optional interpreter is invoked explicitly outside hooks. Configuration alone never starts a request. The user chooses the model and lifetime project budget; no default model or remembered tariff is used. Before a paid call, the client checks the current model listing and the dedicated key's provider-side cap. Unknown prices/caps fail closed. The transport has a 30-second deadline, input/output limits, no redirects, a maximum output token count and no automatic retries. A reservation survives uncertain/cancelled responses. Local estimated cost is not a billing guarantee; the dedicated OpenRouter key limit remains the independent hard limit.

The preview lists the exact captured snapshot, paths, source hashes and redacted evidence packet. Metadata-only is the default; adding source descriptions/selected-document excerpts requires an explicit preview option and acceptance of that preview's digest. Changed context invalidates consent. Project text is untrusted data. Returned claims require citations and remain INFERRED; no output is admitted into Proof, Debt Ledger, canonical declarations or human mastery. A citation establishes where supplied context came from, not that an interpretation is correct. The deterministic result remains available on every failure.

Credentials stay on the device: POSIX owner-only mode 0600, Windows DPAPI CurrentUser with encrypted bytes at rest. The CLI reads the credential from stdin only. Config/status/UI never return it. Rotation replaces it; local removal cannot revoke the provider-side key, which must also be revoked in OpenRouter by its owner.

Provider contract references checked 2026-10-10:

- https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
- https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
- https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key
- https://openrouter.ai/docs/guides/routing/provider-selection (max_price in dollars per million tokens)
- https://openrouter.ai/docs/guides/features/structured-outputs

Human qualification must use an operator-entered dedicated capped key in an isolated project. Check one successful request, a refused request, latency/tokens/provider-reported cost, redaction, cancellation, offline fallback and zero secret leakage. Compare factual correctness/usefulness to deterministic output on the generic corpus. An absent key does not block offline development, and a mocked response is never reported as a live provider PASS.

## CLI and consent workflow

Read a dedicated, provider-capped key from a password manager or secret-safe stdin
pipe. Do not use a command containing the literal key (including shell `echo`).
Run `idleproof ai configure --key-stdin --model <exact-model-id> --budget-usd 2
--max-request-usd 0.05 --max-tokens 800` in the project. All budget/model values are
explicit choices; this example does not promise a tariff. Rotation uses the same
command and preserves consumed/reserved budget. `idleproof ai remove` deletes the
local credential; revoke it separately at the provider.

- `idleproof ai status`: local configuration and reservation state; no key/network.
- `idleproof ai test --allow-network`: explicitly contact key/model endpoints,
  without project context or paid generation.
- `idleproof ai preview --file rules.py --question "Which boundaries need tests?"`:
  display the exact redacted packet and its digest locally.
- Add `--include-source` only to include bounded source descriptions and selected
  document excerpts; add `--include-memory` only to include bounded recorded Core
  context with event citations. Both are off by default.
- `idleproof ai explain` with exactly the same options and `--consent <digest>`:
  request interpretation after reviewing that preview. Changed scope/model/context
  invalidates consent. The cockpit exposes equivalent preview/send/cancel actions.

A successful interpretation records configured/reported model, latency, available
input/output tokens and provider-reported cost (null if absent), reservation and
S/M citations. Unchanged context reuses the cached response, including uncertain
paid failures: it does not silently retry or recharge. API refusals, invalid or
oversized responses, missing tariffs/provider cap, exhausted budgets, offline
service and cancellation retain the deterministic fallback. No response creates
canonical intent, Proof, technical debt or a quiz score.
