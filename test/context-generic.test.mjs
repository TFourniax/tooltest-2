import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractTaskSignals } from '../src/context.mjs';

function fixture(file, content, prompt) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-context-generic-'));
  const full=path.join(cwd,file); fs.mkdirSync(path.dirname(full),{recursive:true}); fs.writeFileSync(full,content);
  try { return extractTaskSignals(cwd,{ prompt, touchedFiles:[file], currentResource:file, currentCapabilities:['code.modify'] }); }
  finally { fs.rmSync(cwd,{recursive:true,force:true}); }
}

test('extracts exact Go symbol and arbitrary package dependency', () => {
  const s=fixture('internal/payments/odd_receiver.go',`package payments\nimport (\"github.com/acme/weirdpay/v7\")\nfunc SettleOddInvoice(id string) error { return nil }\n`,'Change SettleOddInvoice retry behavior');
  assert.equal(s.symbol,'SettleOddInvoice');
  assert.ok(s.dependencies.includes('github.com/acme/weirdpay/v7'));
});

test('extracts Rust symbol and crate dependency without pretending std is external', () => {
  const s=fixture('src/queue_worker.rs',`use mystery_bus::Client;\nuse std::sync::Arc;\nfn drain_pending_jobs() {}`,'Make drain_pending_jobs safe');
  assert.equal(s.symbol,'drain_pending_jobs');
  assert.ok(s.dependencies.includes('mystery_bus'));
  assert.ok(!s.dependencies.includes('std'));
});

test('extracts Java route and class while preserving exact file', () => {
  const s=fixture('src/main/java/com/acme/FrobnicatorEndpoint.java',`import com.vendor.odd.Client;\n@RestController\nclass FrobnicatorEndpoint {\n @PostMapping(\"/v1/frobnicate\") void frobnicate() {}\n}`,'Update FrobnicatorEndpoint');
  assert.equal(s.file,'src/main/java/com/acme/FrobnicatorEndpoint.java');
  assert.equal(s.route,'/v1/frobnicate');
  assert.equal(s.symbol,'FrobnicatorEndpoint');
});

test('unknown extension still returns bounded metadata instead of crashing', () => {
  const s=fixture('src/custom/frob.logic',`handler customThing\n`,'Change customThing');
  assert.equal(s.file,'src/custom/frob.logic');
  assert.ok(s.fileRole);
});
