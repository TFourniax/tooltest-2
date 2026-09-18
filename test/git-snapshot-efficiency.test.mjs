import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {captureGitSnapshot} from '../src/analyze.mjs';
import {captureBaselineIdentity,finalizeChangeIdentity,__test} from '../src/change-identity.mjs';

const original=cp.execFileSync;
function git(cwd,...args) { return original('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true}).trim(); }
function fixture(t) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idle-snapshot-test-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true,maxRetries:8,retryDelay:50}));
  git(cwd,'init','-q');git(cwd,'config','user.name','Fixture');git(cwd,'config','user.email','fixture@example.test');
  fs.writeFileSync(path.join(cwd,'app.js'),'export const value = 1;\n');
  git(cwd,'add','.');git(cwd,'commit','-qm','base');
  return cwd;
}
function intercept(fn,body) {
  cp.execFileSync=fn;syncBuiltinESMExports();
  try {return body();} finally {cp.execFileSync=original;syncBuiltinESMExports();}
}

test('transient exclusion uses bounded Git work and preserves real index and tree', t=>{
  const cwd=fixture(t);
  const head=git(cwd,'rev-parse','HEAD^{tree}');
  fs.mkdirSync(path.join(cwd,'.idleproof'));
  for(let i=0;i<12;i++)fs.writeFileSync(path.join(cwd,'.idleproof',`cache[${i}].json`),'private runtime\n');
  const index=fs.readFileSync(path.join(cwd,'.git','index'));
  let processes=0;
  const snapshot=intercept((command,args,options)=>{processes++;return original(command,args,options);},()=>__test.snapshotTree(cwd));
  assert.equal(snapshot.tree,head);
  assert.deepEqual(fs.readFileSync(path.join(cwd,'.git','index')),index);
  assert.ok(processes<=7,`snapshot used ${processes} processes for transient files`);
});

test('failed transient exclusion cannot return an available change identity',t=>{
  const cwd=fixture(t);const baseline=captureBaselineIdentity(cwd);
  fs.mkdirSync(path.join(cwd,'.idleproof'));fs.writeFileSync(path.join(cwd,'.idleproof','state.json'),'runtime\n');
  const result=intercept((command,args,options)=>{
    if(command==='git' && (args.includes('reset') || args.includes('--pathspec-from-file=-')))throw new Error('injected exclusion failure');
    return original(command,args,options);
  },()=>finalizeChangeIdentity(cwd,baseline));
  assert.equal(result.available,false);
});

test('a real HEAD advance cannot attach an old commit to a new tree',t=>{
  const cwd=fixture(t);let advanced=false;
  const snapshot=intercept((command,args,options)=>{
    const result=original(command,args,options);
    if(!advanced && command==='git' && args.includes('rev-parse') && args.includes('HEAD')) {
      advanced=true;fs.writeFileSync(path.join(cwd,'app.js'),'export const value = 2;\n');
      git(cwd,'add','.');git(cwd,'commit','-qm','concurrent advance');
    }
    return result;
  },()=>__test.snapshotTree(cwd));
  assert.equal(advanced,true);
  if(snapshot.tree===snapshot.headTree)assert.equal(git(cwd,'rev-parse',`${snapshot.head}^{tree}`),snapshot.tree);
  else assert.equal(snapshot.sha,null);
});

test('batched diff and statistics preserve staged plus unstaged bytes and counts',t=>{
  const cwd=fixture(t);
  fs.writeFileSync(path.join(cwd,'app.js'),'export const value = 2;\n');git(cwd,'add','app.js');
  fs.writeFileSync(path.join(cwd,'app.js'),'export const value = 3;\n');
  const run=args=>original('git',args,{cwd,encoding:'utf8',windowsHide:true});
  const expected=run(['diff','--unified=0','--no-ext-diff'])+'\n'+run(['diff','--cached','--unified=0','--no-ext-diff'])+'\n';
  let processes=0;
  const snapshot=intercept((command,args,options)=>{processes++;return original(command,args,options);},()=>captureGitSnapshot(cwd));
  assert.equal(snapshot.diff,expected);assert.equal(snapshot.added,2);assert.equal(snapshot.deleted,2);
  assert.deepEqual(snapshot.files,['app.js']);assert.ok(processes<=3,`advisory snapshot used ${processes} processes`);
});

test('NUL-delimited status and statistics retain Unicode and renamed paths without invented aliases',t=>{
  const cwd=fixture(t);
  fs.writeFileSync(path.join(cwd,'café file.js'),'initial\n');git(cwd,'add','.');git(cwd,'commit','-qm','unicode');
  fs.renameSync(path.join(cwd,'café file.js'),path.join(cwd,'nouveau.js'));git(cwd,'add','.');
  const snapshot=captureGitSnapshot(cwd);
  assert.deepEqual(snapshot.files,['nouveau.js']);
  assert.equal(snapshot.added,0);assert.equal(snapshot.deleted,0);
  assert.match(snapshot.diff,/rename to nouveau.js/);
});

test('tracked runtime-named files and deletions remain meaningful, staged transient additions stay excluded',t=>{
  const cwd=fixture(t);
  fs.mkdirSync(path.join(cwd,'.idleproof'));fs.writeFileSync(path.join(cwd,'.idleproof','tracked.json'),'tracked\n');
  git(cwd,'add','.');git(cwd,'commit','-qm','explicit tracked file');
  fs.writeFileSync(path.join(cwd,'.idleproof','tracked.json'),'changed tracked\n');
  fs.unlinkSync(path.join(cwd,'app.js'));
  fs.writeFileSync(path.join(cwd,'.idleproof','runtime.json'),'temporary\n');git(cwd,'add','.idleproof/runtime.json');
  const before=fs.readFileSync(path.join(cwd,'.git','index'));
  const result=__test.snapshotTree(cwd);
  assert.deepEqual(fs.readFileSync(path.join(cwd,'.git','index')),before);
  const names=git(cwd,'ls-tree','-r','--name-only',result.tree).split('\n');
  assert.deepEqual(names,['.idleproof/tracked.json']);
  assert.equal(git(cwd,'show',`${result.tree}:.idleproof/tracked.json`),'changed tracked');
});
