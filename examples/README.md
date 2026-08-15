# Examples

## Claude Code

From the target repository:

```bash
idleproof install claude
idleproof serve
```

IdleProof modifies `.claude/settings.local.json` only. Use `idleproof uninstall claude` to remove its entries.

## Codex

```bash
idleproof install codex
idleproof serve
```

IdleProof writes project-local lifecycle configuration to `.codex/hooks.json` while preserving unrelated hooks. Codex requires non-managed command hooks to be reviewed/trusted: open `/hooks` in Codex once after install.

For a repository used with both:

```bash
idleproof on --agent all
```

## Generic terminal agent

```bash
idleproof serve
# second terminal
idleproof run -- gemini
```

The generic wrapper sees task start/finish and the final Git footprint. Native Claude Code and Codex integrations provide richer per-tool learning windows.

## Policy gate

```bash
idleproof check --max 20 --fail-on high
```

Use the exit code as one signal in a local pre-PR script. Do not treat it as a substitute for tests or security review.
