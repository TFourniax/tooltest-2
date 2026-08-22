import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/idleproof.mjs');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitDead(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return !alive(pid);
}

test('background server restarts after an ungraceful process death without manual stale-file cleanup', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-crash-recovery-'));
  execFileSync('git', ['init', '-q'], { cwd });
  let secondPid = null;
  try {
    execFileSync(process.execPath, [BIN, 'start', '--no-open'], { cwd, encoding:'utf8', timeout:6000 });
    const record = path.join(cwd, '.idleproof', 'server.json');
    const first = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.ok(alive(first.pid));

    // SIGKILL models a crash/reboot-style death: the server has no opportunity to clean server.json.
    process.kill(first.pid, 'SIGKILL');
    assert.equal(await waitDead(first.pid), true, 'first background server did not terminate');
    assert.equal(fs.existsSync(record), true, 'fixture no longer represents a stale crash record');

    const output = execFileSync(process.execPath, [BIN, 'start', '--no-open'], { cwd, encoding:'utf8', timeout:8000 });
    assert.match(output, /IdleProof Local cockpit:/i);
    const second = JSON.parse(fs.readFileSync(record, 'utf8'));
    secondPid = second.pid;
    assert.notEqual(second.pid, first.pid);
    assert.notEqual(second.instanceId, first.instanceId);
    const health = await fetch(`http://127.0.0.1:${second.port}/api/health`).then((res) => res.json());
    assert.equal(health.ok, true);
    assert.equal(health.pid, second.pid);
    assert.equal(health.instanceId, second.instanceId);

    execFileSync(process.execPath, [BIN, 'stop'], { cwd, encoding:'utf8', timeout:5000 });
    secondPid = null;
  } finally {
    if (secondPid) {
      try { process.kill(secondPid, 'SIGTERM'); } catch {}
    }
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});
