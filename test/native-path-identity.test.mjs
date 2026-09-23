import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readProjectSource} from '../src/project-source.mjs';
import {extractTaskSignals} from '../src/context.mjs';
import {buildFeatureModel} from '../src/feature-model.mjs';
import {buildChangeImpact} from '../src/project-model.mjs';
import {buildPlainExplanation} from '../src/explain.mjs';
import {summarizeEvent} from '../src/provenance.mjs';
import {buildPortalSnapshot} from '../src/portal-snapshot.mjs';
import {captureBaselineIdentity} from '../src/change-identity.mjs';
import {captureGitSnapshot} from '../src/analyze.mjs';
import {parseCodeowners,ownersForPath} from '../src/ownership.mjs';
import {evaluatePolicy,grantApproval,initPolicy,normalizeAction} from '../src/policy.mjs';

function fixture(t) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-path-identity-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  fs.mkdirSync(path.join(cwd,'part'));
  fs.writeFileSync(path.join(cwd,'part','file.py'),'def nested_symbol():\n    return 2\n');
  if(process.platform!=='win32') fs.writeFileSync(path.join(cwd,'part\\file.py'),'def literal_symbol():\n    return 1\n');
  return cwd;
}
const posix={skip:process.platform==='win32'?'Windows uses backslashes as separators':false};

test('native nested paths remain readable on each operating system',t=>{
  const cwd=fixture(t), native=path.join('part','file.py');
  const source=readProjectSource(cwd,native);
  assert.equal(source.relative,'part/file.py');
  assert.match(source.text,/nested_symbol/);
  const signals=extractTaskSignals(cwd,{currentResource:native});
  assert.equal(signals.file,'part/file.py');
  if(process.env.IDLEPROOF_REQUIRE_CANONICAL==='1') assert.equal(signals.structureCoverage.canonical,true);
});

test('POSIX backslash source is unavailable instead of relabelled as a nested file',posix,t=>{
  const cwd=fixture(t);
  assert.equal(readProjectSource(cwd,'part\\file.py'),null);
  const signals=extractTaskSignals(cwd,{currentResource:'part\\file.py',currentCapabilities:['code.read'],touchedFiles:['part/file.py']});
  assert.equal(signals.file,'part\\file.py');
  assert.equal(signals.symbol,null);
  assert.equal(signals.structureCoverage.canonical,false);
  assert.equal(signals.structureCoverage.reason,'source-unavailable');
  assert.equal(signals.relatedFiles.find(item=>item.file==='part/file.py').symbol,'nested_symbol');
  if(process.env.IDLEPROOF_REQUIRE_CANONICAL==='1') assert.equal(signals.relatedFiles.find(item=>item.file==='part/file.py').structureCoverage.canonical,true);
});

test('feature seeds cannot inspect a different file after separator replacement',posix,t=>{
  const cwd=fixture(t);
  const model=buildFeatureModel(cwd,{currentResource:'part\\file.py'});
  assert.equal(model.generatedFrom.filesInspected,0);
  assert.deepEqual(model.generatedFrom.seedFiles,['part\\file.py']);
  assert.deepEqual(model.nodes,[]);
});

test('explanation and impact preserve distinct local paths',posix,()=>{
  const session={currentResource:'part\\file.py',touchedFiles:['part\\file.py']};
  const state={features:{nested:{featureKey:'nested',story:[{type:'file',label:'part/file.py',role:'core'}]}}};
  assert.equal(buildChangeImpact(state,session).blastRadius,0);
  const explanation=buildPlainExplanation({session});
  assert.deepEqual(explanation.files.map(item=>item.path),['part\\file.py']);
});

test('provenance and cloud projections do not alias two POSIX filenames',posix,t=>{
  const cwd=fixture(t);
  const event=summarizeEvent({cwd,tool_name:'Read',tool_input:{file_path:path.join(cwd,'part\\file.py')}});
  assert.equal(event.resource,'part\\file.py');
  const snapshot=buildPortalSnapshot({state:{project:'path-test'},session:{touchedFiles:['part\\file.py','part/file.py']}});
  assert.deepEqual(snapshot.files,['part/file.py']);
  const unsupported=buildPortalSnapshot({state:{project:'path-test'},session:{touchedFiles:['part\\file.py','C:\\private.py','\\\\server\\private.py']}});
  assert.deepEqual(unsupported.files,[]);
});

test('a POSIX lookalike of an internal directory remains meaningful Git content',posix,t=>{
  const cwd=fixture(t);
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  git('init','-q');git('config','user.name','Path qualification');git('config','user.email','path@example.invalid');
  git('add','.');git('commit','-qm','baseline');
  const before=captureBaselineIdentity(cwd);
  const name='.idleproof\\meaningful.py';
  fs.writeFileSync(path.join(cwd,name),'def new_content(): pass\n');
  const after=captureBaselineIdentity(cwd);
  assert.equal(before.available,true);assert.equal(after.available,true);
  assert.notEqual(after.base.tree,before.base.tree);
  assert.ok(captureGitSnapshot(cwd).files.includes(name));
  assert.equal(git('diff','--cached','--name-only'),'');
});

test('CODEOWNERS does not assign a nested directory owner to a literal backslash name',posix,t=>{
  const cwd=fixture(t);
  fs.writeFileSync(path.join(cwd,'CODEOWNERS'),'* @default\n/part/ @nested\n');
  const parsed=parseCodeowners(cwd);
  assert.deepEqual(ownersForPath('part/file.py',parsed),['@nested']);
  assert.deepEqual(ownersForPath('part\\file.py',parsed),['@default']);
});

test('a local approval for one POSIX path cannot approve the other path',posix,t=>{
  const cwd=fixture(t);
  initPolicy(cwd,'balanced');
  const policyPath=path.join(cwd,'idleproof.policy.json');
  const policy=JSON.parse(fs.readFileSync(policyPath,'utf8'));
  policy.rules=[{id:'review-writes',enabled:true,effect:'ask',severity:'high',match:{tool:'Write'}}];
  fs.writeFileSync(policyPath,JSON.stringify(policy));
  const event=file=>({cwd,source:'claude',hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{file_path:path.join(cwd,file)}});
  const literal=evaluatePolicy(event('part\\file.py'));
  assert.equal(literal.decision,'ask');
  grantApproval(cwd,literal.approvalFingerprint,{uses:1});
  const nested=evaluatePolicy(event('part/file.py'),{cwd,consumeApproval:true});
  assert.equal(nested.decision,'ask');assert.equal(nested.approved,false);
  assert.notEqual(nested.approvalFingerprint,literal.approvalFingerprint);
  assert.equal(evaluatePolicy(event('part\\file.py'),{cwd,consumeApproval:true}).approved,true);
});

test('legacy ambiguous approval fingerprints cannot authorize a current action',t=>{
  const cwd=fixture(t);
  initPolicy(cwd,'balanced');
  const event={cwd,source:'claude',hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'git push --force origin main'}};
  const action=normalizeAction(event,cwd);
  const oldFingerprint=createHash('sha256').update(JSON.stringify({source:action.source,tool:action.tool,command:action.command,path:action.path,capabilities:action.capabilities})).digest('hex').slice(0,16);
  grantApproval(cwd,oldFingerprint,{uses:1});
  const decision=evaluatePolicy(event,{cwd,consumeApproval:true});
  assert.equal(decision.decision,'ask');assert.equal(decision.approved,false);
  assert.notEqual(decision.approvalFingerprint,oldFingerprint);
  grantApproval(cwd,decision.approvalFingerprint,{uses:1});
  assert.equal(evaluatePolicy(event,{cwd,consumeApproval:true}).approved,true);
  assert.equal(evaluatePolicy(event,{cwd,consumeApproval:true}).decision,'ask');
});
