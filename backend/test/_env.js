// Shared test environment (imported FIRST by test/api/_setup.js and
// test/concurrency/harness.js).
//
// Loads the repository-root .env (never overriding variables already set) and
// derives the admin libpq variables from it when they are not set:
//   PGHOST ← localhost, PGUSER ← POSTGRES_USER, PGPASSWORD ← POSTGRES_PASSWORD
// (PGPORT comes from .env directly). So on a Docker machine the tests need no
// extra exports: they reach the compose database as its administrator for
// setup/inspection and as payrail_app (APP_DB_PASSWORD) for the code under test.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../src/config.js';

loadDotEnv();
for (const [pgVar, fallback] of [['PGHOST', 'localhost'], ['PGUSER', process.env.POSTGRES_USER],
  ['PGPASSWORD', process.env.POSTGRES_PASSWORD]]) {
  if (!process.env[pgVar] && fallback) process.env[pgVar] = fallback;   // (assigning undefined would store "undefined")
}

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const APP_PASSWORD = process.env.APP_DB_PASSWORD || 'payrail_app_dev_only';

/**
 * DESTRUCTIVE rebuild of a dedicated test database (reset_dev.sh only accepts
 * payrail / payrail_<suffix>). PAYRAIL_REBUILD_VIA_DOCKER=1 runs it inside the
 * compose container (no local psql needed).
 */
export function resetDatabase(db, { seed = true } = {}) {
  const skipSeed = seed ? '0' : '1';
  if (process.env.PAYRAIL_REBUILD_VIA_DOCKER === '1') {
    execFileSync('docker', ['compose', 'exec', '-T', '-e', `PAYRAIL_SKIP_SEED=${skipSeed}`, 'db',
      'bash', '/payrail/db/reset_dev.sh', '--yes', db], { cwd: REPO, stdio: 'pipe' });
    return;
  }
  execFileSync(path.join(REPO, 'db/reset_dev.sh'), ['--yes', db], {
    env: { ...process.env, APP_DB_PASSWORD: APP_PASSWORD, PAYRAIL_SKIP_SEED: skipSeed }, stdio: 'pipe',
  });
}
