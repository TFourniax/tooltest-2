import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acceptResponsibility, ownersForPath, parseCodeowners, responsibilityReport, verifyAcceptance } from '../src/ownership.mjs';
import { projectPaths } from '../src/paths.mjs';
function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-owner-')); execFileSync('git', ['init', '-q'], { cwd }); execFileSync('git', ['config', 'user.name', 'Alice Owner'], { cwd }); execFileSync('git', ['config', 'user.email', 'alice@example.com'], { cwd });
  fs.mkdirSync(path.join(cwd, '.github')); fs.writeFileSync(path.join(cwd, '.github', 'CODEOWNERS'), '* alice@example.com\n/auth/ @security-team\n/billing/** alice@example.com\n'); fs.mkdirSync(projectPaths(cwd).dir, { recursive: true });
  fs.writeFileSync(projectPaths(cwd).receipt, JSON.stringify({ session: { files: ['auth/session.ts', 'billing/invoice.ts', 'src/ui.ts'], proof: { diffSha256: 'c'.repeat(64), head: 'abc123' } } })); return cwd;
}

test('CODEOWNERS matching uses the last matching rule', () => {
  const cwd = repo(); const parsed = parseCodeowners(cwd); assert.deepEqual(ownersForPath('auth/session.ts', parsed), ['@security-team']); assert.deepEqual(ownersForPath('billing/invoice.ts', parsed), ['alice@example.com']); assert.deepEqual(ownersForPath('src/ui.ts', parsed), ['alice@example.com']);
});

test('responsibility acceptance is bound to the diff and recorder-signed', () => {
  const cwd = repo(); const acceptance = acceptResponsibility(cwd, { principal: 'alice@example.com', note: 'I own this change.' }); assert.equal(acceptance.diffSha256, 'c'.repeat(64)); assert.equal(verifyAcceptance(acceptance), true);
  const report = responsibilityReport(cwd); assert.equal(report.ownerCoverage, 100); assert.equal(report.files.find((item) => item.file === 'billing/invoice.ts').accepted, true); assert.equal(report.files.find((item) => item.file === 'auth/session.ts').accepted, false); assert.ok(report.obligations.some((item) => item.file === 'auth/session.ts'));
});
