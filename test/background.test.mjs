import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/idleproof.mjs');
const LEGACY_DEFAULT_PORT = 4777;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function occupy(port) {
  const server = net.createServer();
  const result = await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
  return result ? server : null;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('background learning cockpit starts, identifies itself, and stops without occupying the terminal', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-background-'));
  execFileSync('git', ['init', '-q'], { cwd });
  const port = await freePort();
  let pid = null;
  try {
    const output = execFileSync(process.execPath, [BIN, 'start', '--port', String(port), '--no-open'], { cwd, encoding: 'utf8', timeout: 5000 });
    assert.match(output, /IdleProof learning cockpit:/);
    const info = JSON.parse(fs.readFileSync(path.join(cwd, '.idleproof', 'server.json'), 'utf8'));
    pid = info.pid;
    assert.equal(info.port, port);
    assert.equal(typeof info.instanceId, 'string');
    assert.ok(info.instanceId.length > 10);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((res) => res.json());
    assert.equal(health.ok, true);
    assert.equal(health.pid, info.pid);
    assert.equal(health.instanceId, info.instanceId);

    const stop = execFileSync(process.execPath, [BIN, 'stop'], { cwd, encoding: 'utf8', timeout: 5000 });
    assert.match(stop, /Stopped IdleProof/);
    pid = null;
    assert.equal(fs.existsSync(path.join(cwd, '.idleproof', 'server.json')), false);
  } finally {
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('normal start automatically avoids an occupied legacy default port', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-auto-port-'));
  execFileSync('git', ['init', '-q'], { cwd });
  const blocker = await occupy(LEGACY_DEFAULT_PORT);
  let pid = null;
  try {
    const output = execFileSync(process.execPath, [BIN, 'start', '--no-open'], { cwd, encoding:'utf8', timeout:5000 });
    assert.match(output, /IdleProof learning cockpit:/);
    const info = JSON.parse(fs.readFileSync(path.join(cwd, '.idleproof', 'server.json'), 'utf8'));
    pid = info.pid;
    assert.ok(Number.isInteger(info.port) && info.port > 0);
    assert.notEqual(info.port, LEGACY_DEFAULT_PORT, 'automatic start unexpectedly reused the occupied/default port');
    const health = await fetch(`http://127.0.0.1:${info.port}/api/health`).then((res) => res.json());
    assert.equal(health.ok, true);
    assert.equal(health.instanceId, info.instanceId);
    execFileSync(process.execPath, [BIN, 'stop'], { cwd, encoding:'utf8', timeout:5000 });
    pid = null;
  } finally {
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    if (blocker) await new Promise((resolve) => blocker.close(resolve));
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});

test('idleproof on auto-detects an existing Codex project instead of silently installing Claude hooks', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-auto-agent-'));
  execFileSync('git', ['init', '-q'], { cwd });
  fs.mkdirSync(path.join(cwd, '.codex'), { recursive:true });
  let pid = null;
  try {
    const output = execFileSync(process.execPath, [BIN, 'on', '--no-open'], { cwd, encoding:'utf8', timeout:8000 });
    assert.match(output, /Agent adapter auto-detected: codex/i);
    assert.match(output, /Codex adapter:/i);
    const info = JSON.parse(fs.readFileSync(path.join(cwd, '.idleproof', 'server.json'), 'utf8'));
    pid = info.pid;
    assert.ok(fs.existsSync(path.join(cwd, '.codex', 'hooks.json')), 'Codex hook config was not installed');
    assert.equal(fs.existsSync(path.join(cwd, '.claude', 'settings.local.json')), false, 'auto-detection unexpectedly modified Claude settings');
    execFileSync(process.execPath, [BIN, 'stop'], { cwd, encoding:'utf8', timeout:5000 });
    pid = null;
  } finally {
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});

test('stop never signals an unrelated process referenced by a stale server record', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-stale-server-'));
  execFileSync('git', ['init', '-q'], { cwd });
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio:'ignore' });
  try {
    const port = await freePort();
    const dir = path.join(cwd, '.idleproof');
    fs.mkdirSync(dir, { recursive:true });
    fs.writeFileSync(path.join(dir, 'server.json'), `${JSON.stringify({
      pid: dummy.pid,
      instanceId: 'stale-instance-that-is-not-serving',
      port,
      cwd,
      startedAt: new Date().toISOString()
    }, null, 2)}\n`);

    const output = execFileSync(process.execPath, [BIN, 'stop'], { cwd, encoding:'utf8', timeout:5000 });
    assert.match(output, /stale server record/i);
    assert.equal(isAlive(dummy.pid), true, 'IdleProof stop signalled a process it did not authenticate');
    assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
  } finally {
    try { dummy.kill('SIGTERM'); } catch {}
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});
