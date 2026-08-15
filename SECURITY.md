# Security

IdleProof's free core is designed to minimize trust requirements.

## Data boundary

- The dashboard binds to `127.0.0.1` only.
- The core makes no outbound network requests.
- No model/API key is required.
- Git diffs are processed in the local Node.js process.
- State and receipts are written under `.idleproof/`. The detached dashboard stores only its localhost port and PID in `.idleproof/server.json`.
- `.claude/settings.local.json` is used for Claude integration so installation remains local to the project/machine.
- `.codex/hooks.json` is used for Codex integration. Codex independently requires non-managed command hooks to be reviewed/trusted before execution.
- When possible IdleProof adds its generated `.codex/hooks.json` to `.git/info/exclude`; this does not override an already-tracked file.

## What IdleProof is not

IdleProof is **not** a security scanner, SAST replacement, sandbox, permission boundary, or proof that generated code is correct. Deterministic trust rules are deliberately narrow, explainable warnings. A passing IdleProof check cannot establish software safety.

## Hook installer

The installer preserves existing settings and hooks and is idempotent. Uninstall removes only entries whose command is owned by the IdleProof CLI.

## Reporting

Please open a private security advisory on the GitHub repository for vulnerabilities that could expose source code, execute unintended commands, overwrite unrelated Claude or Codex settings, or accept remote connections unexpectedly.
