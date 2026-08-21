#!/usr/bin/env node
import net from 'node:net';
import { main } from '../src/cli.mjs';
import { learningCliHelp, runLearningCli } from '../src/learning-cli.mjs';
import { runDemo } from '../src/demo.mjs';

const args = process.argv.slice(2);

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isInteger(port) || port < 1) reject(new Error('Could not allocate a local IdleProof port.'));
        else resolve(port);
      });
    });
  });
}

async function runtimeArgs(cmd) {
  if (!['on', 'start'].includes(cmd) || args.includes('--port')) return args;
  // Normal users should not have to understand ports. Pick a free loopback port for background
  // mode; an explicit --port remains strict and is never silently changed.
  return [...args, '--port', String(await freeLoopbackPort())];
}

async function run() {
  const cmd = args[0] || 'help';
  if (['help', '--help', '-h'].includes(cmd)) {
    await main(args);
    process.stdout.write(`${learningCliHelp()}\n`);
    return;
  }
  if (cmd === 'demo') {
    await runDemo(args.slice(1));
    return;
  }
  if (await runLearningCli(args)) return;
  await main(await runtimeArgs(cmd));
}

run().catch((error) => {
  console.error(`[idleproof] ${error?.stack || error}`);
  process.exitCode = 1;
});
