#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildSupportDiagnostic } from '../src/diagnostic.mjs';

const args=process.argv.slice(2);
const value=(name,fallback=null)=>{
  const index=args.indexOf(name);
  return index>=0 && args[index+1]!=null ? args[index+1] : fallback;
};

function help() {
  console.log(`IdleProof Support — privacy-safe installation diagnostics

Usage:
  idleproof-support
  idleproof-support --json
  idleproof-support --out idleproof-support.json

The report excludes source code, raw prompts, raw diffs, raw agent events,
absolute project paths and secrets by contract.`);
}

if (args.includes('--help') || args.includes('-h')) {
  help();
  process.exit(0);
}

try {
  const report=buildSupportDiagnostic(process.cwd());
  const out=value('--out',null);
  if (out) {
    const target=path.resolve(process.cwd(),out);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,`${JSON.stringify(report,null,2)}\n`,{encoding:'utf8',mode:0o600});
    console.log(`✓ IdleProof support report: ${path.relative(process.cwd(),target) || path.basename(target)}`);
    console.log('  Safe boundary: no source code, raw prompts, raw diffs, raw agent events, absolute project paths or secrets.');
  } else if (args.includes('--json')) {
    console.log(JSON.stringify(report,null,2));
  } else {
    console.log(`IdleProof ${report.product.version} · ${report.system.platform}/${report.system.arch} · ${report.product.runtime}`);
    console.log(`Git: ${report.git.repository ? (report.git.hasHead ? 'ready' : 'unborn') : 'not a repository'}${report.git.dirty===true ? ' · dirty' : ''}`);
    console.log(`Adapters: Claude ${report.adapters.claude?'yes':'no'} · Codex ${report.adapters.codex?'yes':'no'}`);
    console.log(`State: ${report.state.primary.parseable===true?'healthy':report.state.backup.parseable===true?'recoverable from backup':report.state.primary.present?'unreadable':'not created'}`);
    console.log(`Provenance: ${report.provenance.valid?'valid':'invalid'} · ${report.provenance.events} events`);
    console.log(`Server: ${report.server.pidAlive?'running':report.server.recordPresent?'stale/not responding':'stopped'}`);
    console.log('Run `idleproof-support --out idleproof-support.json` to create a report you can share with support.');
  }
} catch (error) {
  console.error(`IdleProof support diagnostic failed: ${error.message}`);
  process.exitCode=1;
}
