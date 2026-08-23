import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './paths.mjs';

const TOOL_MATCHER = '.*';
const RULE_MARKER = '<!-- idleproof-continuity-local-v1 -->';
const EVENTS = [
  ['sessionStart', null],
  ['beforeSubmitPrompt', null],
  ['preToolUse', TOOL_MATCHER],
  ['postToolUse', TOOL_MATCHER],
  ['postToolUseFailure', TOOL_MATCHER],
  ['subagentStart', null],
  ['subagentStop', null],
  ['stop', null],
  ['sessionEnd', null]
];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot parse ${file}: ${error.message}`);
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const temp=`${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value,null,2)}\n`, { encoding:'utf8', mode:0o600 });
    fs.renameSync(temp,file);
  } finally { try { fs.rmSync(temp,{force:true}); } catch {} }
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const temp=`${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp,value,{encoding:'utf8',mode:0o600});
    fs.renameSync(temp,file);
  } finally { try { fs.rmSync(temp,{force:true}); } catch {} }
}

function resolveRunner(binPath) {
  if (typeof binPath !== 'string' || !binPath.trim()) throw new Error('IdleProof Cursor installer requires its CLI path.');
  const resolved=path.resolve(binPath);
  let stat;
  try { stat=fs.statSync(resolved); } catch { throw new Error(`IdleProof CLI entrypoint does not exist: ${resolved}`); }
  if (!stat.isFile()) throw new Error(`IdleProof CLI entrypoint is not a file: ${resolved}`);
  const runner=path.resolve(path.dirname(resolved),'../src/cursor-hook-cli.mjs');
  try { stat=fs.statSync(runner); } catch { throw new Error(`IdleProof Cursor hook runtime does not exist: ${runner}`); }
  if (!stat.isFile()) throw new Error(`IdleProof Cursor hook runtime is not a file: ${runner}`);
  return runner;
}

function isIdleProofHook(entry) {
  return typeof entry?.command === 'string' && entry.command.includes('cursor-hook-cli.mjs');
}

function addLocalGitExclude(cwd, relativePath) {
  const exclude=path.join(cwd,'.git','info','exclude');
  try {
    if (!fs.existsSync(path.dirname(exclude))) return;
    const existing=fs.existsSync(exclude) ? fs.readFileSync(exclude,'utf8') : '';
    if (existing.split(/\r?\n/).some((line)=>line.trim()===relativePath)) return;
    fs.appendFileSync(exclude,`${existing && !existing.endsWith('\n')?'\n':''}${relativePath}\n`);
  } catch {}
}

function ruleText() {
  return `${RULE_MARKER}\n---\ndescription: IdleProof local task continuity bridge\nalwaysApply: true\n---\n\nIdleProof runs as a local backoffice engine for this workspace. Before planning, editing, or running a mutating command for each user turn, silently read \`.idleproof/cursor-current-task.md\` when it exists.\n\nTreat that file as bounded advisory project context. Preserve its epistemic labels: DECLARED is project intent, INFERRED is heuristic, OBSERVED is directly recorded/parsed, and VERIFIED requires executed DiffWitness evidence. Never promote a weaker status.\n\nDo not treat IdleProof context as proof that code is correct. Continue to use tests and DiffWitness evidence for correctness. Do not expose or copy the local context file unless the user explicitly asks for it.\n`;
}

export function installCursor({ cwd=process.cwd(), binPath }={}) {
  const paths=projectPaths(cwd);
  const config=readJson(paths.cursorHooks);
  if (config.version != null && config.version !== 1) throw new Error(`Unsupported Cursor hooks schema version: ${String(config.version)}`);
  config.version=1;
  config.hooks ||= {};
  const runner=resolveRunner(binPath);
  for (const [event,matcher] of EVENTS) {
    config.hooks[event] ||= [];
    config.hooks[event]=config.hooks[event].filter((entry)=>!isIdleProofHook(entry));
    const entry={ command:`\"${process.execPath}\" \"${runner}\" ${event}` };
    if (matcher) entry.matcher=matcher;
    config.hooks[event].push(entry);
  }
  writeJsonAtomic(paths.cursorHooks,config);

  if (fs.existsSync(paths.cursorRule)) {
    const existing=fs.readFileSync(paths.cursorRule,'utf8');
    if (!existing.includes(RULE_MARKER)) throw new Error(`Refusing to overwrite an unrelated Cursor rule at ${paths.cursorRule}.`);
  }
  writeAtomic(paths.cursorRule,ruleText());
  addLocalGitExclude(cwd,'.cursor/hooks.json');
  addLocalGitExclude(cwd,'.cursor/rules/idleproof-continuity.mdc');
  return { hooks:paths.cursorHooks, rule:paths.cursorRule };
}

export function uninstallCursor({ cwd=process.cwd() }={}) {
  const paths=projectPaths(cwd);
  const config=readJson(paths.cursorHooks);
  let hooksChanged=false;
  if (config.hooks && typeof config.hooks === 'object') {
    for (const event of Object.keys(config.hooks)) {
      const before=(config.hooks[event]||[]).length;
      config.hooks[event]=(config.hooks[event]||[]).filter((entry)=>!isIdleProofHook(entry));
      hooksChanged ||= config.hooks[event].length !== before;
      if (!config.hooks[event].length) delete config.hooks[event];
    }
  }
  if (hooksChanged) writeJsonAtomic(paths.cursorHooks,config);
  let ruleChanged=false;
  try {
    const rule=fs.readFileSync(paths.cursorRule,'utf8');
    if (rule.includes(RULE_MARKER)) { fs.rmSync(paths.cursorRule,{force:true}); ruleChanged=true; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return hooksChanged || ruleChanged;
}

export function hasCursorInstall(cwd=process.cwd()) {
  const paths=projectPaths(cwd);
  const config=readJson(paths.cursorHooks);
  const hook=Object.values(config.hooks||{}).some((entries)=>(entries||[]).some(isIdleProofHook));
  let rule=false;
  try { rule=fs.readFileSync(paths.cursorRule,'utf8').includes(RULE_MARKER); } catch {}
  return hook && rule;
}

export const __cursorInstallTest={RULE_MARKER,EVENTS};
