// Existing trust regressions plus real Core production; no fake Codex or HUMAN claim.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { assuranceFromChangeEnvelope } from '../src/portal-snapshot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = flag => { const i=process.argv.indexOf(flag); return i<0?null:process.argv[i+1]; };
const core = value('--core');
const scope=value('--scope')||'complete';
if (!core||!['local','complete'].includes(scope)) throw new Error('Usage: node scripts/golden-contract.mjs --core /isolated/core --scope local|complete [--report /file.json]');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-golden-output-'));
const results=[];
function run(name,command,args,cwd=root,env=process.env) {
  const p=spawnSync(command,args,{cwd,env,encoding:'utf8',windowsHide:true,timeout:600000,maxBuffer:8*1024*1024});
  results.push({name,status:!p.error&&p.status===0?'PASS':'FAIL',exitCode:p.status,error:p.error?.code||null});
  if(p.error||p.status!==0) throw new Error(`${name}: ${p.error?.message||''}\n${p.stdout}\n${p.stderr}`);
}
try {
  const unitEnv={...process.env};delete unitEnv.DIFFWITNESS_BIN;delete unitEnv.IDLEPROOF_TEST_CORE;
  for(const file of ['stop-output-contract','portal-assurance','auto-debt','feature-review','byok'])run(`G1/G5/G11/G12 local ${file}`,process.execPath,['--test','--test-concurrency=1',`test/${file}.test.mjs`],root,unitEnv);
  const output=path.join(temp,'core.json');
  run('G1/G2/G3/G4/G5/G7 real Core sequential changes',value('--python')||'python',['scripts/golden-core-journey.py','--core',path.resolve(core),'--out',output]);
  const produced=JSON.parse(fs.readFileSync(output,'utf8'));
  assert.equal(new Set(produced.envelopes.map(e=>e.change_id)).size,3);
  assert.equal(produced.journalReplayIdentical,true);assert.equal(produced.cursorCaughtUp,true);
  if(value('--report'))fs.copyFileSync(output,path.resolve(value('--report'))+'.core.json');
  for(const envelope of produced.envelopes) {
    const before=JSON.stringify(envelope);
    const assurance=assuranceFromChangeEnvelope(envelope,envelope.change_id);
    assert.equal(assurance.proof.accepted,true);
    assert.equal(assurance.proof.claim,'causal');
    assert.equal(assurance.proof.certificateId,envelope.proof.certificate_id);
    assert.equal(JSON.stringify(envelope),before);
    const other=produced.envelopes.find(e=>e.change_id!==envelope.change_id);
    assert.throws(()=>assuranceFromChangeEnvelope(envelope,other.change_id));
  }
  results.push({name:'G6 producer exact-change admission; certificate bytes unchanged',status:'PASS'});
  // These require the real disposable Portal stack; a mock must not turn them green.
  for(const name of ['G6 Portal rendering','G8 database restore/replay','G9 DB receipt idempotence','G10 Linux process lifecycle']) results.push({name,status:'NOT_RUN',reason:'Run the existing Portal real-stack recipes on the coordinated candidate.'});
} catch(error) {
  process.exitCode=1;
  results.push({name:'execution',status:'FAIL',reason:error.message});
} finally {
  const partial=results.some(r=>r.status==='NOT_RUN'),failed=results.some(r=>r.status==='FAIL');
  const report={schema:'idleproof.golden-contract.v1',classification:'MACHINE',scope,status:failed?'FAIL':partial?'PARTIAL':'PASS',human:'NOT_RUN',results};
  if(scope==='complete'&&partial)process.exitCode=2;
  if(value('--report')) fs.writeFileSync(value('--report'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  fs.rmSync(temp,{recursive:true,force:true});
}
