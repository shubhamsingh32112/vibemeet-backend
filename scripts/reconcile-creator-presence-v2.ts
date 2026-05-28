/**
 * Periodic reconciliation — idempotent alias for backfill-creator-presence-v2.
 *
 * Usage (from backend/):
 *   npx ts-node scripts/reconcile-creator-presence-v2.ts
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';

execSync('npx ts-node scripts/backfill-creator-presence-v2.ts', {
  cwd: join(__dirname, '..'),
  stdio: 'inherit',
  env: process.env,
});
