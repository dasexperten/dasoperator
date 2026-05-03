import { Hono } from 'hono';
import type { Env } from './types';
import { errorHandler } from './middleware/error';
import { requestLogger } from './middleware/logger';
import healthRoutes from './routes/health';
import productsRoutes from './routes/products';
import contactsRoutes from './routes/contacts';
import pricerRoutes from './routes/pricer';
import { ok } from './lib/responses';

// =============================================================================
// Das Operator ERP — Workers API entrypoint
// Phase 2.0a — foundation (types, helpers, middleware, /health)
// Phase 2.0b — read-only skill endpoints (products, contacts, pricer)
// =============================================================================

const app = new Hono<{ Bindings: Env }>();

// Middleware chain
app.use('*', requestLogger);
app.onError(errorHandler);

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      success: false,
      result: null,
      errors: [{ code: 'not_found', message: `No route for ${c.req.method} ${c.req.path}` }],
      messages: [],
    },
    404
  );
});

// Routes
app.get('/', (c) => ok(c, { name: 'dasoperator-api', version: '0.3.0', phase: '2.0b' }));
app.route('/health', healthRoutes);
app.route('/api/products', productsRoutes);
app.route('/api/contacts', contactsRoutes);
app.route('/api/pricer', pricerRoutes);

export default app;
