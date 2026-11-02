// API integration-test setup (Task 3).
//
// Each test file gets a freshly rebuilt and SEEDED database `payrail_apitest`
// (db/reset_dev.sh — destructive only for that dedicated name). The app under
// test connects as the real application role payrail_app; an admin connection
// is used only to inspect results (ledger rows, balances).
//
// Environment: see test/_env.js (root .env is loaded; PG* default to the
// compose administrator). PAYRAIL_REBUILD_VIA_DOCKER=1 rebuilds inside the
// compose container; PAYRAIL_API_SKIP_REBUILD=1 skips the rebuild.
import { APP_PASSWORD, resetDatabase } from '../_env.js';
import crypto from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
export const DB = process.env.PAYRAIL_API_DB || 'payrail_apitest';
export const PASSWORD = 'PayRail@2026';                 // every seeded login (db/seed/seed.sql)

export const config = {
  databaseUrl: process.env.PAYRAIL_API_DATABASE_URL ||
    `postgres://payrail_app:${encodeURIComponent(APP_PASSWORD)}@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${DB}`,
  jwtSecret: crypto.randomBytes(32).toString('hex'),
  jwtExpiresIn: '1h',
  gatewaySecret: crypto.randomBytes(32).toString('hex'),
  mockGatewayEnabled: true,
  port: 0,
  demoAsOf: '2026-10-31',
  logErrors: process.env.API_TEST_LOG === '1',
};

export function rebuildDatabase() {
  if (process.env.PAYRAIL_API_SKIP_REBUILD === '1') return;      // you rebuilt it yourself
  resetDatabase(DB, { seed: true });
}

export async function start() {
  rebuildDatabase();
  const pool = createPool(config.databaseUrl);
  const app = createApp(config, { pool });
  const admin = new pg.Client({ database: DB });
  await admin.connect();
  await admin.query('SET search_path = payrail');
  const tokens = {};
  const ctx = {
    app, pool, admin,
    api: () => request(app),
    /** log users in once (bcrypt is slow); afterwards ctx.as(user) is synchronous */
    async login(...users) {
      for (const u of users) {
        const email = emailOf(u);
        if (tokens[email]) continue;
        const r = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
        if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
        tokens[email] = r.body.token;
      }
    },
    /** supertest request with the user's bearer token: ctx.as('customer1').get('/api/orders') */
    as(user) {
      const tok = tokens[emailOf(user)];
      if (!tok) throw new Error(`call ctx.login('${user}') first`);
      const wrap = (m) => (url) => request(app)[m](url).set('Authorization', `Bearer ${tok}`);
      return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
    },
    async q(sql, params) { return (await admin.query(sql, params)).rows; },
    async one(sql, params) { return (await admin.query(sql, params)).rows[0]; },
    async stop() { await pool.end(); await admin.end(); },
  };
  return ctx;
}

const emailOf = (u) => (u.includes('@') ? u : `${u}@payrail.demo`);
export const key = () => crypto.randomUUID();

/** test instruments the simulated gateway approves (DEC-038) */
export const APPROVE = {
  upi: { vpa: 'success@payrail' },
  card: { number: '4111 1111 1111 1111', expiry: '12/30', cvv: '123' },
  netbanking: { bank: 'PAYRAIL_TEST_BANK' },
};

/** place an order and pay it at the mock gateway's hosted checkout; returns { order, payment } */
export async function paidOrder(ctx, customer, items, method = 'upi') {
  await ctx.login(customer);
  const o = await ctx.as(customer).post('/api/orders').send({ items });
  if (o.status !== 201) throw new Error(`order: ${o.status} ${JSON.stringify(o.body)}`);
  const p = await ctx.as(customer).post(`/api/orders/${o.body.order_id}/payments`).set('Idempotency-Key', key()).send({ method });
  if (p.status !== 201) throw new Error(`payment: ${p.status} ${JSON.stringify(p.body)}`);
  const s = await ctx.as(customer).post(`/api/mock-gateway/checkout/${p.body.payment_id}`).send({ action: 'pay', instrument: APPROVE[method] });
  if (s.body.payment?.status !== 'captured') throw new Error(`capture: ${JSON.stringify(s.body)}`);
  return { order: o.body, payment: s.body.payment };
}
