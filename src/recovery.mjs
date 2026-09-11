import fs from 'node:fs';
import path from 'node:path';
import { CURRENT_STATE_VERSION } from './state.mjs';
import { projectPaths } from './paths.mjs';

function readCandidate(file) {
  try {
    const raw=fs.readFileSync(file,'utf8');
    const parsed=JSON.parse(raw);
    if (!parsed || typeof parsed!=='object' || Array.isArray(parsed)) return { present:true, valid:false, reason:'not-object', raw:null, version:null };
    const version=parsed.version ?? 1;
    if (!Number.isInteger(version) || version<1) return { present:true, valid:false, reason:'invalid-version', raw:null, version:null };
    if (version>CURRENT_STATE_VERSION) return { present:true, valid:false, reason:'newer-version', raw, version };
    return { present:true, valid:true, reason:null, raw, version };
  } catch (error) {
    if (error.code==='ENOENT') return { present:false, valid:false, reason:'missing', raw:null, version:null };
    return { present:true, valid:false, reason:'unreadable', raw:null, version:null };
  }
}

function recoveryRoot(cwd) {
  const gitDir=path.join(cwd,'.git');
  return fs.existsSync(gitDir) ? path.join(gitDir,'idleproof-recovery') : path.join(cwd,'.idleproof-recovery');
}

function atomicWrite(file,content) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.${Date.now()}.repair.tmp`;
  try {
    fs.writeFileSync(temp,content.endsWith('\n') ? content : `${content}\n`,{encoding:'utf8',mode:0o600});
    fs.renameSync(temp,file);
  } finally {
    try { fs.rmSync(temp,{force:true}); } catch {}
  }
}

export function inspectRecovery(cwd=process.cwd()) {
  const paths=projectPaths(cwd);
  const primary=readCandidate(paths.state);
  const backup=readCandidate(paths.stateBackup);
  let action='none';
  let recoverable=false;
  if (!primary.present && !backup.present) {
    action='none';
    recoverable=true;
  } else if (primary.valid) {
    action='none';
    recoverable=true;
  } else if (primary.reason==='newer-version') {
    action='upgrade-required';
  } else if (backup.valid) {
    action=primary.present ? 'archive-and-restore-backup' : 'restore-backup';
    recoverable=true;
  } else {
    action='manual-recovery-required';
  }
  return {
    schema:'idleproof.recovery-plan.v1',
    currentStateVersion:CURRENT_STATE_VERSION,
    primary:{present:primary.present,valid:primary.valid,reason:primary.reason,version:primary.version},
    backup:{present:backup.present,valid:backup.valid,reason:backup.reason,version:backup.version},
    action,
    recoverable
  };
}

export function repairLocalState(cwd=process.cwd(),{dryRun=false}={}) {
  const plan=inspectRecovery(cwd);
  if (dryRun || plan.action==='none') return {...plan,changed:false,archive:null};
  if (plan.action==='upgrade-required') {
    const error=new Error(`IdleProof state version ${plan.primary.version} is newer than this runtime supports (${CURRENT_STATE_VERSION}). Upgrade IdleProof; repair will not downgrade it.`);
    error.code='IDLEPROOF_REPAIR_UPGRADE_REQUIRED';
    throw error;
  }
  if (!['archive-and-restore-backup','restore-backup'].includes(plan.action)) {
    const error=new Error('No verified compatible IdleProof backup is available. Refusing to reset or overwrite learning history.');
    error.code='IDLEPROOF_REPAIR_NO_BACKUP';
    throw error;
  }

  const paths=projectPaths(cwd);
  const backup=readCandidate(paths.stateBackup);
  if (!backup.valid || !backup.raw) throw new Error('Backup changed during repair; refusing to continue.');
  let archive=null;
  if (plan.action==='archive-and-restore-backup' && fs.existsSync(paths.state)) {
    const root=recoveryRoot(cwd);
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    archive=path.join(root,`${stamp}-${process.pid}-corrupt-state.json`);
    fs.copyFileSync(paths.state,archive);
  }
  atomicWrite(paths.state,backup.raw);
  return {...inspectRecovery(cwd),changed:true,archive:archive ? path.relative(cwd,archive).replaceAll('\\','/') : null,restoredFromBackup:true};
}
