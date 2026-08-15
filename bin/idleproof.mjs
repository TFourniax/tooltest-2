#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).catch((error) => {
  console.error(`[idleproof] ${error?.stack || error}`);
  process.exitCode = 1;
});
