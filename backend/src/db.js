// PostgreSQL access (Task 3, DEC-003, DEC-013).
//
// * The pool logs in as payrail_app (never the owner/superuser); DATABASE_URL
//   carries those credentials.
// * int8 (BIGINT: ids and paise) and numeric stay STRINGS — the pg default; we
//   never install a parseInt type parser, so no value is squeezed through a
//   JavaScript Number. `date` is also kept as the 'YYYY-MM-DD' string (the
//   default would turn it into a local-midnight Date and could shift the day).
// * withTransaction runs BEGIN … COMMIT on ONE checked-out client; every query
//   of the transaction must use the `client` it is given.
import pg from 'pg';

pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createPool(databaseUrl) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: 'payrail-backend',
    max: 10,
    // unqualified names resolve to schema payrail; statement_timeout bounds a stuck request
    options: '-c search_path=payrail -c statement_timeout=15000',
  });
  pool.on('error', (e) => console.error('idle PostgreSQL client error:', e.message));
  return pool;
}

export function makeDb(pool) {
  return {
    pool,

    /** single statement in autocommit mode (one workflow function call = one transaction) */
    async query(sql, params = []) {
      return pool.query(sql, params);
    },

    async one(sql, params = []) {
      const { rows } = await pool.query(sql, params);
      return rows[0] ?? null;
    },

    async withClient(fn) {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },

    /** BEGIN (READ COMMITTED, the default the workflows require — DEC-028) … COMMIT, or ROLLBACK on error */
    async withTransaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
