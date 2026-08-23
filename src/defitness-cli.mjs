import { main as idleproofMain } from './cli.mjs';
import { defitnessStatus, installDefitness, uninstallDefitness } from './defitness-install.mjs';

function value(args,key,fallback=null){const index=args.indexOf(key);return index>=0&&args[index+1]!=null?args[index+1]:fallback;}

function help(){
  console.log(`Defitness — understand · prove · owe · remember

One-time project setup:
  defitness install [--agent auto|all|claude,codex,cursor] [--diffwitness-command dw]
  defitness uninstall
  defitness status [--json]
  defitness doctor

Then use Claude Code, Codex or Cursor normally. Defitness runs locally through the IDE lifecycle:
  IdleProof   understands/explains the active task
  DiffWitness proves the exact completed change
  Debt Ledger records inspectable software obligations
  Continuity  maintains structured project memory
  Portal      optionally syncs bounded metadata without source, raw prompts or raw diffs

Compatibility:
  All other commands are delegated to the existing IdleProof CLI, so current community workflows
  remain available during the pre-release transition.`);
}

function printStatus(status,json=false){
  if(json){console.log(JSON.stringify(status,null,2));return;}
  console.log(`${status.healthy?'✓':'✗'} Defitness ${status.healthy?'ready':'not ready'}`);
  console.log(`  DiffWitness: ${status.diffWitness.ok?'ready':'missing/degraded'}${status.diffWitness.command?` · ${status.diffWitness.command}`:''}`);
  for(const name of ['claude','codex','cursor']){
    const expected=status.expectedAdapters.includes(name);
    console.log(`  ${name}: ${status.adapters[name]?'installed':expected?'MISSING':'not selected'}`);
  }
  if(status.configError)console.log(`  config: INVALID · ${status.configError}`);
}

export async function main(args=[]){
  const [command='help']=args;
  const cwd=process.cwd();
  if(['help','--help','-h'].includes(command))return help();
  if(command==='install'){
    const result=installDefitness({
      cwd,
      agent:value(args,'--agent','auto'),
      diffWitnessCommand:value(args,'--diffwitness-command',process.env.DEFITNESS_DIFFWITNESS_BIN||'dw')
    });
    console.log(`✓ Defitness armed for ${result.adapters.join(', ')}`);
    console.log(`✓ DiffWitness bridge: ${result.diffWitnessCommand}`);
    console.log('✓ One native hook path now coordinates UNDERSTAND · PROVE · OWE · CONTINUITY.');
    console.log('Use your coding agent normally; no wrapper command is required.');
    return;
  }
  if(command==='uninstall'){
    const result=uninstallDefitness({cwd});
    console.log(`✓ Defitness project integration removed${result.removed.length?` · ${result.removed.join(', ')}`:''}.`);
    console.log('Historical IdleProof/Continuity evidence was not deleted.');
    return;
  }
  if(command==='status'||command==='doctor'){
    const status=defitnessStatus(cwd);
    printStatus(status,args.includes('--json'));
    if(!status.healthy)process.exitCode=1;
    return;
  }
  if(command==='on'){
    installDefitness({
      cwd,
      agent:value(args,'--agent','auto'),
      diffWitnessCommand:value(args,'--diffwitness-command',process.env.DEFITNESS_DIFFWITNESS_BIN||'dw')
    });
    const pass=args.slice(1).filter((item,index,list)=>{
      if(item==='--agent'||item==='--diffwitness-command')return false;
      if(index>0&&['--agent','--diffwitness-command'].includes(list[index-1]))return false;
      return true;
    });
    await idleproofMain(['start',...pass]);
    return;
  }
  return idleproofMain(args);
}
