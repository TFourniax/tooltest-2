// MACHINE UI acceptance using the existing ecosystem Playwright driver, never HUMAN.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createProjectCorpus} from '../test/support/project-corpus.mjs';
import {createServer} from '../src/server.mjs';

const modulePath=process.env.PLAYWRIGHT_MODULE;
if(!modulePath)throw new Error('Set PLAYWRIGHT_MODULE to the qualified browser driver. No installation is attempted.');
const {chromium}=await import(pathToFileURL(path.resolve(modulePath)));
const p=createProjectCorpus();
const out=path.resolve(process.env.RECIPE_OUT||'e2e/test-results/project-understanding');fs.mkdirSync(out,{recursive:true});
const results=[];let browser,server;
try {
  execFileSync(process.env.DIFFWITNESS_BIN||'dw',['decision','record','Keep numeric rules independent','--id','DEC-CORPUS','--why','Different boundaries belong to independent rules'],{cwd:p.cwd});
  const started=await createServer({cwd:p.cwd,port:0});server=started.server;
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(started.url);
  await page.locator('#scanDocuments').fill(p.documents.join('\n'));await page.locator('#scanCI').check();
  await page.locator('#scanStart').click();
  await page.waitForFunction(()=>document.querySelector('#scanProgress')?.textContent.includes('Job: complete'),{},{timeout:120000});
  assert.match(await page.locator('#scanActiveTask').innerText(),/No active task/);
  assert.match(await page.locator('#scanCoverage').innerText(),/excluded/);results.push({check:'task-free cockpit scan with explicit coverage',status:'PASS'});
  await page.locator('#scanFilter').fill('rules.py');
  const rules=page.locator('#scanFiles details').filter({has:page.locator('summary').filter({hasText:'rules.py'})}).first();
  if(!await rules.evaluate(el=>el.open))await rules.locator('summary').first().click();
  assert.match(await page.locator('#scanFiles').innerText(),/value >= 100/);
  assert.match(await page.locator('#scanFiles').innerText(),/value >= 80/);results.push({check:'independent sourced behavior and thresholds',status:'PASS'});
  await page.locator('#scanFiles [data-scan-file="rules.py"]').click();
  await page.waitForFunction(()=>document.querySelector('#scanFiles .scan-source:not([hidden])')?.textContent.includes('dwscan_'));
  results.push({check:'captured source accessible from component in two clicks',status:'PASS'});
  await page.locator('#scanFilter').fill('view.py');assert.match(await page.locator('#scanFiles').innerText(),/service.py/);
  await page.locator('#scanFilter').fill('');
  assert.match(await page.locator('#scanIntent').innerText(),/DECLARED/);assert.match(await page.locator('#scanUnknowns').innerText(),/not.*execution|not.*demonstrated/);
  results.push({check:'connections, owner intentions and unknowns visible',status:'PASS'});
  await page.locator('details').filter({has:page.locator('#scanMemoryLoad')}).locator('summary').click();
  await page.locator('#scanMemoryQuery').fill('DEC-CORPUS');await page.locator('#scanMemoryLoad').click();
  await page.waitForFunction(()=>document.querySelector('#scanMemory')?.textContent.includes('DEC-CORPUS'));
  assert.match(await page.locator('#scanMemory').innerText(),/DECLARED/);
  await page.locator('#scanMemoryCitations button').first().click();
  await page.waitForFunction(()=>document.querySelector('#scanMemoryCitations pre')?.textContent.includes('memory-event-detail-1'));
  results.push({check:'original Core declaration is directly navigable',status:'PASS'});
  await page.locator('#scanView').selectOption('technical');await page.screenshot({path:path.join(out,'cockpit.png'),fullPage:true});
  assert.deepEqual(errors,[]);assert.equal(fs.existsSync(path.join(p.cwd,'SCAN_MUST_NOT_EXECUTE')),false);
  results.push({check:'no browser error and no source execution',status:'PASS'});
}catch(error){results.push({check:'execution',status:'FAIL',reason:error.message});process.exitCode=1;}
finally {
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({schema:'idleproof.project-browser.v1',classification:'MACHINE',human:'NOT_RUN',results},null,2));
  fs.rmSync(p.cwd,{recursive:true,force:true});console.log(JSON.stringify(results));
}
