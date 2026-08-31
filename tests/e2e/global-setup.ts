import { execFileSync } from 'node:child_process';

/** See tools/e2e-prepare.ts for why this runs out of process. */
export default function globalSetup(): void {
  execFileSync('npx', ['tsx', 'tools/e2e-prepare.ts'], { stdio: 'inherit' });
}
