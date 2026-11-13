// Entry point: `npm start` (or `npm run dev` to restart on file changes).
import { createApp } from './app.js';
import { configFromEnv, loadDotEnv } from './config.js';
import { checkDatabase, printChecks } from './doctor.js';

loadDotEnv();
const config = configFromEnv();
const app = createApp(config);
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`PayRail API listening on http://127.0.0.1:${config.port}  (mock gateway ${config.mockGatewayEnabled ? 'enabled' : 'disabled'})`);
  // one read-only startup check, so a wrong password or an old schema is named now, not as a 500 at login
  checkDatabase(config.databaseUrl).then((results) => {
    const bad = results.filter((r) => r.status !== 'ok');
    if (!bad.length) { console.log('database check: ok (npm run doctor for details)'); return; }
    console.warn('database check found problems (the server keeps running; fix and retry, or `npm run doctor`):');
    printChecks(bad, console.warn);
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => app.locals.pool.end().then(() => process.exit(0)));
  });
}
