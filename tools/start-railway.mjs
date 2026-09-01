#!/usr/bin/env node
/**
 * The whole startup sequence for the Railway service, as one command.
 *
 * It is one command on purpose. The start command used to be
 * `npx prisma migrate deploy && npx tsx prisma/seed.ts && node tools/start-railway.mjs`,
 * and the container's ENTRYPOINT execs it through gosu rather than a shell — so `&&` was
 * passed as an argument instead of being interpreted. Migrations ran, everything after them
 * silently did not, and the deploy failed its healthcheck five minutes later with no error
 * to point at. Nothing here relies on shell operators now.
 *
 * The web server and the outbox worker then run side by side because they share a
 * filesystem: attachments are written by the web process and destroyed by the worker's
 * retention run, and a Railway volume mounts on only one service. Splitting them would leave
 * the worker unable to delete the files it is required to destroy.
 *
 * Either child exiting is fatal. A worker that dies quietly while the web server keeps
 * answering is the failure this project has already had to fix twice: the outbox stops
 * draining, notifications stop arriving, and every health indicator still looks fine. A
 * visibly restarting service is much better than a half-dead one.
 */
import { spawn } from 'node:child_process';

const children = new Map();
let shuttingDown = false;

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ level, msg, at: new Date().toISOString(), ...extra }));
}

/** Runs a command to completion. Resolves only on exit code 0. */
function run(name, command, args) {
  return new Promise((resolve, reject) => {
    log(30, `${name} starting`);
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.on('error', (err) => reject(new Error(`${name} could not start: ${err.message}`)));
    child.on('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${name} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

function supervise(name, command, args) {
  const child = spawn(command, args, { stdio: 'inherit', env: process.env });
  children.set(name, child);

  child.on('exit', (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;
    log(50, `${name} exited unexpectedly; stopping the service so it restarts`, { code, signal });
    stopAll('SIGTERM');
    setTimeout(() => process.exit(code === 0 ? 1 : (code ?? 1)), 5000).unref();
  });

  child.on('error', (err) => {
    log(50, `${name} failed to start`, { err: err.message });
    process.exit(1);
  });
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

async function main() {
  await run('migrate', 'npx', ['prisma', 'migrate', 'deploy']);

  /**
   * Seeding is opt-in per deploy, not automatic. The seed is idempotent, but it resets every
   * role's permissions to the presets — so running it on each boot would silently undo any
   * change an administrator made on the 권한 screen. Set SEED_ON_START=1 for a first
   * deployment, then remove it.
   */
  if (process.env['SEED_ON_START'] === '1') {
    await run('seed', 'npx', ['tsx', 'prisma/seed.ts']);
  } else {
    log(30, 'skipping seed; set SEED_ON_START=1 to run it on the next deploy');
  }

  supervise('web', 'node', ['server.js']);
  supervise('worker', 'npx', ['tsx', 'src/server/jobs/worker.ts']);
  log(30, 'web and worker started');
}

main().catch((err) => {
  log(50, 'startup failed', { err: err.message });
  process.exit(1);
});
