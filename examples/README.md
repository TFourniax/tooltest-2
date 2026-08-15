# Examples

## Claude Code

From the target repository:

```bash
idleproof install claude
idleproof serve
```

IdleProof modifies `.claude/settings.local.json` only. Use `idleproof uninstall claude` to remove its entries.

## Generic terminal agent

```bash
idleproof serve
# second terminal
idleproof run -- codex
```

The generic wrapper sees task start/finish and the final Git footprint. Native integrations provide richer per-tool learning windows.

## Policy gate

```bash
idleproof check --max 20 --fail-on high
```

Use the exit code as one signal in a local pre-PR script. Do not treat it as a substitute for tests or security review.
