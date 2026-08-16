#!/usr/bin/env node
import { main } from '../src/cli.mjs';
import { learningCliHelp, runLearningCli } from '../src/learning-cli.mjs';

const args = process.argv.slice(2);

async function run() {
  const cmd = args[0] || 'help';
  if (['help', '--help', '-h'].includes(cmd)) {
    await main(args);
    process.stdout.write(`${learningCliHelp()}\n`);
    return;
  }
  if (await runLearningCli(args)) return;
  await main(args);
}

run().catch((error) => {
  console.error(`[idleproof] ${error?.stack || error}`);
  process.exitCode = 1;
});
