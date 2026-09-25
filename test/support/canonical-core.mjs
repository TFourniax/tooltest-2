// Deterministic stand-in for Core's canonical `state extract` in unit tests. Each test declares the
// facts Core observes for a file; a declared symbol is emitted only when it occurs in the bytes
// actually sent, so edited sources yield fresh facts. The consumer's full admission path (bytes,
// hashes, schema, provider, lines) still applies. Integration with the real Core runs in the
// real-Core CI jobs.
import {createHash} from 'node:crypto';
import {structureLanguageFor} from '../../src/structure-provider.mjs';

const provider=language=>language==='python'?'python-ast':language==='csharp'?'tree-sitter-c-sharp':`tree-sitter-${language}`;

export function canonicalCore(facts={},calls=[]) {
  return {command:'fixture-core',run:(command,args,options)=>{
    const request=JSON.parse(options.input), details=request.schema_version==='structure-request-2';
    calls.push(request.files.map(file=>file.path));
    const files=request.files.map(file=>{
      const text=Buffer.from(file.content_base64,'base64').toString('utf8'), language=structureLanguageFor(file.path);
      const lines=text.split(/\r\n|\r|\n/);
      const declared=facts[file.path]||facts[file.path.split('/').at(-1)]||{};
      const module=language==='python'?file.path.slice(0,-3).replace(/\/?__init__$/,'').replaceAll('/','.'):file.path;
      const lineOf=name=>lines.findIndex(line=>line.includes(name))+1;
      const symbols=(declared.symbols||[]).filter(name=>lineOf(name)>0).map(name=>({
        qualified_name:language==='python'?`${module}.${name}`:`${file.path}::${name}`,kind:'function',
        line:lineOf(name),end_line:lineOf(name),epistemic_status:'OBSERVED',local_call_name:name}));
      const imports=(declared.imports||[]).map(target=>details
        ?{target,epistemic_status:'OBSERVED',source_target:null,members:null,line:null,end_line:null}
        :{target,epistemic_status:'OBSERVED'});
      return {schema_version:details?'structure-extraction-2':'structure-extraction-1',path:file.path,language,provider:provider(language),
        source_sha256:createHash('sha256').update(Buffer.from(file.content_base64,'base64')).digest('hex'),module,
        parsed:declared.parsed!==false,symbols:declared.parsed===false?[]:symbols,imports:declared.parsed===false?[]:imports,calls:[]};
    });
    const parsed=files.filter(file=>file.parsed).length;
    return {status:0,stdout:Buffer.from(JSON.stringify({schema_version:details?'structure-response-2':'structure-response-1',files,
      coverage:{files:files.length,parsed,unparsed:files.length-parsed,unsupported:0}}))};
  }};
}

// Core failure modes observed or possible at the process boundary.
export const failingCore={
  timeout:{command:'fixture-core',run:()=>({error:Object.assign(new Error('spawnSync fixture-core ETIMEDOUT'),{code:'ETIMEDOUT'}),status:null,signal:'SIGTERM',stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)})},
  missing:{command:'fixture-core',run:()=>({error:Object.assign(new Error('spawnSync fixture-core ENOENT'),{code:'ENOENT'}),status:null,signal:null})},
  exit:{command:'fixture-core',run:()=>({status:2,signal:null,stdout:Buffer.alloc(0),stderr:Buffer.from('failed')})},
  garbage:{command:'fixture-core',run:()=>({status:0,signal:null,stdout:Buffer.from('{not json'),stderr:Buffer.alloc(0)})}
};
