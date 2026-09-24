import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readIntegrationConfig } from './diffwitness-integration-config.mjs';

const MAX_FILES=64, MAX_FILE_BYTES=128*1024, MAX_TOTAL_BYTES=640*1024;
const RESPONSE_BYTES=2*1024*1024, TIMEOUT_MS=500;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,expected)=>object(value)&&Object.keys(value).sort().join('|')===[...expected].sort().join('|');
const text=value=>typeof value==='string'&&value.length>0&&value.length<=8192;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const safePath=value=>typeof value==='string'&&value.length>0&&value.length<=4096
  &&!/[\\:\u0000-\u001f\u007f]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');

const SYNTAX = new Map([
  ['.py',['python','python-ast']],
  ...['.js','.jsx','.mjs','.cjs'].map(suffix=>[suffix,['javascript','tree-sitter-javascript']]),
  ...['.ts','.tsx','.mts','.cts'].map(suffix=>[suffix,['typescript','tree-sitter-typescript']]),
  ['.go',['go','tree-sitter-go']],['.rs',['rust','tree-sitter-rust']],
  ['.java',['java','tree-sitter-java']],['.cs',['csharp','tree-sitter-c-sharp']],
  ...['.kt','.kts'].map(suffix=>[suffix,['kotlin','tree-sitter-kotlin']]),
  ...['ruby','php','sql','json','toml','yaml'].map(language=>[language==='ruby'?'.rb':'.'+language,[language,'tree-sitter-'+language]]),
  ['.yml',['yaml','tree-sitter-yaml']]
]);
const specFor=relative=>typeof relative==='string'&&relative.lastIndexOf('.')>relative.lastIndexOf('/')+1
  ? SYNTAX.get(relative.slice(relative.lastIndexOf('.'))) : undefined;
export const supportsStructurePath=relative=>Boolean(specFor(relative));
export const structureLanguageFor=relative=>specFor(relative)?.[0]||null;

export function validStructureExtractions(response,sources,{details=false}={}) {
  if (typeof details!=='boolean'||!Array.isArray(sources)||!keys(response,['schema_version','files','coverage'])
      ||response.schema_version!==(details?'structure-response-2':'structure-response-1')
      ||!Array.isArray(response.files)||response.files.length!==sources.length) return false;
  let parsed=0;
  for (let index=0;index<sources.length;index+=1) {
    const source=sources[index],value=response.files[index],spec=specFor(source?.relative);
    if(!spec||!object(source)||typeof source.text!=='string'||!safePath(source.relative)) return false;
    if (!keys(value,['path','language','provider','source_sha256','module','parsed','symbols','imports','calls','schema_version'])
        ||value.schema_version!==(details?'structure-extraction-2':'structure-extraction-1')||value.path!==source.relative
        ||value.source_sha256!==source.sha256||value.provider!==spec[1]||value.language!==spec[0]
        ||typeof value.parsed!=='boolean'||typeof value.module!=='string'||value.module.length>8192) return false;
    if(value.language==='python') {
      const module=source.relative.slice(0,-3).split('/');
      if(module.at(-1)==='__init__') module.pop();
      if(value.module!==module.join('.')) return false;
    } else if(value.module!==source.relative) return false;
    const maxLine=source.text.split(/\r\n|\r|\n/).length;
    const line=value=>Number.isInteger(value)&&value>=1&&value<=maxLine;
    for(const name of ['symbols','imports','calls']) {
      if(!Array.isArray(value[name])||value[name].length>100000||(!value.parsed&&value[name].length)) return false;
    }
    for(const symbol of value.symbols) {
      if(!keys(symbol,['qualified_name','kind','line','end_line','epistemic_status','local_call_name'])
          ||!text(symbol.qualified_name)||!text(symbol.kind)||!line(symbol.line)||!line(symbol.end_line)
          ||symbol.end_line<symbol.line||symbol.epistemic_status!=='OBSERVED'
          ||!(symbol.local_call_name===null||text(symbol.local_call_name))) return false;
      if(value.language!=='python'&&(!symbol.qualified_name.startsWith(`${source.relative}::`)
          ||symbol.qualified_name.length<=source.relative.length+2)) return false;
    }
    for(const imported of value.imports) {
      if(!keys(imported,details?['target','epistemic_status','source_target','members','line','end_line']:['target','epistemic_status'])
          ||!text(imported.target)||imported.epistemic_status!=='OBSERVED') return false;
      if(details&&(!(imported.source_target===null||text(imported.source_target))
          ||!(imported.members===null||(Array.isArray(imported.members)&&imported.members.length<=100000&&imported.members.every(text)))
          ||!((imported.line===null&&imported.end_line===null)
               ||(line(imported.line)&&line(imported.end_line)&&imported.end_line>=imported.line)))) return false;
    }
    for(const call of value.calls) {
      if(!keys(call,['name','line','epistemic_status'])||!text(call.name)||!line(call.line)||call.epistemic_status!=='INFERRED') return false;
    }
    parsed+=Number(value.parsed);
  }
  return keys(response.coverage,['files','parsed','unsupported','unparsed'])
    &&response.coverage.files===sources.length&&response.coverage.parsed===parsed
    &&response.coverage.unsupported===0&&response.coverage.unparsed===sources.length-parsed;
}

export function loadStructureExtractions(cwd,sources,{command=null,run=spawnSync,details=false,timeoutMs=TIMEOUT_MS,onFailure=null}={}) {
  const started=typeof onFailure==='function' ? performance.now() : null;
  let processResult=null;
  const unavailable=(reason,stage='admission',failure=null)=>{
    if(started!==null) {
      const code=failure?.code || processResult?.error?.code;
      const allowedCodes=new Set(['ETIMEDOUT','ENOENT','EACCES','EPERM','EAGAIN','ENOBUFS','EBUSY']);
      const signal=processResult?.signal;
      const diagnostic={schema:'idleproof-extraction-failure-1',classification:'MACHINE',qualification:false,
        reason,stage,elapsedMs:performance.now()-started,
        code:typeof code==='string' ? allowedCodes.has(code)?code:'other' : null,
        status:Number.isInteger(processResult?.status)?processResult.status:null,
        signal:['SIGTERM','SIGKILL','SIGABRT','SIGSEGV','SIGINT'].includes(signal)?signal:null,
        stdoutBytes:Buffer.isBuffer(processResult?.stdout)?processResult.stdout.length:null,
        stderrBytes:Buffer.isBuffer(processResult?.stderr)?processResult.stderr.length:null};
      // Diagnostic consumers cannot promote results, retry, or change failures.
      try {Promise.resolve(onFailure(diagnostic)).catch(()=>{});} catch {}
    }
    return {byPath:new Map(),reason};
  };
  if(typeof details!=='boolean'||!Number.isInteger(timeoutMs)||timeoutMs<=0||timeoutMs>TIMEOUT_MS)
    return unavailable('invalid-extraction-options');
  if(!Array.isArray(sources)||sources.length>MAX_FILES) return unavailable('invalid-source-batch');
  if(!sources.length) return unavailable('no-supported-sources');
  let total=0;
  const paths=new Set(),files=[];
  for(const source of sources) {
    if(!object(source)||!safePath(source.relative)||!supportsStructurePath(source.relative)
        ||paths.has(source.relative)||typeof source.text!=='string') return unavailable('invalid-source-batch');
    const bytes=Buffer.from(source.text,'utf8');
    total+=bytes.length;
    if(bytes.length>MAX_FILE_BYTES||total>MAX_TOTAL_BYTES||sha(bytes)!==source.sha256) return unavailable('invalid-source-batch');
    paths.add(source.relative);
    files.push({path:source.relative,content_base64:bytes.toString('base64')});
  }
  if(!command) {
    try {
      command=readIntegrationConfig(cwd,{migrateLegacy:false})?.diffWitnessCommand||process.env.DIFFWITNESS_BIN||process.env.DEFITNESS_DIFFWITNESS_BIN||'dw';
    } catch { return unavailable('invalid-integration-configuration'); }
  }
  try {
    const result=processResult=run(command,['state','extract','--json'],{cwd,input:JSON.stringify({schema_version:details?'structure-request-2':'structure-request-1',files}),
      windowsHide:true,timeout:timeoutMs,maxBuffer:RESPONSE_BYTES});
    if(result.error||result.status!==0) return unavailable('core-extraction-unavailable','process');
    if(!Buffer.isBuffer(result.stdout)||result.stdout.length>RESPONSE_BYTES) return unavailable('core-extraction-rejected','protocol');
    const raw=new TextDecoder('utf-8',{fatal:true}).decode(result.stdout);
    const response=JSON.parse(raw);
    // Core emits canonical strings/numbers. A lossless native JSON round-trip
    // rejects duplicate keys and alternate encodings without a second parser.
    const compact=raw.replace(/("(?:\\.|[^"\\])*")|\s+/g, (match,string)=>string??'');
    if(JSON.stringify(response)!==compact) return unavailable('core-extraction-rejected','protocol');
    if(!validStructureExtractions(response,sources,{details})) return unavailable('core-extraction-rejected','protocol');
    return {byPath:new Map(response.files.map(file=>[file.path,file])),reason:null};
  } catch(error) { return unavailable('core-extraction-rejected',processResult?'protocol':'process',error); }
}

// Preserve the original Python-only API while all languages share admission.
const pythonSource=source=>specFor(source?.relative)?.[0]==='python';
export const validPythonExtractions=(response,sources)=>Array.isArray(sources)
  &&sources.every(pythonSource)&&validStructureExtractions(response,sources);
export function loadPythonExtractions(cwd,sources,options) {
  if(!Array.isArray(sources)||!sources.every(pythonSource))
    return {byPath:new Map(),reason:'invalid-source-batch'};
  if(!sources.length) return {byPath:new Map(),reason:'no-python-sources'};
  return loadStructureExtractions(cwd,sources,options);
}
