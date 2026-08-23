import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 4777;

export function projectPaths(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const dir = path.join(root, '.idleproof');
  return {
    root,
    dir,
    state: path.join(dir, 'state.json'),
    stateBackup: path.join(dir, 'state.json.bak'),
    lock: path.join(dir, 'state.lock'),
    server: path.join(dir, 'server.json'),
    receipt: path.join(dir, 'receipt.json'),
    events: path.join(dir, 'events.jsonl'),
    chain: path.join(dir, 'chain.json'),
    provenanceLock: path.join(dir, 'provenance.lock'),
    identity: path.join(dir, 'identity.json'),
    identityKey: path.join(dir, 'identity.key'),
    identityPublic: path.join(dir, 'recorder.pub.pem'),
    attestation: path.join(dir, 'attestation.dsse.json'),
    evidence: path.join(dir, 'evidence-bundle.json'),
    agentBom: path.join(dir, 'agent-bom.json'),
    approvals: path.join(dir, 'approvals.json'),
    portalConfig: path.join(dir, 'portal.json'),
    portalQueue: path.join(dir, 'portal-queue.json'),
    portalQueueLock: path.join(dir, 'portal-queue.lock'),
    portalDeliveryHealth: path.join(dir, 'portal-delivery.json'),
    defitnessConfig: path.join(dir, 'defitness.json'),
    cursorTaskContext: path.join(dir, 'cursor-current-task.md'),
    policy: path.join(root, 'idleproof.policy.json'),
    claudeSettings: path.join(root, '.claude', 'settings.local.json'),
    codexHooks: path.join(root, '.codex', 'hooks.json'),
    cursorHooks: path.join(root, '.cursor', 'hooks.json'),
    cursorRule: path.join(root, '.cursor', 'rules', 'idleproof-continuity.mdc')
  };
}
