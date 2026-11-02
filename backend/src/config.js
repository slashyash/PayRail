// Configuration from environment variables (Task 3).
//
// The repository-root .env (copied from .env.example) is loaded if present;
// real environment variables win. Nothing secret has a default: the server
// refuses to start without JWT_SECRET, GATEWAY_WEBHOOK_SECRET and DATABASE_URL.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../..');

export function loadDotEnv(file = path.join(REPO_ROOT, '.env')) {
  // process.loadEnvFile (Node ≥ 21.7) never overrides variables already set.
  if (existsSync(file)) process.loadEnvFile(file);
}

function required(env, name, { minLength = 1 } = {}) {
  const v = env[name];
  if (!v || v.length < minLength || v.startsWith('CHANGE')) {
    throw new Error(`configuration: ${name} must be set (at least ${minLength} characters, not the CHANGE placeholder)`);
  }
  return v;
}

export function configFromEnv(env = process.env) {
  const asOf = env.PAYRAIL_DEMO_AS_OF || null;
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error('configuration: PAYRAIL_DEMO_AS_OF must be YYYY-MM-DD');
  }
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    jwtSecret: required(env, 'JWT_SECRET', { minLength: 32 }),
    jwtExpiresIn: env.JWT_EXPIRES_IN || '8h',
    gatewaySecret: required(env, 'GATEWAY_WEBHOOK_SECRET', { minLength: 32 }),
    // the in-process mock gateway (simulate endpoint) is a local-demo feature
    mockGatewayEnabled: (env.MOCK_GATEWAY_ENABLED ?? '1') === '1',
    port: Number.parseInt(env.BACKEND_PORT || '4000', 10),
    demoAsOf: asOf,                     // default as-of date for reconciliation (DEC-009)
    logErrors: env.NODE_ENV !== 'test',
  };
}
