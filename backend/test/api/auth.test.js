// Authentication, role guards and token handling.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { start, config, PASSWORD } from './_setup.js';

let ctx;
before(async () => { ctx = await start(); await ctx.login('customer1', 'vendor1', 'finance'); });
after(async () => ctx.stop());

test('login works for each role and returns the user (vendor includes its vendor)', async () => {
  for (const [email, role] of [['customer1@payrail.demo', 'customer'], ['vendor1@payrail.demo', 'vendor_admin'], ['finance@payrail.demo', 'finance_admin']]) {
    const r = await ctx.api().post('/api/auth/login').send({ email, password: PASSWORD });
    assert.equal(r.status, 200, email);
    assert.equal(r.body.user.role, role);
    assert.equal(r.body.token_type, 'Bearer');
    assert.equal(typeof r.body.user.user_id, 'string');           // BIGINT id as a decimal string
    assert.equal('password_hash' in r.body.user, false);
    if (role === 'vendor_admin') assert.equal(r.body.user.vendor_id, '1');
  }
  const caps = await ctx.api().post('/api/auth/login').send({ email: '  Customer1@PayRail.demo ', password: PASSWORD });
  assert.equal(caps.status, 200, 'e-mail is trimmed and lower-cased');
});

test('wrong password and unknown e-mail give the same 401', async () => {
  const a = await ctx.api().post('/api/auth/login').send({ email: 'customer1@payrail.demo', password: 'wrong' });
  const b = await ctx.api().post('/api/auth/login').send({ email: 'nobody@payrail.demo', password: 'wrong' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(a.body, b.body);
  assert.equal(a.body.error.code, 'invalid_credentials');
});

test('login input is validated; no role can be supplied; there is no sign-up route', async () => {
  const r1 = await ctx.api().post('/api/auth/login').send({ email: 'customer1@payrail.demo' });
  assert.equal(r1.status, 422);
  assert.equal(r1.body.error.code, 'invalid_input');
  const r2 = await ctx.api().post('/api/auth/login').send({ email: 'customer1@payrail.demo', password: PASSWORD, role: 'finance_admin' });
  assert.equal(r2.status, 422, 'unknown fields are rejected (strict schema)');
  const r3 = await ctx.api().post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
  assert.equal(r3.status, 400);
  assert.equal(r3.body.error.code, 'bad_json');
  const r4 = await ctx.api().post('/api/auth/register').send({ email: 'x@y.in', password: 'p', role: 'finance_admin' });
  assert.equal(r4.status, 401, 'no public route: unknown /api paths still require authentication');
});

test('protected routes refuse missing, malformed, forged and expired tokens', async () => {
  for (const url of ['/api/auth/me', '/api/products', '/api/orders', '/api/vendor/me', '/api/finance/refunds']) {
    const r = await ctx.api().get(url);
    assert.equal(r.status, 401, url);
    assert.equal(r.body.error.code, 'unauthenticated');
  }
  const sub = (await ctx.one(`SELECT user_id::text AS id FROM users WHERE email = 'finance@payrail.demo'`)).id;
  const forged = jwt.sign({ role: 'finance_admin' }, 'not-the-secret-not-the-secret-123', { subject: sub, issuer: 'payrail' });
  const none = jwt.sign({ role: 'finance_admin' }, null, { algorithm: 'none', subject: sub, issuer: 'payrail' });
  const expired = jwt.sign({ role: 'finance_admin' }, config.jwtSecret, { subject: sub, issuer: 'payrail', expiresIn: -10 });
  const wrongRole = jwt.sign({ role: 'customer' }, config.jwtSecret, { subject: sub, issuer: 'payrail' });
  for (const [name, t] of [['forged', forged], ['alg none', none], ['expired', expired], ['role mismatch', wrongRole], ['garbage', 'abc']]) {
    const r = await ctx.api().get('/api/finance/refunds').set('Authorization', `Bearer ${t}`);
    assert.equal(r.status, 401, name);
  }
});

test('role guards: each role is refused on the others\' routes', async () => {
  const cases = [
    ['customer1', 'get', '/api/finance/refunds'],
    ['customer1', 'get', '/api/vendor/me'],
    ['customer1', 'post', '/api/finance/reconcile'],
    ['vendor1', 'get', '/api/orders'],
    ['vendor1', 'post', '/api/finance/refunds/1/approve'],
    ['finance', 'get', '/api/vendor/me'],
    ['finance', 'post', '/api/orders'],
    ['vendor1', 'post', '/api/mock-gateway/payments/1/simulate'],
    ['customer1', 'post', '/api/mock-gateway/payments/1/simulate'],
    ['finance', 'post', '/api/mock-gateway/checkout/1'],
    ['vendor1', 'get', '/api/mock-gateway/checkout/1'],
    ['customer1', 'get', '/api/finance/payments'],
  ];
  for (const [user, m, url] of cases) {
    const r = await ctx.as(user)[m](url).send({});
    assert.equal(r.status, 403, `${user} ${m} ${url}`);
    assert.equal(r.body.error.code, 'forbidden');
  }
});

test('/api/auth/me returns the current user; health reports the app role', async () => {
  const me = await ctx.as('vendor1').get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.email, 'vendor1@payrail.demo');
  assert.equal(me.body.kyc_status, 'verified');
  const h = await ctx.api().get('/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.db_user, 'payrail_app', 'the API runs as the least-privilege role');
});
