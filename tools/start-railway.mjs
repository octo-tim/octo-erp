#!/usr/bin/env node
/**
 * Runs the web server and the outbox worker as one Railway service.
 *
 * They share a service because they share a filesystem: attachments are uploaded by the web
 * process and destroyed by the worker's retention run, and a Railway volume can only be
 * mounted on one service. Splitting them would leave the worker unable to delete the files
 * it is legally required to destroy — and it would fail quietly, in a job nobody watches.
 *
 * Running two processes under one supervisor introduces its own quiet failure: if the worker
 * dies, the web server keeps answering and the outbox silently stops draining. That is the
 * exact shape of bug this project has already had to fix twice, so this supervisor treats
 * either child exiting as fatal, exits non-zero, and lets Railway's ON_FAILURE policy restart
 * the whole thing. A visibly restarting service is far better than a half-dead one.
 */
import { spawn } from 'node:child_process';

const children = new Map();
let shuttingDown = false;

function start(name, command, args) {
  const child = spawn(command, args, { stdio: 'inherit', env: process.env });
  children.set(name, child);

  child.on('exit', (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;
    console.error(
      JSON.stringify({
        level: 50,
        msg: `${name} exited unexpectedly; stopping the service so it restarts`,
        name,
        code,
        signal,
      }),
    );
    stopAll('SIGTERM');
    // give the sibling a moment to shut down cleanly before the process ends
    setTimeout(() => process.exit(code === 0 ? 1 : (code ?? 1)), 5000).unref();
  });

  child.on('error', (err) => {
    console.error(JSON.stringify({ level: 50, msg: `${name} failed to start`, err: err.message }));
    process.exit(1);
  });

  return child;
}

function stopAll(signal) {
  shuttingDown = true;
  for (const [, child] of children) child.kill(signal);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopAll(signal);
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

start('web', 'node', ['server.js']);
start('worker', 'npx', ['tsx', 'src/server/jobs/worker.ts']);
