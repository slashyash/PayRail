// Concurrency test harness (Task 2, DEC-012, DEC-019).
//
// Every worker is an INDEPENDENT PostgreSQL connection logged in as the real
// application role payrail_app — not sequential calls on one connection.
//
// race(n, work):
//   1. the admin connection takes an exclusive advisory lock (the barrier);
//   2. each worker opens a transaction and asks for a SHARED advisory lock on
//      the same key, so all n workers block at the same point;
//   3. once pg_locks shows n waiters, the admin releases the barrier and all
//      workers call the workflow function at the same moment;
//   4. each worker then HOLDS its transaction open for `holdMs` before COMMIT,
//      so the other workers' calls genuinely overlap with an uncommitted
//      writer (a missing lock would show up as overspending / double posting);
//   5. while they run, the admin samples pg_stat_activity and records the
//      largest number of workers waiting on a row/transaction lock — evidence
//      that the race really contended.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '../../..');
export const DB = process.env.PAYRAIL_CONC_DB || 'payrail_conc';
const APP_PASSWORD = process.env.APP_DB_PASSWORD || 'payrail_app_dev_only';
const BARRIER_KEY = 4242;

export function rebuildDatabase() {
  // DESTRUCTIVE only for the dedicated test database (reset_dev.sh guards the name).
  // Without a local psql (e.g. only Docker on a Mac), rebuild it inside the container instead:
  //   docker compose exec -T db bash /payrail/db/reset_dev.sh --yes payrail_conc
  // and run the tests with PAYRAIL_CONC_SKIP_REBUILD=1 (the seeded demo rows do not disturb them).
  if (process.env.PAYRAIL_CONC_SKIP_REBUILD === '1') return;
  execFileSync(path.join(REPO, 'db/reset_dev.sh'), ['--yes', DB], {
    env: { ...process.env, PAYRAIL_SKIP_SEED: '1', APP_DB_PASSWORD: APP_PASSWORD },
    stdio: 'pipe',
  });
}

export async function adminClient() {
  const c = new pg.Client({ database: DB });          // PGHOST/PGPORT/PGUSER/PGPASSWORD from env
  await c.connect();
  await c.query('SET search_path = payrail, public');
  return c;
}

export async function appClient() {
  const c = new pg.Client({ database: DB, user: 'payrail_app', password: APP_PASSWORD });
  await c.connect();
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function race(n, work, { holdMs = 200 } = {}) {
  const admin = await adminClient();
  const workers = await Promise.all(Array.from({ length: n }, () => appClient()));
  await admin.query('SELECT pg_advisory_lock($1)', [BARRIER_KEY]);

  const runs = workers.map(async (c, i) => {
    await c.query('BEGIN');                                   // READ COMMITTED (default)
    await c.query('SELECT pg_advisory_xact_lock_shared($1)', [BARRIER_KEY]);
    try {
      const value = await work(c, i);
      await c.query('SELECT pg_sleep($1)', [holdMs / 1000]);  // keep the writer uncommitted a while
      await c.query('COMMIT');
      return { ok: true, value };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      return { ok: false, code: e.code, message: e.message };
    }
  });

  // wait until every worker is blocked on the barrier
  for (let t = 0; ; t++) {
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND objid = $1 AND NOT granted`, [BARRIER_KEY]);
    if (rows[0].n === n) break;
    if (t > 500) throw new Error('workers never reached the barrier');
    await sleep(10);
  }

  await admin.query('SELECT pg_advisory_unlock($1)', [BARRIER_KEY]);
  let maxBlocked = 0;
  let done = false;
  const all = Promise.all(runs).then((r) => { done = true; return r; });
  while (!done) {
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE usename = 'payrail_app' AND datname = $1
          AND wait_event_type = 'Lock' AND wait_event <> 'advisory'`, [DB]);
    maxBlocked = Math.max(maxBlocked, rows[0].n);
    await sleep(5);
  }
  const results = await all;
  await Promise.all(workers.map((c) => c.end()));
  await admin.end();
  return { results, maxBlocked };
}

export function tally(results) {
  const t = { ok: 0 };
  for (const r of results) {
    if (r.ok) t.ok++;
    else t[r.code] = (t[r.code] || 0) + 1;
  }
  return t;
}

export const uuid = (n) => `9${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`;
