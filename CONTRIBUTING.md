# Contributing

IdleProof's local core should stay small, auditable, and cheap to run.

Before opening a pull request:

```bash
npm test
npm pack --dry-run
```

Principles:

- prefer deterministic local primitives before adding an LLM call;
- do not add telemetry or network requests to the community core without an explicit opt-in design;
- preserve existing agent/editor configuration during install/uninstall;
- never present a learning score as proof of software correctness;
- add tests for new event adapters and trust rules;
- keep integrations agent-neutral at the normalized event boundary.
