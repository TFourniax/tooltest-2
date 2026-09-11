import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();

function exec(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 30000,
    env: { ...process.env, ...(options.env || {}) },
    shell: Boolean(options.shell)
  });
}

function npm(args, options = {}) {
  return exec('npm', args, { ...options, shell: process.platform === 'win32' });
}

function git(cwd, ...args) {
  return exec('git', args, { cwd });
}

function runIdleProof(bin, cwd, ...args) {
  return exec(process.execPath, [bin, ...args], { cwd });
}

function containsIdleProofHook(value, mode) {
  const text=JSON.stringify(value);
  if (mode === 'claude') {
    return (text.includes('idleproof-hook.mjs') && text.includes(' claude')) ||
      (text.includes('idleproof.mjs') && text.includes(' hook'));
  }
  if (mode === 'codex') {
    return (text.includes('idleproof-hook.mjs') && text.includes(' codex')) ||
      (text.includes('idleproof.mjs') && text.includes('hook-codex'));
  }
  return false;
}

function containsAnyIdleProofHook(value) {
  const text=JSON.stringify(value);
  return text.includes('idleproof-hook.mjs') ||
    (text.includes('idleproof.mjs') && (text.includes(' hook') || text.includes('hook-codex')));
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-package-smoke-'));
let tarball = null;
try {
  const packed = JSON.parse(npm(['pack', '--json'], { cwd: ROOT }));
  if (!Array.isArray(packed) || !packed[0]?.filename) throw new Error('npm pack did not return an artifact filename');
  tarball = path.resolve(ROOT, packed[0].filename);
  if (!fs.existsSync(tarball)) throw new Error(`npm pack artifact missing: ${tarball}`);

  const consumer = path.join(temp, 'consumer');
  fs.mkdirSync(consumer, { recursive: true });
  npm(['init', '-y'], { cwd: consumer });
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: consumer, timeout: 60000 });

  const packageRoot = path.join(consumer, 'node_modules', 'idleproof');
  const bin = path.join(packageRoot, 'bin', 'idleproof.mjs');
  const hookBin = path.join(packageRoot, 'bin', 'idleproof-hook.mjs');
  const supportBin = path.join(packageRoot, 'bin', 'idleproof-support.mjs');
  if (!fs.existsSync(bin)) throw new Error('installed IdleProof package does not contain its CLI entrypoint');
  if (!fs.existsSync(hookBin)) throw new Error('installed IdleProof package does not contain its convergent IDE hook entrypoint');
  if (!fs.existsSync(supportBin)) throw new Error('installed IdleProof package does not contain its support diagnostic entrypoint');
  const help = runIdleProof(bin, consumer, '--help');
  if (!/understand what your coding agent is building/i.test(help)) throw new Error(`unexpected installed CLI help:\n${help}`);
  if (!/idleproof portal configure/.test(help)) throw new Error('installed CLI help does not expose Portal enrollment');

  const project = path.join(temp, 'project');
  fs.mkdirSync(project, { recursive: true });
  git(project, 'init', '-q');

  const stateDir=path.join(project,'.idleproof');
  fs.mkdirSync(stateDir,{recursive:true});
  const statePath=path.join(stateDir,'state.json');
  const historicalState=JSON.stringify({
    version:2,
    project:'upgrade-fixture',
    createdAt:'2026-01-01T00:00:00Z',
    updatedAt:'2026-01-02T00:00:00Z',
    preferences:{level:'adaptive',mode:'learn',sponsorCards:false},
    sessions:{old:{id:'old',prompt:'PRIVATE_UPGRADE_MARKER',events:[]}},
    features:{},ledger:{}
  },null,2)+'\n';
  fs.writeFileSync(statePath,historicalState,{encoding:'utf8',mode:0o600});

  const support = JSON.parse(runIdleProof(supportBin, project, '--json'));
  if (support.schema !== 'idleproof.support-diagnostic.v1') throw new Error('packaged support diagnostic returned an unexpected schema');
  if (support.product?.version !== '0.10.0') throw new Error(`packaged support diagnostic version mismatch: ${support.product?.version}`);
  for (const [key,value] of Object.entries(support.privacy || {})) {
    if (value !== false) throw new Error(`packaged support diagnostic privacy flag is not fail-closed: ${key}`);
  }
  const supportSerialized=JSON.stringify(support);
  if (supportSerialized.includes(path.resolve(project))) throw new Error('packaged support diagnostic leaked the absolute project path');
  if (supportSerialized.includes('PRIVATE_UPGRADE_MARKER')) throw new Error('packaged support diagnostic leaked historical prompt content');

  const portalIdentity = JSON.parse(runIdleProof(bin, project, 'portal', 'identity', '--json'));
  if (portalIdentity.schema !== 'idleproof.portal-identity.v1' || !/^[a-f0-9]{24}$/.test(portalIdentity.projectLocalId || '')) {
    throw new Error('packaged Portal identity command returned an invalid local project id');
  }
  const portalToken=`ipd_${'p'.repeat(32)}`;
  exec(process.execPath, [bin, 'portal', 'configure', '--endpoint', 'http://127.0.0.1:9/api/v1/snapshots', '--token-env', 'IDLEPROOF_PACKAGE_PORTAL_TOKEN'], {
    cwd:project,
    env:{ IDLEPROOF_PACKAGE_PORTAL_TOKEN:portalToken }
  });
  const portalStatus = JSON.parse(runIdleProof(bin, project, 'portal', 'status', '--json'));
  if (!portalStatus.configured || portalStatus.projectLocalId !== portalIdentity.projectLocalId) throw new Error('packaged Portal status did not retain enrollment');
  if (portalStatus.tokenLast4 !== 'pppp') throw new Error('packaged Portal status did not expose only the expected credential suffix');
  const portalSnapshot = JSON.parse(runIdleProof(bin, project, 'portal', 'snapshot'));
  if (portalSnapshot.schema !== 'idleproof.portal-snapshot.v1' || !/^ipsnap_[a-f0-9]{24}$/.test(portalSnapshot.snapshotId || '')) throw new Error('packaged Portal snapshot contract is invalid');
  const portalSerialized=JSON.stringify(portalSnapshot);
  if (portalSerialized.includes('PRIVATE_UPGRADE_MARKER') || portalSerialized.includes(portalToken)) throw new Error('packaged Portal snapshot leaked private local material');
  if (portalSnapshot.project?.localId !== portalIdentity.projectLocalId) throw new Error('packaged Portal snapshot and enrollment identity disagree');
  const enrolledSupport=JSON.parse(runIdleProof(supportBin, project, '--json'));
  const enrolledSupportSerialized=JSON.stringify(enrolledSupport);
  if (enrolledSupportSerialized.includes(portalToken) || enrolledSupportSerialized.includes('127.0.0.1:9')) throw new Error('support diagnostic leaked Portal endpoint or enrollment credential');
  if (enrolledSupport.portal?.configured !== true) throw new Error('support diagnostic did not report configured Portal state');
  runIdleProof(bin, project, 'portal', 'disconnect');
  if (JSON.parse(runIdleProof(bin, project, 'portal', 'status', '--json')).configured !== false) throw new Error('packaged Portal disconnect left enrollment configured');
  if (fs.readFileSync(statePath,'utf8') !== historicalState) throw new Error('Portal enrollment lifecycle changed historical IdleProof state');

  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const settingsPath = path.join(project, '.claude', 'settings.local.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    permissions: { allow: ['Bash(git status:*)'] },
    hooks: { Stop: [
      { hooks: [{ type: 'command', command: 'echo existing' }] },
      { hooks: [{ type: 'command', command: 'node /old-idleproof/idleproof.mjs hook', timeout: 5 }] }
    ] }
  }, null, 2));

  runIdleProof(bin, project, 'install', 'claude');
  const installedClaude = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (installedClaude.permissions?.allow?.[0] !== 'Bash(git status:*)') throw new Error('packaged installer changed existing Claude permissions');
  if (!containsIdleProofHook(installedClaude, 'claude')) throw new Error('packaged installer did not register the convergent IdleProof Claude hooks');
  if (!installedClaude.hooks.Stop.some((entry) => entry.hooks?.[0]?.command === 'echo existing')) throw new Error('packaged installer removed an existing Claude hook');
  if (JSON.stringify(installedClaude).includes('/old-idleproof/')) throw new Error('packaged Claude upgrade left an obsolete IdleProof executable path');
  if (installedClaude.hooks.Stop.filter((entry)=>containsIdleProofHook(entry,'claude')).length !== 1) throw new Error('packaged Claude upgrade duplicated the IdleProof Stop hook');
  if (!JSON.stringify(installedClaude).includes('idleproof-hook.mjs')) throw new Error('packaged Claude install did not upgrade to the convergent hook runner');
  if (fs.readFileSync(statePath,'utf8') !== historicalState) throw new Error('packaged Claude upgrade changed historical IdleProof state');

  runIdleProof(bin, project, 'uninstall', 'claude');
  const uninstalledClaude = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (!uninstalledClaude.hooks?.Stop?.some((entry) => entry.hooks?.[0]?.command === 'echo existing')) throw new Error('packaged uninstall removed a pre-existing Claude hook');
  if (containsAnyIdleProofHook(uninstalledClaude)) throw new Error('packaged uninstall left IdleProof Claude hooks behind');
  if (fs.readFileSync(statePath,'utf8') !== historicalState) throw new Error('packaged Claude uninstall changed historical IdleProof state');

  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  const codexPath = path.join(project, '.codex', 'hooks.json');
  fs.writeFileSync(codexPath, JSON.stringify({
    description: 'existing project hooks',
    hooks: { Stop: [
      { hooks: [{ type: 'command', command: 'echo codex-existing', timeout: 1 }] },
      { hooks: [{ type:'command', command:'node /old-idleproof/idleproof.mjs hook-codex', timeout:5 }] }
    ] }
  }, null, 2));

  runIdleProof(bin, project, 'install', 'codex');
  const installedCodex = JSON.parse(fs.readFileSync(codexPath, 'utf8'));
  if (!containsIdleProofHook(installedCodex, 'codex')) throw new Error('packaged installer did not register the convergent IdleProof Codex hooks');
  if (!installedCodex.hooks.Stop.some((entry) => entry.hooks?.[0]?.command === 'echo codex-existing')) throw new Error('packaged installer removed an existing Codex hook');
  if (JSON.stringify(installedCodex).includes('/old-idleproof/')) throw new Error('packaged Codex upgrade left an obsolete IdleProof executable path');
  if (installedCodex.hooks.Stop.filter((entry)=>containsIdleProofHook(entry,'codex')).length !== 1) throw new Error('packaged Codex upgrade duplicated the IdleProof Stop hook');
  if (!JSON.stringify(installedCodex).includes('idleproof-hook.mjs')) throw new Error('packaged Codex install did not upgrade to the convergent hook runner');
  const exclude = fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8');
  if (!exclude.split(/\r?\n/).some((line) => line.trim() === '.codex/hooks.json')) throw new Error('packaged Codex install did not exclude local hook config from Git');
  if (fs.readFileSync(statePath,'utf8') !== historicalState) throw new Error('packaged Codex upgrade changed historical IdleProof state');

  runIdleProof(bin, project, 'uninstall', 'codex');
  const uninstalledCodex = JSON.parse(fs.readFileSync(codexPath, 'utf8'));
  if (!uninstalledCodex.hooks?.Stop?.some((entry) => entry.hooks?.[0]?.command === 'echo codex-existing')) throw new Error('packaged uninstall removed a pre-existing Codex hook');
  if (containsAnyIdleProofHook(uninstalledCodex)) throw new Error('packaged uninstall left IdleProof Codex hooks behind');
  if (fs.readFileSync(statePath,'utf8') !== historicalState) throw new Error('packaged Codex uninstall changed historical IdleProof state');

  console.log(`IdleProof package smoke passed on ${process.platform}/${process.version} · Portal enrollment + convergent upgrade-safe Claude/Codex adapters + support diagnostic`);
} finally {
  if (tarball) {
    try { fs.rmSync(tarball, { force: true }); } catch {}
  }
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries:10, retryDelay:100 }); } catch {}
}
