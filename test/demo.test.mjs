import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/idleproof.mjs');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, { timeout = 15000, child = null, output = () => '' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (child?.exitCode != null) {
      throw new Error(`Demo exited before readiness (code=${child.exitCode}): ${output().slice(-2000)}`);
    }
    try { const res = await fetch(url); if (res.ok) return res.json(); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Demo did not become ready within ${timeout}ms: ${url}\n${output().slice(-2000)}`);
}

test('idleproof demo is isolated from the launch repository and demonstrates drift plus cross-feature impact', async () => {
  const launchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-demo-launch-'));
  const sentinel = path.join(launchCwd, 'KEEP_ME.txt');
  fs.writeFileSync(sentinel, 'untouched');
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, 'demo', '--port', String(port), '--no-open'], { cwd:launchCwd, stdio:['ignore','pipe','pipe'], windowsHide:true });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    // Demo preparation intentionally constructs several realistic sessions and Git snapshots before
    // binding the HTTP listener. On loaded Windows runners that can exceed 5s even though the same
    // installed package is healthy. Keep a bounded 15s readiness gate and fail immediately if the
    // process exits, preserving diagnostics instead of turning runner load into a flaky release gate.
    const state = await waitFor(`http://127.0.0.1:${port}/api/state`, { child, output:()=>output });
    assert.match(output, /IdleProof demo cockpit/);
    assert.match(output, /current repository is untouched/i);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
    assert.equal(fs.existsSync(path.join(launchCwd, '.idleproof')), false);
    assert.equal(fs.existsSync(path.join(launchCwd, '.git')), false);

    assert.ok(state.featureMemory.length >= 2);
    assert.ok(state.featureModel);
    assert.equal(state.featureModel.drift?.changed, true);
    assert.equal(state.featureModel.drift?.level, 'material');
    assert.match(state.featureModel.drift?.summary || '', /Redis|persistence/i);
    assert.ok(state.featureModel.surfaces.technologies.includes('Redis'));
    assert.ok(state.projectModel.impact.otherFeatures.some((item) => /invoice/i.test(item.task)));
    assert.ok(state.projectModel.topology.hotspots.some((item) => item.file === 'src/services/billing.ts' && item.featureCount >= 2));
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 2500); });
    fs.rmSync(launchCwd, { recursive:true, force:true, maxRetries:10, retryDelay:50 });
  }
});
