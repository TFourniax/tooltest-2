#!/usr/bin/env node
// A stand-in for the Core CLI in automatic-debt tests: answers `--version`, `debt --help`, `debt` and
// `envelope` with the file formats Core writes, and binds the envelope to the exact change the way Core
// does (repository fingerprint and the base and candidate trees of the given commits).
//   FAKE_DW_POINTS   points of every measurement (default 8)
//   FAKE_DW_FAIL     `debt` or `envelope`: that command fails with exit 2
//   FAKE_DW_WRONG_CHANGE=1  the envelope names another change
//   FAKE_DW_LOG      file receiving one line per invocation
//   FAKE_DW_SLEEP_MS `debt` takes this long (to overlap concurrent workers)
//   FAKE_DW_HANG     `debt` or `envelope`: that command hangs for FAKE_DW_HANG_MS (default 8000 ms)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { changeId, repositoryFingerprint } from '../../src/change-identity.mjs';

const args = process.argv.slice(2);
// `node --test` also runs every file under test/: without arguments there is nothing to answer.
if (!args.length) process.exit(0);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
if (process.env.FAKE_DW_LOG) fs.appendFileSync(process.env.FAKE_DW_LOG, `${args.join(' ')}\n`);
if (args[0] === '--version') { console.log('diffwitness 0.0.0-fake'); process.exit(0); }
if (args[1] === '--help') { console.log(`usage: dw ${args[0]} [-h]`); process.exit(0); }
if (process.env.FAKE_DW_FAIL === args[0]) { console.error(`fake dw ${args[0]} failure`); process.exit(2); }
if (process.env.FAKE_DW_HANG === args[0]) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_DW_HANG_MS || 8000));
const repo = value('--repo') || process.cwd();
const tree = (commit) => execFileSync('git', ['rev-parse', `${commit}^{tree}`], { cwd:repo, encoding:'utf8' }).trim();
const points = Number(process.env.FAKE_DW_POINTS || 8);
const lineages = ['DW-0123456789AB', 'DW-ABCDEF012345'];
if (args[0] === 'debt') {
  if (process.env.FAKE_DW_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_DW_SLEEP_MS));
  fs.writeFileSync(value('--json'), JSON.stringify({ report:{ summary:{ points }, signals:lineages.map((debt_id) => ({ debt_id })) }, budget:{ passed:true }, ledger:{} }));
  process.exit(0);
}
if (args[0] === 'envelope') {
  const debt = JSON.parse(fs.readFileSync(value('--debt'), 'utf8'));
  const id = process.env.FAKE_DW_WRONG_CHANGE ? 'dwchg_ffffffffffffffffffffffff'
    : changeId({ repository:repositoryFingerprint(repo), baseTree:tree(value('--base')), candidateTree:tree(value('--candidate')) });
  fs.writeFileSync(value('--out'), JSON.stringify({ schema_version:'change-envelope-1', change_id:id, privacy:{ code_uploaded:false, contains_prompt_text:false },
    debt:{ report_schema:'debt-report-1', points:debt.report.summary.points, open_lineages:lineages, budget_passed:debt.budget.passed } }));
  process.exit(0);
}
console.error(`fake dw: unsupported ${args.join(' ')}`);
process.exit(64);
