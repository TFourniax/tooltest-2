import fs from 'node:fs';
import { projectPaths } from './paths.mjs';
import { buildReceipt } from './hook.mjs';
import { createAttestation } from './attest.mjs';
import { buildAgentBom, signedCheckpoint, verifyProvenanceChain } from './provenance.mjs';
import { loadPolicy, policyHash } from './policy.mjs';
import { responsibilityReport } from './ownership.mjs';

export function createEvidenceBundle(cwd = process.cwd()) {
  const chain = verifyProvenanceChain(cwd);
  if (!chain.ok) throw new Error(`Cannot build evidence from an invalid provenance chain: ${chain.errors.join('; ')}`);
  const receipt = buildReceipt(cwd);
  const attestation = createAttestation(cwd);
  const checkpoint = signedCheckpoint(cwd);
  const bom = buildAgentBom(cwd);
  const policy = loadPolicy(cwd);
  const responsibility = responsibilityReport(cwd);
  const bundle = {
    schema: 'idleproof.evidence-bundle.v1',
    generatedAt: new Date().toISOString(),
    receipt,
    agentBillOfMaterials: bom,
    policy: { profile: policy.profile, source: policy.source, sha256: policyHash(cwd) },
    responsibility,
    provenanceCheckpoint: checkpoint,
    attestation
  };
  const file = projectPaths(cwd).evidence;
  fs.mkdirSync(projectPaths(cwd).dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return bundle;
}
