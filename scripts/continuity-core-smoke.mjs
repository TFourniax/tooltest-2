// Real public-CLI interoperability; requires qualified Core on PATH. MACHINE only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadContinuityContext, renderContinuityForAgent } from '../src/continuity.mjs';
import { __portalTest } from '../src/portal-snapshot.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-core-context-'));
const run=(command,args)=>execFileSync(command,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000,stdio:['ignore','pipe','pipe']});
try {
  run('git',['init','-q']); run('git',['config','user.name','Context Smoke']);
  run('git',['config','user.email','context@example.test']);
  fs.writeFileSync(path.join(root,'refund.py'),'def refund(value):\n    return value\n');
  run('git',['add','.']); run('git',['commit','-qm','base']);
  run('dw',['task','add','Refund safety','--id','TASK-REFUND','--why','Explicitly saved intent']);
  run('dw',['decision','record','Retry safely','--id','DEC-RETRY','--why','Refund idempotency']);
  run('dw',['decision','confirm','DEC-RETRY','--reason','Reviewed current refund policy']);
  const query='TASK-REFUND refund';
  const result=loadContinuityContext(root,query,{timeoutMs:5000});
  assert.ok(result,'real Core context must pass consumer admission');
  assert.equal(result.task,query);
  assert.ok(result.tasks.some(item=>item.id==='TASK-REFUND'));
  assert.equal(result.decisions.find(item=>item.id==='DEC-RETRY').lifecycle.epistemicStatus,'DECLARED');
  assert.match(renderContinuityForAgent(result),/Reviewed current refund policy/);
  const portal=__portalTest.safeContinuityMemory(result);
  assert.ok(portal.tasks.some(item=>item.id==='TASK-REFUND'));
  assert.equal(portal.decisions.find(item=>item.id==='DEC-RETRY').lifecycle.status,'DECLARED');
  run('dw',['decision','retire','DEC-RETRY','--reason','Replaced policy']);
  const after=loadContinuityContext(root,query,{timeoutMs:5000});
  assert.ok(after); assert.ok(!after.decisions.some(item=>item.id==='DEC-RETRY'));
  console.log(JSON.stringify({schema:'idleproof-core-context-smoke-1',passed:true,coreVersion:run('dw',['--version']).trim(),tasks:result.tasks.length,review:'DECLARED',retiredExcluded:true,human:'NOT_RUN'}));
} finally {
  fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});
}
