// Browser smoke test for the customer workflow (Task 4).
//
//   cd frontend && npx playwright install chromium   # once per machine
//   npm run test:e2e                                 # PAYRAIL_REBUILD_VIA_DOCKER=1 on Docker-only machines
//
// It is self-contained and never touches your demo database:
//   1. rebuilds + seeds a DEDICATED database `payrail_e2e` (db/reset_dev.sh via
//      backend/test/_env.js — destructive only for that name),
//   2. starts its own backend on :4100 connected to it as payrail_app,
//   3. starts its own Vite server on :5174 proxying /api to :4100,
//   4. drives Chromium through e2e/*.spec.js.
// PAYRAIL_E2E_SKIP_REBUILD=1 reuses the existing payrail_e2e as it is.
import { defineConfig, devices } from '@playwright/test';
import { APP_PASSWORD, resetDatabase } from '../backend/test/_env.js';   // also loads the root .env

const DB = 'payrail_e2e';
const API_PORT = 4100;
const UI_PORT = 5174;

// The config file is evaluated by the runner and again by each worker; the env
// flag (inherited by workers) makes the rebuild happen exactly once, before the
// web servers start.
if (!process.env.PAYRAIL_E2E_READY) {
  if (process.env.PAYRAIL_E2E_SKIP_REBUILD !== '1') resetDatabase(DB, { seed: true });
  process.env.PAYRAIL_E2E_READY = '1';
}

const databaseUrl = `postgres://payrail_app:${encodeURIComponent(APP_PASSWORD)}@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${DB}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node ../backend/src/server.js',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: { DATABASE_URL: databaseUrl, BACKEND_PORT: String(API_PORT), MOCK_GATEWAY_ENABLED: '1' },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npx vite --port ${UI_PORT}`,
      url: `http://127.0.0.1:${UI_PORT}`,
      env: { PAYRAIL_API_URL: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
