#!/usr/bin/env node
// scripts/demo-race.mjs — live concurrency demonstration against the RUNNING API.
//
//   node scripts/demo-race.mjs [vendorN] [requests]     (defaults: vendor1, 5)
//
// Logs in as the vendor, reads its ledger-derived balance B, then sends
// `requests` payout requests of 40 % of B AT THE SAME TIME (Promise.all, each
// with its own Idempotency-Key, so they are different logical requests). Each
// HTTP request runs fn_request_payout on its own pooled connection; the
// function locks the vendor's payable account (FOR UPDATE) before reading the
// balance, so the requests queue on that row lock: at most two can succeed
// (2 × 40 % ≤ 100 %), the rest fail with insufficient_funds (PRF01), and the
// balance never goes below zero because of payouts.
//
// It changes the demo database (creates payout requests). Undo everything with
// scripts/demo-reset.sh --yes, or mark the payouts failed on Finance → Payouts
// (each is then reversed exactly once).
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const API = `http://127.0.0.1:${process.env.BACKEND_PORT || 4000}/api`;
const vendor = process.argv[2] || 'vendor1';
const n = Number.parseInt(process.argv[3] || '5', 10);

const rupees = (p) => { const b = BigInt(p); const s = b < 0n ? '-' : ''; const a = b < 0n ? -b : b;
  return `${s}₹${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };

async function call(method, url, { token, body, key } = {}) {
  const r = await fetch(API + url, { method, headers: { 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
  body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const login = await call('POST', '/auth/login', { body: { email: `${vendor}@payrail.demo`, password: 'PayRail@2026' } });
if (login.status !== 200) { console.error(`login failed (${login.status}): is the backend running on ${API}?`); process.exit(1); }
const token = login.body.token;
const before = (await call('GET', '/vendor/me', { token })).body;
const B = BigInt(before.balance_paise);
if (B <= 0n) { console.error(`${vendor} balance is ${rupees(B)}: choose a vendor with a positive balance`); process.exit(1); }
const amount = (B * 40n) / 100n;
console.log(`${before.legal_name ?? vendor}: balance ${rupees(B)}; sending ${n} simultaneous payout requests of ${rupees(amount)} each\n`);

const t0 = Date.now();
const results = await Promise.all(Array.from({ length: n }, (_, i) =>
  call('POST', '/vendor/payouts', { token, key: crypto.randomUUID(), body: { amount_paise: amount.toString() } })
    .then((r) => ({ i: i + 1, ...r, ms: Date.now() - t0 }))));

for (const r of results) {
  console.log(`  request ${r.i}: HTTP ${r.status}  ${r.status === 201
    ? `payout #${r.body.payout_id} ${r.body.status}`
    : `${r.body.error?.code} (SQLSTATE ${r.body.error?.sqlstate})`}  after ${r.ms} ms`);
}
const after = (await call('GET', '/vendor/me', { token })).body;
const ok = results.filter((r) => r.status === 201).length;
console.log(`\naccepted ${ok} of ${n}; balance ${rupees(B)} → ${rupees(after.balance_paise)} ` +
  `(= ${rupees(B)} − ${ok} × ${rupees(amount)}: ${BigInt(after.balance_paise) === B - BigInt(ok) * amount ? 'exact' : 'MISMATCH'})`);
console.log('Undo: scripts/demo-reset.sh --yes (or mark these payouts failed on Finance → Payouts).');
