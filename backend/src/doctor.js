// Startup check (Task 7): `cd backend && npm run doctor`
//
// Read-only. Checks the things that actually broke during the first runs on a
// team machine and prints the fix for each failure:
//   * .env missing / CHANGE placeholders / short secrets
//   * DATABASE_URL not matching APP_DB_PASSWORD or PGPORT, or logging in as an admin
//   * database not reachable, payrail_app password out of sync with the Docker
//     volume (28P01), database or schema missing
//   * schema older than the code (e.g. a volume created before the T6 reports)
//   * app role is superuser / can modify the ledger
//   * seed not loaded, trial balance not balanced
// Exit code 0 = all checks passed (warnings allowed), 1 = at least one failure.
// The server runs the database part once at startup (see server.js) and
// prints the same hints, but keeps running so a later `docker compose up` works.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { REPO_ROOT, loadDotEnv } from './config.js';

const OK = 'ok', WARN = 'warn', FAIL = 'FAIL';

// Every function the API calls. Missing ones mean the database predates the code.
export const REQUIRED_FUNCTIONS = [
  'fn_now', 'fn_place_order', 'fn_initiate_payment', 'fn_capture_payment', 'fn_fail_payment',
  'fn_request_refund', 'fn_approve_refund', 'fn_reject_refund', 'fn_request_payout', 'fn_complete_payout',
  'fn_record_settlement', 'fn_reconcile', 'fn_reconciliation_report', 'fn_vendor_balance', 'fn_cart_lines',
  'fn_report_trial_balance', 'fn_report_vendor_statement', 'fn_report_monthly_performance',
  'fn_report_vendor_refund_risk', 'fn_report_settlement_aging', 'fn_report_vendor_payables',
];

// PostgreSQL answers 28P01 both for a wrong password and for a role that does not exist yet.
const PASSWORD_FIX = [
  'Either the database was never built on this server (no payrail_app role yet): scripts/demo-reset.sh --yes',
  'or the payrail_app password stored in the database differs from APP_DB_PASSWORD in .env',
  '(the Docker init hook sets it only when the volume is first created). Non-destructive fix:',
  `  docker compose exec -T db psql -U postgres -d payrail -c "ALTER ROLE payrail_app PASSWORD '<APP_DB_PASSWORD from .env>'"`,
  'or, without Docker:  psql -d payrail -c "ALTER ROLE payrail_app PASSWORD \'<APP_DB_PASSWORD>\'"',
].join('\n');

/** configuration checks (no database access) */
export function checkEnv(env = process.env, { envFile = path.join(REPO_ROOT, '.env') } = {}) {
  const out = [];
  const add = (status, name, msg, fix) => out.push({ status, name, msg, fix });

  const major = Number(process.versions.node.split('.')[0]);
  add(major === 22 ? OK : WARN, 'node', `Node ${process.versions.node}`,
    major === 22 ? undefined : 'The project targets Node 22 (.nvmrc). Other versions usually work but are untested: `nvm use`.');

  if (!existsSync(envFile)) {
    add(FAIL, '.env', `${envFile} not found`, 'cp .env.example .env   then replace every CHANGE… value');
    return out;
  }
  add(OK, '.env', 'found');

  // The two signing secrets must be real (the server refuses placeholders). The database
  // passwords only have to agree with each other and with the database: a placeholder
  // that the Docker volume was created with works, so it is a warning, not a failure.
  // Changing it later needs ALTER ROLE (or a new volume) — editing .env alone breaks the login.
  for (const [name, min] of [['POSTGRES_PASSWORD', 1], ['APP_DB_PASSWORD', 1], ['DATABASE_URL', 1],
    ['JWT_SECRET', 32], ['GATEWAY_WEBHOOK_SECRET', 32]]) {
    const v = env[name];
    const secret = min >= 32;
    if (!v) add(FAIL, name, 'not set', `set ${name} in .env`);
    else if (v.startsWith('CHANGE') || v.includes('CHANGE-')) {
      if (secret) add(FAIL, name, 'still the CHANGE placeholder', `put the output of \`openssl rand -hex 32\` in ${name}`);
      else add(WARN, name, 'still the example placeholder (works locally if the database was created with it; weak)',
        'Fine for a local demo. To change it later, change the password in the database too (ALTER ROLE) — editing .env alone breaks the login.');
    }
    else if (v.length < min) add(FAIL, name, `shorter than ${min} characters`, `openssl rand -hex 32`);
    else add(OK, name, 'set');
  }

  let url;
  try { url = env.DATABASE_URL ? new URL(env.DATABASE_URL) : null; } catch { url = null; }
  if (env.DATABASE_URL && !url) add(FAIL, 'DATABASE_URL', 'not a valid postgres:// URL');
  if (url) {
    const user = decodeURIComponent(url.username);
    const pw = decodeURIComponent(url.password);
    if (user !== 'payrail_app') add(FAIL, 'DATABASE_URL user', `logs in as "${user}"`,
      'The API must run as the least-privilege role: postgres://payrail_app:<APP_DB_PASSWORD>@localhost:<PGPORT>/payrail');
    else add(OK, 'DATABASE_URL user', 'payrail_app');
    if (env.APP_DB_PASSWORD && pw !== env.APP_DB_PASSWORD) add(FAIL, 'DATABASE_URL password',
      'differs from APP_DB_PASSWORD', 'Use the same value in both lines of .env.');
    const port = url.port || '5432';
    if (env.PGPORT && env.PGPORT !== port) add(WARN, 'DATABASE_URL port',
      `URL uses ${port}, PGPORT (the Docker host port) is ${env.PGPORT}`, 'Make the port in DATABASE_URL equal PGPORT.');
  }
  if (!env.PAYRAIL_DEMO_AS_OF) add(WARN, 'PAYRAIL_DEMO_AS_OF', 'not set: reconciliation defaults to today (IST)',
    'Set PAYRAIL_DEMO_AS_OF=2026-10-31 for the reproducible demo categories.');
  else add(OK, 'PAYRAIL_DEMO_AS_OF', env.PAYRAIL_DEMO_AS_OF);
  return out;
}

/** database checks, logged in exactly as the API is (DATABASE_URL) */
export async function checkDatabase(databaseUrl) {
  const out = [];
  const add = (status, name, msg, fix) => out.push({ status, name, msg, fix });
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000,
    options: '-c search_path=payrail' });
  let target = '?';
  try { const u = new URL(databaseUrl); target = `${u.hostname}:${u.port || 5432}${u.pathname}`; } catch { /* reported by checkEnv */ }
  try {
    await client.connect();
  } catch (e) {
    if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || /timeout/i.test(e.message)) {
      add(FAIL, 'database reachable', `nothing answering at ${target} (${e.code || e.message})`,
        'Start it: `docker compose up -d db`, then wait for `docker compose ps` to show "healthy".');
    } else if (e.code === '28P01') {
      add(FAIL, 'payrail_app login', 'password authentication failed (or role missing)', PASSWORD_FIX);
    } else if (e.code === '3D000') {
      add(FAIL, 'database exists', e.message,
        'Docker: the volume was created with another POSTGRES_DB. Local: `db/build.sh payrail` (non-destructive) then seed via scripts/demo-reset.sh.');
    } else if (e.code === '28000') {
      add(FAIL, 'payrail_app role', e.message, 'The schema was never built on this server: `db/build.sh payrail` or a fresh Docker volume.');
    } else {
      add(FAIL, 'database connection', `${e.code ?? ''} ${e.message}`.trim());
    }
    await client.end().catch(() => {});
    return out;
  }
  try {
    add(OK, 'database reachable', target);
    const me = (await client.query(`SELECT current_user AS u, r.rolsuper, r.rolcreaterole,
        pg_has_role(current_user, 'payrail_owner', 'MEMBER') AS is_owner
      FROM pg_roles r WHERE r.rolname = current_user`)).rows[0];
    if (me.rolsuper || me.is_owner) add(FAIL, 'least privilege', `${me.u} is ${me.rolsuper ? 'a superuser' : 'a member of payrail_owner'}`,
      'DATABASE_URL must use payrail_app.');
    else add(OK, 'least privilege', `${me.u} (not superuser, not owner)`);

    const schema = (await client.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'payrail'`)).rowCount;
    if (!schema) {
      add(FAIL, 'schema', 'schema payrail missing', '`db/build.sh payrail` (non-destructive) or a fresh Docker volume.');
      return out;
    }
    const fns = (await client.query(
      `SELECT p.proname, bool_or(has_function_privilege(p.oid, 'EXECUTE')) AS can_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'payrail' AND p.proname = ANY($1) GROUP BY p.proname`, [REQUIRED_FUNCTIONS])).rows;
    const have = new Map(fns.map((r) => [r.proname, r.can_exec]));
    const missing = REQUIRED_FUNCTIONS.filter((f) => !have.has(f));
    const noExec = REQUIRED_FUNCTIONS.filter((f) => have.get(f) === false);
    if (missing.length) {
      const reports = missing.every((f) => f.startsWith('fn_report_'));
      add(FAIL, 'schema up to date', `missing: ${missing.join(', ')}`, reports
        ? 'The database predates Task 6. Non-destructive: docker compose exec -T db psql -U postgres -X -v ON_ERROR_STOP=1 -d payrail -f /payrail/db/schema/32_reports.sql -f /payrail/db/schema/99_privileges.sql'
        : 'Rebuild the demo database: scripts/demo-reset.sh --yes   (DESTRUCTIVE for database "payrail" only)');
    } else if (noExec.length) {
      add(FAIL, 'grants', `payrail_app cannot execute: ${noExec.join(', ')}`,
        'Re-apply grants: psql -d payrail -f db/schema/99_privileges.sql (as the administrator)');
    } else add(OK, 'schema up to date', `${REQUIRED_FUNCTIONS.length} API functions present and executable`);

    const ledgerWrite = (await client.query(`SELECT
        has_table_privilege('payrail.journal_entries', 'INSERT,UPDATE,DELETE,TRUNCATE') AS je,
        has_table_privilege('payrail.ledger_lines', 'INSERT,UPDATE,DELETE,TRUNCATE') AS ll`)).rows[0];
    if (ledgerWrite.je || ledgerWrite.ll) add(FAIL, 'ledger append-only', 'payrail_app has direct write privileges on the ledger',
      'Re-apply db/schema/99_privileges.sql; the ledger is written only through the workflow functions.');
    else add(OK, 'ledger append-only', 'payrail_app has no direct write on journal_entries / ledger_lines');

    const seed = (await client.query(`SELECT count(*)::int AS users,
        count(*) FILTER (WHERE email = 'finance@payrail.demo')::int AS finance,
        (SELECT count(*)::int FROM journal_entries) AS entries FROM users`)).rows[0];
    if (!seed.users) add(WARN, 'demo data', 'no users: the database is empty',
      'Load the deterministic demo data: scripts/demo-reset.sh --yes');
    else if (!seed.finance) add(WARN, 'demo data', `${seed.users} users but no finance@payrail.demo`, 'scripts/demo-reset.sh --yes');
    else add(OK, 'demo data', `${seed.users} users, ${seed.entries} journal entries`);

    const tb = (await client.query(`SELECT debit_paise::text AS d, credit_paise::text AS c, balanced
                                      FROM fn_report_trial_balance(NULL) WHERE is_total`)).rows[0];
    if (tb && !tb.balanced) add(FAIL, 'trial balance', `Σ debit ${tb.d} ≠ Σ credit ${tb.c}`, 'Investigate before the demo.');
    else if (tb) add(OK, 'trial balance', `balanced (Σ = ${tb.d} paise)`);
  } catch (e) {
    add(FAIL, 'database checks', `${e.code ?? ''} ${e.message}`.trim());
  } finally {
    await client.end().catch(() => {});
  }
  return out;
}

/**
 * The test suites and the local-psql reset log in as the ADMINISTRATOR (POSTGRES_USER /
 * POSTGRES_PASSWORD from .env, or PGUSER / PGPASSWORD if exported). The API does not, so a
 * mismatch is a warning: the app runs, but `npm run test:api` / `test:concurrency` fail with
 * 28P01 for user "postgres". Docker keeps the admin password the VOLUME was created with.
 */
export async function checkAdmin(env = process.env, databaseUrl = env.DATABASE_URL) {
  const out = [];
  let host = 'localhost', port = '5432';
  try { const u = new URL(databaseUrl); host = u.hostname; port = u.port || '5432'; } catch { /* reported elsewhere */ }
  const user = env.PGUSER || env.POSTGRES_USER || 'postgres';
  const password = env.PGPASSWORD || env.POSTGRES_PASSWORD;
  const client = new pg.Client({ host: env.PGHOST || host, port: Number(env.PGPORT || port), user, password,
    database: 'postgres', connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    out.push({ status: OK, name: 'admin login (tests)', msg: `${user} can log in` });
  } catch (e) {
    if (e.code === '28P01') {
      out.push({ status: WARN, name: 'admin login (tests)', msg: `password for "${user}" in .env is not the one stored in the database`,
        fix: ['The app is unaffected, but the API / concurrency / e2e tests need it. Docker keeps the admin password the volume',
          'was created with. Non-destructive fix (run in the project folder):',
          `  docker compose exec -T db psql -U ${user} -d postgres -c "ALTER ROLE ${user} PASSWORD '$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)'"`].join('\n') });
    } else if (e.code !== 'ECONNREFUSED') {
      out.push({ status: WARN, name: 'admin login (tests)', msg: `${e.code ?? ''} ${e.message}`.trim() });
    }
  } finally {
    await client.end().catch(() => {});
  }
  return out;
}

export function printChecks(results, log = console.log) {
  for (const r of results) {
    log(`${r.status === OK ? '  ok  ' : r.status === WARN ? ' warn ' : ' FAIL '} ${r.name}: ${r.msg}`);
    if (r.fix && r.status !== OK) log(r.fix.split('\n').map((l) => `        → ${l}`).join('\n'));
  }
}

async function main() {
  loadDotEnv();
  console.log('PayRail doctor (read-only)\n');
  const results = checkEnv();
  printChecks(results);
  if (process.env.DATABASE_URL) {
    console.log('');
    const db = await checkDatabase(process.env.DATABASE_URL);
    if (!db.some((r) => r.name === 'database reachable' && r.status === FAIL)) db.push(...(await checkAdmin()));
    printChecks(db);
    results.push(...db);
  }
  const fails = results.filter((r) => r.status === FAIL).length;
  const warns = results.filter((r) => r.status === WARN).length;
  console.log(`\n${fails ? `${fails} failure(s)` : 'all checks passed'}${warns ? `, ${warns} warning(s)` : ''}`);
  process.exitCode = fails ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
