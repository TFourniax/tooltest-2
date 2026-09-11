import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCurrentPortalSnapshot } from '../src/portal-client.mjs';
import { freshState, saveState } from '../src/state.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim();
}

test('two clones keep distinct local device ids while sharing one stable repository fingerprint', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-repo-identity-'));
  try {
    const source=path.join(root,'source');
    fs.mkdirSync(source);
    git(source,'init','-q');
    git(source,'config','user.email','identity@example.test');
    git(source,'config','user.name','Identity Test');
    fs.writeFileSync(path.join(source,'app.js'),'export const value = 1;\n');
    git(source,'add','-A');
    git(source,'commit','-qm','root commit');

    const deviceA=path.join(root,'device-a');
    const deviceB=path.join(root,'device-b');
    git(root,'clone','-q',source,deviceA);
    git(root,'clone','-q',source,deviceB);

    const stateA=freshState(deviceA);
    stateA.createdAt='2026-08-24T00:00:00.000Z';
    saveState(deviceA,stateA);
    const stateB=freshState(deviceB);
    stateB.createdAt='2026-08-24T00:00:01.000Z';
    saveState(deviceB,stateB);

    const snapshotA=buildCurrentPortalSnapshot(deviceA);
    const snapshotB=buildCurrentPortalSnapshot(deviceB);
    assert.match(snapshotA.project.repositoryFingerprint,/^dwrepo_[a-f0-9]{24}$/);
    assert.equal(snapshotA.project.repositoryFingerprint,snapshotB.project.repositoryFingerprint);
    assert.notEqual(snapshotA.project.localId,snapshotB.project.localId);

    fs.writeFileSync(path.join(deviceB,'app.js'),'export const value = 2;\n');
    const afterLocalEdit=buildCurrentPortalSnapshot(deviceB);
    assert.equal(afterLocalEdit.project.repositoryFingerprint,snapshotA.project.repositoryFingerprint,'worktree edits must not fragment project identity');
  } finally {
    fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});
  }
});
