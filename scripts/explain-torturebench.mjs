import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractTaskSignals } from '../src/context.mjs';
import { buildPlainExplanation } from '../src/explain.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-explain-torture-'));
const languages = [
  { ext:'ts', symbol:'processThing', body:(s)=>`export async function ${s}(value) { return value; }\n` },
  { ext:'js', symbol:'processThing', body:(s)=>`export function ${s}(value) { return value; }\n` },
  { ext:'mjs', symbol:'processThing', body:(s)=>`export const ${s} = async (value) => value;\n` },
  { ext:'py', symbol:'process_thing', body:(s)=>`def ${s}(value):\n    return value\n` },
  { ext:'go', symbol:'ProcessThing', body:(s)=>`package odd\nfunc ${s}(value string) string { return value }\n` },
  { ext:'rs', symbol:'process_thing', body:(s)=>`fn ${s}(value: String) -> String { value }\n` },
  { ext:'java', symbol:'RunnerV7', body:(s)=>`public class ${s} { public String run(String value) { return value; } }\n` },
  { ext:'kt', symbol:'RunnerV7', body:(s)=>`class ${s} { fun run(value: String): String = value }\n` },
  { ext:'cs', symbol:'RunnerV7', body:(s)=>`public class ${s} { public string Run(string value) => value; }\n` },
  { ext:'rb', symbol:'process_thing', body:(s)=>`def ${s}(value)\n  value\nend\n` },
  { ext:'php', symbol:'processThing', body:(s)=>`<?php\nfunction ${s}($value) { return $value; }\n` },
  { ext:'swift', symbol:'RunnerV7', body:(s)=>`struct ${s} { func run(_ value: String) -> String { value } }\n` },
  { ext:'cpp', symbol:'RunnerV7', body:(s)=>`struct ${s} { int run(int value) { return value; } };\n` },
];

const pathShapes = [
  'src/x/gorf_92',
  'x/internal/a',
  'legacy/thing-manager-old',
  'modules/q7/opaque',
  'pkg/zzz/v4/runner',
  'services/no_hint/part',
  'apps/mobile/misc',
  'monorepo/packages/a/src/odd',
  'workers/not_really_a_worker/thing',
  'auth/not_auth_logic/thing',
  'database/not_a_database/thing',
  'api/not_an_endpoint/thing',
  'components/not_ui/thing',
  'migrations/not_a_migration/thing',
  'random/deep/nested/thing',
  'vendor_bridge/custom/thing',
  'cli/not_a_command/thing',
  'schemas/not_a_schema/thing',
];

let cases = 0;
let exactPaths = 0;
let exactSymbols = 0;
try {
  for (let index = 0; index < 234; index += 1) {
    const language = languages[index % languages.length];
    const stem = pathShapes[index % pathShapes.length];
    const file = `${stem}_${index}.${language.ext}`;
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive:true });
    const symbol = `${language.symbol}${index}`;
    const misleading = index % 3 === 0
      ? `// OLD DEAD NOTE: Stripe OAuth PostgreSQL Redis /api/fake-route fake_table\n`
      : index % 3 === 1
        ? `/* obsolete code: function FakeStripeHandler() {} route /webhooks/fake */\n`
        : `# old documentation only: OAuth Redis fake_table /api/fake\n`;
    fs.writeFileSync(absolute, misleading + language.body(symbol), 'utf8');

    const prompt = `Change ${symbol} so the opaque value is handled safely`;
    const session = { prompt, currentResource:file, touchedFiles:[file], currentCapabilities:['code.read'] };
    const signals = extractTaskSignals(root, session);
    const explanation = buildPlainExplanation({
      phase:'implement',
      session:{ ...session, taskSignals:signals }
    });

    assert.equal(explanation.schema, 'idleproof.explanation.v1');
    assert.equal(signals.file, file, `${file}: extractor lost exact path`);
    assert.ok(explanation.doing.includes(`\`${file}\``), `${file}: explanation lost exact path`);
    assert.ok(explanation.project.includes(`\`${file}\``), `${file}: project explanation lost exact path`);
    assert.equal(explanation.optionalCheck, true);
    assert.ok(explanation.certainty.limitations.some((item)=>/DiffWitness/.test(item)), `${file}: proof boundary missing`);
    assert.doesNotMatch(`${explanation.doing} ${explanation.project}`, /\/api\/fake-route|\/webhooks\/fake|fake_table/, `${file}: comment became structural evidence`);
    assert.doesNotMatch((signals.technologies || []).join(' '), /Stripe|OAuth|PostgreSQL|Redis/, `${file}: comment became technology evidence`);
    assert.notEqual(signals.symbol, 'FakeStripeHandler', `${file}: dead commented symbol won extraction`);
    if (signals.symbol) {
      assert.equal(signals.symbol, symbol, `${file}: wrong live symbol selected`);
      assert.ok(explanation.doing.includes(symbol), `${file}: live symbol omitted`);
      exactSymbols += 1;
    }
    exactPaths += 1;
    cases += 1;
  }

  // Explicit observed facts must override a deliberately misleading path name.
  const routeFile = 'database/migrations/not_really_db/handler.ts';
  const routeAbsolute = path.join(root, routeFile);
  fs.mkdirSync(path.dirname(routeAbsolute), { recursive:true });
  fs.writeFileSync(routeAbsolute, `export async function receiveZorp(req) { return req; }\nexport const route = '/api/zorp-v9';\n`, 'utf8');
  const routeSession = { prompt:'Update receiveZorp for /api/zorp-v9', currentResource:routeFile, touchedFiles:[routeFile], currentCapabilities:['code.read'] };
  const routeSignals = extractTaskSignals(root, routeSession);
  const routeExplanation = buildPlainExplanation({ phase:'implement', session:{...routeSession, taskSignals:routeSignals} });
  assert.equal(routeSignals.route, '/api/zorp-v9');
  assert.equal(routeExplanation.files[0].role, 'api', 'observed route must outrank misleading migration/data path');
  assert.equal(routeExplanation.files[0].confidence, 'high');
  cases += 1;

  // Oversized, binary, deleted and missing files must degrade to bounded inference, not invent facts.
  for (const [name, writer] of [
    ['huge/thing.ts', (p)=>fs.writeFileSync(p, `export function hugeThing(){}\n${'x'.repeat(140 * 1024)}`)],
    ['binary/thing.bin', (p)=>fs.writeFileSync(p, Buffer.from([0,1,2,3,83,116,114,105,112,101]))],
  ]) {
    const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive:true }); writer(p);
    const session = { prompt:'Inspect this opaque artifact', currentResource:name, touchedFiles:[name], currentCapabilities:['code.read'] };
    const signals = extractTaskSignals(root, session);
    const out = buildPlainExplanation({ phase:'inspect', session:{...session, taskSignals:signals} });
    assert.equal(signals.symbol, null);
    assert.equal(signals.route, null);
    assert.equal(signals.table, null);
    assert.ok(out.project.includes(`\`${name}\``));
    assert.equal(out.certainty.level, 'bounded-inference');
    cases += 1;
  }

  const missing = 'deleted/old_thing.py';
  const missingSession = { prompt:'Remove the obsolete path', currentResource:missing, touchedFiles:[missing], currentCapabilities:['code.read'] };
  const missingSignals = extractTaskSignals(root, missingSession);
  const missingOut = buildPlainExplanation({ phase:'implement', session:{...missingSession, taskSignals:missingSignals} });
  assert.equal(missingSignals.symbol, null);
  assert.ok(missingOut.project.includes(`\`${missing}\``));
  assert.match(missingOut.files[0].explanation, /instead of inventing a business role/i);
  cases += 1;

  assert.ok(cases >= 238);
  assert.equal(exactPaths, 234);
  assert.ok(exactSymbols >= 210, `too many language fixtures lost their live symbol: ${exactSymbols}/234`);
  console.log(`Explain TortureBench PASS · ${cases} adversarial project forms · exact paths ${exactPaths}/234 · live symbols ${exactSymbols}/234`);
} finally {
  fs.rmSync(root, { recursive:true, force:true });
}
