import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLocalRequest } from '../src/local-http-security.mjs';

function req({ method = 'GET', host = '127.0.0.1:4777', origin, fetchSite } = {}) {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (fetchSite !== undefined) headers['sec-fetch-site'] = fetchSite;
  return { method, headers };
}

test('local control plane accepts loopback reads and same-port local writes', () => {
  assert.equal(validateLocalRequest(req()).ok, true);
  assert.equal(validateLocalRequest(req({ host: 'localhost:4777' })).ok, true);
  assert.equal(validateLocalRequest(req({
    method: 'POST',
    origin: 'http://127.0.0.1:4777',
    fetchSite: 'same-origin'
  })).ok, true);
  assert.equal(validateLocalRequest(req({
    method: 'POST',
    host: '127.0.0.1:4777',
    origin: 'http://localhost:4777'
  })).ok, true);
});

test('local control plane rejects DNS-rebinding style Host headers', () => {
  const result = validateLocalRequest(req({ host: 'attacker.example:4777' }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 421);
});

test('local control plane rejects cross-site and non-local write origins', () => {
  const crossSite = validateLocalRequest(req({
    method: 'POST',
    origin: 'https://attacker.example',
    fetchSite: 'cross-site'
  }));
  assert.equal(crossSite.ok, false);
  assert.equal(crossSite.status, 403);

  const hostileOrigin = validateLocalRequest(req({
    method: 'POST',
    origin: 'https://attacker.example'
  }));
  assert.equal(hostileOrigin.ok, false);
  assert.equal(hostileOrigin.status, 403);

  const wrongPort = validateLocalRequest(req({
    method: 'POST',
    origin: 'http://127.0.0.1:9000'
  }));
  assert.equal(wrongPort.ok, false);
  assert.equal(wrongPort.status, 403);
});

test('non-browser local integrations remain usable without an Origin header', () => {
  const result = validateLocalRequest(req({ method: 'POST' }));
  assert.equal(result.ok, true);
});
