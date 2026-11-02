// Entry point: `npm start` (or `npm run dev` to restart on file changes).
import { createApp } from './app.js';
import { configFromEnv, loadDotEnv } from './config.js';

loadDotEnv();
const config = configFromEnv();
const app = createApp(config);
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`PayRail API listening on http://127.0.0.1:${config.port}  (mock gateway ${config.mockGatewayEnabled ? 'enabled' : 'disabled'})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => app.locals.pool.end().then(() => process.exit(0)));
  });
}
