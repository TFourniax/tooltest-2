import fs from 'node:fs';
import { buildCurrentPortalSnapshot, disconnectPortal, flushPortalQueue, portalStatus, syncPortal, writePortalConfig } from './portal-client.mjs';
import { readChangeEnvelope, syncPortalAssurance } from './portal-assurance.mjs';

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

export function portalCliHelp() {
  return [
    'Portal:',
    '  idleproof portal identity [--json]',
    '  idleproof portal configure --endpoint URL --token-stdin',
    '  idleproof portal configure --endpoint URL --token-env ENV_NAME',
    '  idleproof portal status [--json]',
    '  idleproof portal snapshot',
    '  idleproof portal sync [--json]',
    '  idleproof portal assurance --envelope FILE [--json]',
    '  idleproof portal disconnect',
    '',
    'Portal config is project-local under .idleproof/, excluded from software change identity.',
    'Enrollment tokens are never accepted as command-line arguments, avoiding shell-history/process-list leaks.',
    'A configured enrollment token can only submit privacy-safe snapshots to one Portal project.',
    'DiffWitness assurance is accepted only when its exact dwchg_ identity matches the completed IdleProof change.',
    'If offline delivery ever loses history because its bounded queue is saturated, status becomes explicitly degraded rather than hiding the gap.'
  ].join('\n');
}

function readToken(args) {
  if (args.includes('--token-stdin')) return fs.readFileSync(0, 'utf8').trim();
  const envName = argValue(args, '--token-env');
  if (envName) return String(process.env[envName] || '').trim();
  throw new Error('Enrollment token must be supplied with --token-stdin or --token-env ENV_NAME; tokens are intentionally never accepted as command-line values.');
}

function print(value, json = false) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

export async function runPortalCli(args, { cwd = process.cwd() } = {}) {
  if (args[0] !== 'portal') return false;
  const cmd = args[1] || 'help';
  const json = args.includes('--json');
  const quiet = args.includes('--quiet');
  if (['help','--help','-h'].includes(cmd)) {
    console.log(portalCliHelp());
    return true;
  }
  if (cmd === 'identity') {
    const status = portalStatus(cwd);
    print(json ? { schema:'idleproof.portal-identity.v1', projectLocalId:status.projectLocalId } : status.projectLocalId, json);
    return true;
  }
  if (cmd === 'configure') {
    const endpoint = argValue(args, '--endpoint');
    if (!endpoint) throw new Error('Usage: idleproof portal configure --endpoint URL --token-stdin');
    const token = readToken(args);
    const status = writePortalConfig(cwd, { endpoint, token });
    if (json) print(status, true);
    else {
      console.log('✓ IdleProof Portal enrollment saved locally.');
      console.log(`  Endpoint: ${status.endpoint}`);
      console.log(`  Project ID: ${status.projectLocalId}`);
      console.log(`  Credential: ••••${status.tokenLast4}`);
      console.log('  Run `idleproof portal sync` to send the current bounded snapshot. Future completed tasks will queue and deliver automatically in the background.');
    }
    return true;
  }
  if (cmd === 'status') {
    const status = portalStatus(cwd);
    if (json) print(status, true);
    else if (!status.configured) {
      console.log(`IdleProof Portal: not configured · project ${status.projectLocalId}`);
    } else {
      console.log(`IdleProof Portal: ${status.healthy ? 'healthy' : status.degraded ? 'DEGRADED' : 'needs attention'}`);
      console.log(`  Endpoint: ${status.endpoint}`);
      console.log(`  Project ID: ${status.projectLocalId}`);
      console.log(`  Credential: ••••${status.tokenLast4}`);
      console.log(`  Pending snapshots: ${status.pending ?? 'unknown'}`);
      console.log(`  Unretained snapshots: ${status.skippedSnapshots ?? 'unknown'}`);
      if (status.lastErrorCode) console.log(`  Last delivery issue: ${status.lastErrorCode}`);
      if (status.degraded) console.log('  History completeness is degraded. Do not interpret the Portal timeline as exhaustive until this is investigated.');
    }
    return true;
  }
  if (cmd === 'snapshot') {
    print(buildCurrentPortalSnapshot(cwd), true);
    return true;
  }
  if (cmd === 'flush') {
    const result = await flushPortalQueue(cwd);
    if (!quiet) {
      if (json) print(result, true);
      else if (!result.configured) console.log('IdleProof Portal is not configured.');
      else if (result.ok) console.log(`✓ Portal queue flushed · ${result.delivered} delivered · ${result.pending} pending${result.degraded ? ` · DEGRADED (${result.skippedSnapshots} unretained)` : ''}`);
      else console.log(`Portal delivery deferred · ${result.errorCode || result.httpStatus || 'delivery failed'} · ${result.pending} snapshot(s) remain safely queued.`);
    }
    return true;
  }
  if (cmd === 'sync') {
    const result = await syncPortal(cwd);
    if (json) print(result, true);
    else if (!result.configured) console.log('IdleProof Portal is not configured. Run `idleproof portal configure --endpoint ...` first.');
    else if (result.ok) console.log(`✓ Portal sync complete · ${result.delivered} delivered · ${result.pending} pending · ${result.snapshotId}${result.degraded ? ` · DEGRADED (${result.skippedSnapshots} unretained)` : ''}`);
    else console.log(`Portal sync deferred · ${result.errorCode || result.httpStatus || 'delivery failed'} · ${result.pending} snapshot(s) remain safely queued.`);
    if (result.configured && result.ok === false) process.exitCode = 2;
    return true;
  }
  if (cmd === 'assurance') {
    const file=argValue(args,'--envelope');
    if (!file) throw new Error('Usage: idleproof portal assurance --envelope FILE');
    const envelope=readChangeEnvelope(file,cwd);
    const result=await syncPortalAssurance(cwd,envelope);
    if (!quiet) {
      if (json) print(result,true);
      else if (!result.configured) console.log(`✓ Assurance verified for ${result.changeId}; Portal is not configured, so nothing was uploaded.`);
      else if (result.ok) console.log(`✓ Portal assurance synced · ${result.changeId} · ${result.delivered} delivered · ${result.pending} pending`);
      else console.log(`Portal assurance deferred · ${result.errorCode || result.httpStatus || 'delivery failed'} · ${result.pending} snapshot(s) remain safely queued.`);
    }
    if (result.configured && result.ok === false) process.exitCode=2;
    return true;
  }
  if (cmd === 'disconnect') {
    disconnectPortal(cwd);
    console.log('✓ IdleProof Portal enrollment removed. Local learning state and queued snapshots were not deleted.');
    return true;
  }
  throw new Error(`Unknown portal command: ${cmd}\n\n${portalCliHelp()}`);
}
