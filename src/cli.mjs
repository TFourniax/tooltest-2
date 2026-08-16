import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, openBrowser } from './server.mjs';
import { installClaude, uninstallClaude, hasClaudeInstall } from './install.mjs';
import { installCodex, uninstallCodex, hasCodexInstall } from './install-codex.mjs';
import { processHookEvent, processHookLifecycle, seedDemo, buildReceipt } from './hook.mjs';
import { computeMetrics, loadState } from './state.mjs';
import { DEFAULT_PORT, projectPaths } from './paths.mjs';
import { grantApproval, initPolicy, loadPolicy, policyHash } from './policy.mjs';
import { buildAgentBom, ensureIdentity, readProvenanceEvents, verifyProvenanceChain } from './provenance.mjs';
import { createAttestation, decodeAttestation, verifyAttestation } from './attest.mjs';
import { createEvidenceBundle } from './evidence.mjs';
import { acceptResponsibility, responsibilityReport } from './ownership.mjs';
import { replayPolicy } from './replay.mjs';

const BIN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/idleproof.mjs');
const SEVERITY = { low: 1, medium: 2, high: 3, critical: 4 };
const val = (args, key, fallback = null) => { const i = args.indexOf(key); return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback; };

function help() {
  console.log(`IdleProof — learn what your coding agent is building

Start:
  idleproof on [--agent claude|codex|all]
  idleproof start [--port N] [--no-open]
  idleproof stop
  idleproof serve [--port N]
  idleproof demo

Adapters:
  idleproof install claude|codex|all
  idleproof uninstall claude|codex|all
  idleproof run -- <command>

Policy:
  idleproof policy show
  idleproof policy init [observe|balanced|strict]
  idleproof policy replay [PROFILE] [--json]
  idleproof approve <fingerprint> [--minutes 10] [--uses 1]

Evidence:
  idleproof trace [--json] [--limit N]
  idleproof bom [--json]
  idleproof responsibility [--json]
  idleproof accept [--as OWNER]
  idleproof attest [--json]
  idleproof evidence [--json]
  idleproof identity show|export [--out FILE]
  idleproof verify [ATTESTATION] [--key PUBLIC_KEY]
  idleproof receipt [--json]

Learning & assurance:
  idleproof status
  idleproof check [--max N] [--fail-on LEVEL] [--require-attestation] [--require-owner]
  idleproof doctor
  idleproof reset`);
}

async function stdinJson() { let raw = ''; for await (const chunk of process.stdin) raw += chunk; return raw.trim() ? JSON.parse(raw) : {}; }
function gitOk(cwd) { try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore', timeout: 1000 }); return true; } catch { return false; } }
function serverInfo(cwd) { try { return JSON.parse(fs.readFileSync(projectPaths(cwd).server, 'utf8')); } catch { return null; } }
function alive(pid) { try { if (!Number.isInteger(pid) || pid <= 0) return false; process.kill(pid, 0); return true; } catch { return false; } }
function latest(state) { return Object.values(state.sessions || {}).sort((a,b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))[0] || null; }
function stateSummary(cwd) { const state = loadState(cwd); return { state, session: latest(state), metrics: computeMetrics(state) }; }

function installAdapters(cwd, agent) {
  if (!['claude','codex','all'].includes(agent)) throw new Error('Agent must be claude, codex, or all.');
  if (agent === 'claude' || agent === 'all') console.log(`✓ Claude adapter: ${path.relative(cwd, installClaude({ cwd, binPath: BIN_PATH }))}`);
  if (agent === 'codex' || agent === 'all') {
    console.log(`✓ Codex adapter: ${path.relative(cwd, installCodex({ cwd, binPath: BIN_PATH }))}`);
    console.log('  Run `/hooks` once in Codex to review/trust the project hook.');
  }
}

async function background(args) {
  const cwd = process.cwd();
  const port = Number(val(args, '--port', DEFAULT_PORT));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port.');
  const current = serverInfo(cwd);
  if (current && alive(current.pid)) { const url = `http://127.0.0.1:${current.port}`; console.log(`✓ IdleProof already running: ${url}`); if (!args.includes('--no-open')) openBrowser(url); return; }
  try { fs.unlinkSync(projectPaths(cwd).server); } catch {}
  const child = spawn(process.execPath, [BIN_PATH, 'serve', '--port', String(port), '--no-open'], { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const info = serverInfo(cwd);
    if (info && alive(info.pid)) { const url = `http://127.0.0.1:${info.port}`; console.log(`✓ IdleProof learning cockpit: ${url}`); if (!args.includes('--no-open')) openBrowser(url); return; }
    if (child.exitCode != null) break;
  }
  throw new Error('Background server failed. Run `idleproof serve` for diagnostics.');
}

function stop(cwd) {
  const info = serverInfo(cwd);
  if (!info || !alive(info.pid)) { try { fs.unlinkSync(projectPaths(cwd).server); } catch {} console.log('IdleProof is not running.'); return; }
  process.kill(info.pid, 'SIGTERM');
  try { fs.unlinkSync(projectPaths(cwd).server); } catch {}
  console.log(`✓ Stopped IdleProof (pid ${info.pid}).`);
}

async function serve(args, demo = false) {
  const port = Number(val(args, '--port', DEFAULT_PORT));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port.');
  if (demo) seedDemo(process.cwd());
  const { url } = await createServer({ cwd: process.cwd(), port });
  console.log(`✓ IdleProof learning cockpit: ${url}`);
  if (!args.includes('--no-open')) openBrowser(url);
}

async function generic(args) {
  const divider = args.indexOf('--');
  const command = divider >= 0 ? args.slice(divider + 1) : args;
  if (!command.length) throw new Error('Usage: idleproof run -- <command> [args...]');
  const cwd = process.cwd();
  const session_id = `generic-${Date.now()}-${process.pid}`;
  processHookEvent({ cwd, session_id, source:'generic-wrapper', hook_event_name:'UserPromptSubmit', prompt:command.join(' ') });
  const pre = processHookLifecycle({ cwd, session_id, source:'generic-wrapper', hook_event_name:'PreToolUse', tool_name:'Process', tool_input:{ command:command.join(' ') } });
  if (['ask','deny'].includes(pre.policyDecision?.decision)) { console.error(`BLOCKED ${pre.policyDecision.originalDecision.toUpperCase()} · ${pre.policyDecision.reason}`); console.error(`Approval id: ${pre.policyDecision.approvalFingerprint}`); process.exitCode = 3; return; }
  const child = spawn(command[0], command.slice(1), { cwd, stdio:'inherit', shell:process.platform === 'win32' });
  const code = await new Promise((resolve,reject) => { child.once('error', reject); child.once('exit', (c, signal) => resolve(signal ? 130 : (c ?? 1))); });
  processHookEvent({ cwd, session_id, source:'generic-wrapper', hook_event_name:'generic-stop', tool_name:'Process', tool_input:{ command:command.join(' ') } });
  process.exitCode = code;
}

function doctor(cwd) {
  const chain = verifyProvenanceChain(cwd);
  const rows = [
    ['Node >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.version],
    ['Git repository', gitOk(cwd), cwd],
    ['Claude adapter', hasClaudeInstall(cwd), path.relative(cwd, projectPaths(cwd).claudeSettings)],
    ['Codex adapter', hasCodexInstall(cwd), path.relative(cwd, projectPaths(cwd).codexHooks)],
    ['Provenance chain', chain.ok, `${chain.length} events`]
  ];
  for (const [name, ok, detail] of rows) console.log(`${ok ? '✓' : '✗'} ${name} — ${detail}`);
  if (rows.filter(([name]) => !name.includes('adapter')).some(([,ok]) => !ok)) process.exitCode = 1;
}

export async function main(args) {
  const [cmd = 'help', sub] = args;
  const cwd = process.cwd();
  if (['help','--help','-h'].includes(cmd)) return help();
  if (cmd === 'on') { const agent = String(val(args, '--agent', 'claude')).toLowerCase(); installAdapters(cwd, agent); console.log(`✓ Safety profile: ${loadPolicy(cwd).profile}`); await background(args.slice(1)); console.log('✓ Terminal is free — use your agent normally; IdleProof learns alongside it.'); return; }
  if (cmd === 'start') return background(args.slice(1));
  if (cmd === 'stop') return stop(cwd);
  if (cmd === 'serve') return serve(args.slice(1));
  if (cmd === 'demo') return serve(args.slice(1), true);
  if (cmd === 'run') return generic(args.slice(1));

  if (cmd === 'install') { installAdapters(cwd, sub); return; }
  if (cmd === 'uninstall') {
    if (!['claude','codex','all'].includes(sub)) throw new Error('Usage: idleproof uninstall claude|codex|all');
    if (sub === 'claude' || sub === 'all') console.log(uninstallClaude({ cwd }) ? '✓ Claude IdleProof hooks removed.' : 'No Claude IdleProof hooks found.');
    if (sub === 'codex' || sub === 'all') console.log(uninstallCodex({ cwd }) ? '✓ Codex IdleProof hooks removed.' : 'No Codex IdleProof hooks found.');
    return;
  }

  if (cmd === 'hook' || cmd === 'hook-codex') {
    const event = await stdinJson();
    const source = cmd === 'hook-codex' ? 'codex' : 'claude';
    const lifecycle = processHookLifecycle({ ...event, source });
    if (lifecycle.hookOutput) process.stdout.write(`${JSON.stringify(lifecycle.hookOutput)}\n`);
    else if (source === 'codex' && ['Stop','SubagentStop'].includes(event.hook_event_name)) process.stdout.write('{}\n');
    return;
  }

  if (cmd === 'policy') {
    if (sub === 'init') { const profile = String(args[2] || 'balanced').toLowerCase(); console.log(`✓ Policy: ${path.relative(cwd, initPolicy(cwd, profile, { force:args.includes('--force') }))}`); return; }
    if (sub === 'replay') { const replay = replayPolicy(cwd, { profile:args[2] ? String(args[2]).toLowerCase() : null }); if (args.includes('--json')) console.log(JSON.stringify(replay,null,2)); else { console.log(`Policy replay ${replay.profile}: ${replay.eventsEvaluated} actions`); console.log(`allow/observe/ask/deny ${replay.counts.allow}/${replay.counts.observe}/${replay.counts.ask}/${replay.counts.deny}`); console.log(`escalated ${replay.counts.escalated} · relaxed ${replay.counts.relaxed} · coverage ${replay.replayCoverage}`); for (const item of replay.impacts.slice(0,12)) console.log(`  #${item.sequence} ${item.previousDecision} → ${item.replayDecision} · ${(item.capabilities || []).join(', ') || item.tool}`); } return; }
    if (sub === 'show' || !sub) { const p = loadPolicy(cwd); console.log(`Policy: ${p.profile} · ${p.source}`); console.log(`SHA-256: ${policyHash(cwd)}`); return; }
    throw new Error('Usage: idleproof policy show|init|replay');
  }

  if (cmd === 'approve') { if (!sub) throw new Error('Missing approval fingerprint.'); const grant = grantApproval(cwd, sub, { minutes:Number(val(args,'--minutes',10)), uses:Number(val(args,'--uses',1)), note:val(args,'--note','') }); console.log(`✓ Approved ${sub} until ${grant.expiresAt}`); return; }
  if (cmd === 'trace') { const records = readProvenanceEvents(cwd, { limit:Number(val(args,'--limit',30)) }); if (args.includes('--json')) console.log(JSON.stringify(records,null,2)); else for (const r of records) console.log(`${r.sequence} ${r.event?.source || 'agent'} ${r.event?.eventType || 'event'}${r.event?.tool ? ` · ${r.event.tool}` : ''}${r.event?.policy ? ` · ${r.event.policy.originalDecision} r${r.event.policy.risk}` : ''}`); return; }
  if (cmd === 'bom') { const bom = buildAgentBom(cwd); if (args.includes('--json')) console.log(JSON.stringify(bom,null,2)); else { console.log(`Agent BOM: ${bom.events} events · ${bom.sessions} sessions`); console.log(`Sources: ${bom.sources.join(', ') || 'none'}`); console.log(`Capabilities: ${bom.capabilities.join(', ') || 'none'}`); console.log(`MCP: ${bom.mcpServers.join(', ') || 'none'}`); } return; }
  if (cmd === 'responsibility') { const r = responsibilityReport(cwd); if (args.includes('--json')) console.log(JSON.stringify(r,null,2)); else { console.log(`Responsibility coverage: ${r.responsibilityCoverage}% · owner mapping ${r.ownerCoverage}%`); for (const item of r.obligations) console.log(`  - ${item.file} · ${item.domain} · ${item.owners.join(', ') || 'no owner'}`); } return; }
  if (cmd === 'accept') { const a = acceptResponsibility(cwd, { principal:val(args,'--as',''), note:val(args,'--note','') }); createAttestation(cwd); console.log(`✓ Responsibility accepted by ${a.acceptedBy} for ${a.diffSha256}`); console.log('  Trust: local self-asserted identity witnessed by recorder.'); return; }
  if (cmd === 'attest') { const env = createAttestation(cwd); if (args.includes('--json')) console.log(JSON.stringify(env,null,2)); else { const s = decodeAttestation(env); console.log(`✓ Attestation: ${path.relative(cwd, projectPaths(cwd).attestation)}`); console.log(`  Subject ${s.subject?.[0]?.digest?.sha256}`); console.log(`  Recorder ${env.verificationMaterial?.fingerprint}`); } return; }
  if (cmd === 'evidence') { const b = createEvidenceBundle(cwd); if (args.includes('--json')) console.log(JSON.stringify(b,null,2)); else console.log(`✓ Evidence bundle: ${path.relative(cwd, projectPaths(cwd).evidence)} · ${b.provenanceCheckpoint.chain.length} trace events`); return; }
  if (cmd === 'identity') { const id = ensureIdentity(cwd); if (sub === 'export') { const out = path.resolve(cwd, val(args,'--out','.idleproof/recorder.pub.pem')); fs.mkdirSync(path.dirname(out), { recursive:true }); fs.writeFileSync(out,id.publicKey,{encoding:'utf8',mode:0o644}); console.log(`✓ Public key: ${path.relative(cwd,out)} · ${id.fingerprint}`); } else console.log(`Recorder ${id.fingerprint}\nTrust: local self-asserted\nPublic key: ${path.relative(cwd,projectPaths(cwd).identityPublic)}`); return; }
  if (cmd === 'verify') {
    const target = sub;
    const keyFile = val(args,'--key',null);
    const expectedPublicKey = keyFile ? fs.readFileSync(path.resolve(cwd,keyFile),'utf8') : (!target && fs.existsSync(projectPaths(cwd).identityPublic) ? fs.readFileSync(projectPaths(cwd).identityPublic,'utf8') : null);
    if (target) { const r = verifyAttestation(path.resolve(cwd,target), { expectedPublicKey }); console.log(`${r.ok ? 'PASS' : 'FAIL'} DSSE/in-toto · ${expectedPublicKey ? 'pinned signer' : 'self-asserted signer'}`); if (!expectedPublicKey && r.ok) console.log('WARN signer identity is not pinned; use --key for a trust decision.'); if (!r.ok) { for (const e of r.errors) console.log(`  - ${e}`); process.exitCode = 2; } return; }
    const chain = verifyProvenanceChain(cwd); console.log(`${chain.ok ? 'PASS' : 'FAIL'} provenance chain · ${chain.length} events`); if (!chain.ok) process.exitCode = 2;
    if (fs.existsSync(projectPaths(cwd).attestation)) { const r = verifyAttestation(projectPaths(cwd).attestation, { expectedPublicKey:expectedPublicKey || ensureIdentity(cwd).publicKey }); console.log(`${r.ok ? 'PASS' : 'FAIL'} latest attestation · pinned local recorder`); if (!r.ok) process.exitCode = 2; }
    return;
  }

  if (cmd === 'status') { const { session, metrics } = stateSummary(cwd); const chain = verifyProvenanceChain(cwd); const r = responsibilityReport(cwd); console.log(`Agent: ${session?.status || 'none'} · ${session?.source || 'none'}`); console.log(`Safety: ${loadPolicy(cwd).profile} · provenance ${chain.ok ? 'valid' : 'INVALID'} (${chain.length})`); console.log(`Knowledge debt ${metrics.debt} · cognitive ${metrics.coverage}% · responsibility ${r.responsibilityCoverage}%`); return; }
  if (cmd === 'check') {
    const max = Number(val(args,'--max',25)); const failOn = String(val(args,'--fail-on','critical')).toLowerCase(); if (!SEVERITY[failOn]) throw new Error('Invalid --fail-on.');
    const { state, metrics } = stateSummary(cwd); const session = latest(state); const risky = (session?.findings || []).filter((f) => (SEVERITY[f.severity] || 0) >= SEVERITY[failOn]); const chain = verifyProvenanceChain(cwd); const resp = responsibilityReport(cwd); const ownerOk = !args.includes('--require-owner') || resp.obligations.length === 0;
    let attOk = !args.includes('--require-attestation'); if (fs.existsSync(projectPaths(cwd).attestation)) attOk = verifyAttestation(projectPaths(cwd).attestation, { expectedPublicKey:ensureIdentity(cwd).publicKey }).ok;
    const ok = Number.isFinite(max) && metrics.debt <= max && !risky.length && chain.ok && attOk && ownerOk; console.log(`${ok ? 'PASS' : 'FAIL'} debt ${metrics.debt}/${max} · cognitive ${metrics.coverage}% · responsibility ${resp.responsibilityCoverage}% · provenance ${chain.ok ? 'valid' : 'invalid'} · attestation ${attOk ? 'valid/not-required' : 'missing/invalid'}`); if (!ok) process.exitCode = 2; return;
  }
  if (cmd === 'receipt') { const r = buildReceipt(cwd); if (args.includes('--json')) console.log(JSON.stringify(r,null,2)); else console.log(`✓ Receipt ${path.relative(cwd,projectPaths(cwd).receipt)} · diff ${r.session?.proof?.diffSha256 || 'none'} · provenance ${r.assurance?.provenance?.events || 0}`); return; }
  if (cmd === 'doctor') return doctor(cwd);
  if (cmd === 'reset') { fs.rmSync(projectPaths(cwd).dir, { recursive:true, force:true }); console.log('✓ Local state/evidence/recorder identity reset; hooks and project policy preserved.'); return; }
  throw new Error(`Unknown command: ${args.join(' ')}\nRun idleproof --help.`);
}
