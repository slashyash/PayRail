// Express application (Task 3). createApp() builds the app without listening,
// so the API tests drive it in-process with supertest.
//
//   /api/health                         public
//   /api/auth/login, /api/auth/me       login (public) / current user
//   /api/products, /api/vendors         catalogue (any authenticated user)
//   /api/orders…, /api/refunds          customer
//   /api/vendor/…                       vendor_admin (own vendor only)
//   /api/finance/…                      finance_admin
//   /api/gateway/callback               simulated gateway → backend (HMAC-signed)
//   /api/mock-gateway/…                 local-demo simulator (customer)
import express from 'express';
import { authService, requireRole, requireVendor } from './auth.js';
import { createPool, makeDb } from './db.js';
import { ApiError, errorMiddleware } from './errors.js';
import { gatewayService } from './gateway.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { customerRoutes } from './routes/customer.js';
import { financeRoutes } from './routes/finance.js';
import { gatewayCallbackRoutes, mockGatewayRoutes } from './routes/gateway.js';
import { vendorRoutes } from './routes/vendor.js';

export function createApp(config, { pool = createPool(config.databaseUrl) } = {}) {
  const db = makeDb(pool);
  const auth = authService({ db, config });
  const gateway = gatewayService({ db, config });
  const deps = { db, config, auth, gateway };

  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');          // ?a=1&a=2 → '1,2'-style strings only; no nested objects
  app.use(express.json({
    limit: '100kb',
    // keep the exact bytes for HMAC verification of gateway callbacks
    verify: (req, res, buf) => { req.rawBody = buf; },
  }));
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.get('/api/health', async (req, res) => {
    const r = await db.one(`SELECT current_user AS db_user, fn_now() AS db_time`);
    res.json({ ok: true, ...r });
  });

  app.post('/api/auth/login', auth.login);
  app.get('/api/auth/me', auth.requireAuth, (req, res) => res.json(req.user));

  app.use('/api/gateway', gatewayCallbackRoutes(deps));
  app.use('/api/mock-gateway', mockGatewayRoutes(deps));

  app.use('/api', auth.requireAuth, catalogueRoutes(deps));      // /api/products, /api/vendors
  app.use('/api/vendor', auth.requireAuth, requireRole('vendor_admin'), requireVendor, vendorRoutes(deps));
  app.use('/api/finance', auth.requireAuth, requireRole('finance_admin'), financeRoutes(deps));
  app.use('/api', auth.requireAuth, requireRole('customer'), customerRoutes(deps));   // /api/orders…, /api/refunds

  app.use((req, res, next) => next(new ApiError(404, 'not_found', `no route ${req.method} ${req.path}`)));
  app.use(errorMiddleware(config.logErrors));
  app.locals.pool = pool;
  return app;
}
