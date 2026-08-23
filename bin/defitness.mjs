#!/usr/bin/env node
import { main } from '../src/defitness-cli.mjs';

main(process.argv.slice(2)).catch((error)=>{
  console.error(`Defitness: ${error?.message || error}`);
  process.exitCode=1;
});
