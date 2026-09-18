# PM-P0-002 — Native runner preserves required assurance on sidecar failure

Acceptance before correction. The native runner invokes the advisory sidecar
before Core. An exception can reach its outer fail-open handler before required
Stop assurance is evaluated. Corrupt primary/backup state must not silently skip
the configured Core gate. Reproduce through the actual Claude and Codex runners.

Contain and report advisory lifecycle errors, then always evaluate configured Core
SessionStart/prompt/Stop handling. Required failures remain blocking. Preserve an
already produced Core result if optional Portal queueing fails. Standalone
IdleProof retains its advisory availability behavior. No fabricated Proof, no
automatic state deletion/recovery, no changed Core admission policy.

While reviewing this boundary, the input reader also converts each raw chunk to
text independently. A valid multibyte character split between chunks must be
decoded incrementally without modifying task identity. Test controlled split
chunks with the production reader and the real runner failure boundary.

Full existing tests, product/package/native interoperability and remote 16-job
qualification required. MACHINE only; HUMAN NOT RUN. Registry #74 remains canonical.
