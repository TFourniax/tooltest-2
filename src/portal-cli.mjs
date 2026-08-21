import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { buildCurrentPortalSnapshot, disconnectPortal, portalStatus, syncPortal, writePortalConfig } from './portal-client.mjs';

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

export function portalCliHelp() {
  return [
    'Portal:',
    '  idleproof portal identity [--json]',
    '  idleproof portal configure --endpoint URL [--token-stdin|--token-env NAME]',
    '  idleproof portal status [--json]',
    '  idleproof portal snapshot [--json]',
    '  idleproof portal sync [--json]',
    '  idleproof portal disconnect',
    '',
    'Portal config is project-local under .idleproof/, excluded from software change identity.',
    'A configured enrollment token can only submit privacy-safe snapshots to one Portal project.'
  ].join('\n');
}

async function readToken(args) {
  if (args.includes('--token-stdin')) return fs.readFileSync(0, 'utf8').trim();
  const envName = argValue(args, '--token-env');
  if (envName) return String(process.env[envName] || '').trim();
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8').trim();
  const rl = readline.createInterface({ input, output });
  try { return String(await rl.question('Enrollment token (input is visible): ')).trim(); }
  finally { rl.close(); }
}

function print(value, json = false) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

export async function runPortalCli(args, { cwd = process.cwd() } = {}) {
  if (args[0] !== 'portal') return false;
  const cmd = args[1] || 'help';
  const json = args.includes('--json');
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
    if (!endpoint) throw new Error('Usage: idleproof portal configure --endpoint URL [--token-stdin|--token-env NAME]');
    const token = await readToken(args);
    const status = writePortalConfig(cwd, { endpoint, token });
    if (json) print(status, true);
    else {
      console.log('✓ IdleProof Portal enrollment saved locally.');
      console.log(`  Endpoint: ${status.endpoint}`);
      console.log(`  Project ID: ${status.projectLocalId}`);
      console.log(`  Credential: ••••${status.tokenLast4}`);
      console.log('  Run `idleproof portal sync` to send the current bounded snapshot.');
    }
    return true;
  }
  if (cmd === 'status') {
    const status = portalStatus(cwd);
    if (json) print(status, true);
    else if (!status.configured) {
      console.log(`IdleProof Portal: not configured · project ${status.projectLocalId}`);
    } else {
      console.log(`IdleProof Portal: ${status.healthy ? 'configured' : 'needs attention'}`);
      console.log(`  Endpoint: ${status.endpoint}`);
      console.log(`  Project ID: ${status.projectLocalId}`);
      console.log(`  Credential: ••••${status.tokenLast4}`);
      console.log(`  Pending snapshots: ${status.pending ?? 'unknown'}`);
    }
    return true;
  }
  if (cmd === 'snapshot') {
    const snapshot = buildCurrentPortalSnapshot(cwd);
    print(snapshot, true);
    return true;
  }
  if (cmd === 'sync') {
    const result = await syncPortal(cwd);
    if (json) print(result, true);
    else if (!result.configured) console.log('IdleProof Portal is not configured. Run `idleproof portal configure --endpoint ...` first.');
    else if (result.ok) console.log(`✓ Portal sync complete · ${result.delivered} delivered · ${result.pending} pending · ${result.snapshotId}`);
    else console.log(`Portal sync deferred · ${result.errorCode || result.httpStatus || 'delivery failed'} · ${result.pending} snapshot(s) remain safely queued.`);
    if (result.configured && result.ok === false) process.exitCode = 2;
    return true;
  }
  if (cmd === 'disconnect') {
    disconnectPortal(cwd);
    console.log('✓ IdleProof Portal enrollment removed. Local learning state and queued snapshots were not deleted.');
    return true;
  }
  throw new Error(`Unknown portal command: ${cmd}\n\n${portalCliHelp()}`);
}
