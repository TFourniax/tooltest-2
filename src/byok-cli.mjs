import {configureByok,byokStatus,removeByok,previewByok,interpretByok,testByokConnection} from './byok.mjs';

export async function byokCli(cwd,args) {
  const action=args[0]||'status',value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
  if(args.includes('--key'))throw new Error('Credentials in CLI arguments are forbidden. Use --key-stdin.');
  let result;
  if(action==='configure') {
    if(!args.includes('--key-stdin')||process.stdin.isTTY)throw new Error('Configuration requires --key-stdin from a secret-safe pipe. Never pass or echo a key in an argument.');
    let key='';for await(const chunk of process.stdin){key+=chunk;if(Buffer.byteLength(key)>2048)throw new Error('BYOK_INVALID_CREDENTIAL');}
    try{result=configureByok(cwd,{model:value('--model'),budgetUsd:Number(value('--budget-usd')),maxRequestUsd:Number(value('--max-request-usd')),maxTokens:Number(value('--max-tokens')||800)},key.trim());}finally{key='';}
  }else if(action==='status')result=byokStatus(cwd);
  else if(action==='remove')result=removeByok(cwd);
  else if(action==='test')result=await testByokConnection(cwd,{allowNetwork:args.includes('--allow-network')});
  else if(action==='preview'||action==='explain') {
    const options={source:value('--source')||'HEAD',paths:args.flatMap((v,i)=>v==='--file'?[args[i+1]]:[]),includeSource:args.includes('--include-source'),includeMemory:args.includes('--include-memory'),
      ...(value('--question')?{question:value('--question')}:{})};
    result=action==='preview'?previewByok(cwd,options):await interpretByok(cwd,{...options,consentDigest:value('--consent')});
  }else throw new Error('Usage: idleproof ai configure|status|remove|test|preview|explain. See docs/OPENROUTER_LOCAL.md.');
  console.log(JSON.stringify(result,null,2));
}
