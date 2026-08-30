#!/usr/bin/env node
/**
 * Starts `next start` on a port that is guaranteed to be serving THIS build.
 *
 * Running `next build` while an old server is up leaves that server answering with chunk
 * names the build has just deleted, so every page dies with "Application error: a
 * client-side exception has occurred" and the E2E suite reports failures that have nothing
 * to do with the code under test. That trap cost real time twice, so restarting is a
 * command rather than a thing to remember: this stops whatever holds the port first, waits
 * for it to actually let go, and only then starts.
 *
 * Usage: node tools/serve.mjs [--port 3000]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > -1 ? process.argv[portArg + 1] : (process.env['PORT'] ?? 3000));

/** Every live Next server process, found without depending on lsof or ss being installed. */
function nextServerPids() {
  const pids = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || entry === String(process.pid)) continue;
    let cmd = '';
    try {
      cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch {
      continue; // the process ended while we were looking at it
    }
    if (/next-server|next start/.test(cmd) && !/tools\/serve\.mjs/.test(cmd)) pids.push(Number(entry));
  }
  return pids;
}

const free = () =>
  new Promise((resolve) => {
    const s = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => s.close(() => resolve(true)))
      .listen(PORT, '127.0.0.1');
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const pid of nextServerPids()) {
  try {
    process.kill(pid, 'SIGKILL');
    console.log(`stopped next server pid ${pid}`);
  } catch {
    /* already gone */
  }
}

// the port outlives the process by a moment; starting before it is free binds nothing
for (let i = 0; i < 40; i++) {
  if (await free()) break;
  if (i === 39) {
    console.error(`port ${PORT} is still held after 10s; not starting a second server`);
    process.exit(1);
  }
  await sleep(250);
}

const child = spawn('npx', ['next', 'start', '--port', String(PORT)], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
