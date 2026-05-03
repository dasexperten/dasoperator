import { Hono } from 'hono';
import type { Env } from './types';
import { errorHandler } from './middleware/error';
import { requestLogger } from './middleware/logger';
import healthRoutes from './routes/health';
import productsRoutes from './routes/products';
import contactsRoutes from './routes/contacts';
import pricerRoutes from './routes/pricer';
import emailRoutes from './routes/email';
import { ok } from './lib/responses';

// =============================================================================
// Das Operator ERP — Workers API entrypoint
// Phase 2.0a — foundation
// Phase 2.0b — read-only skill endpoints (products, contacts, pricer)
// Phase 2.1  — email proxy to emailer-bridge worker
// =============================================================================

const app = new Hono<{ Bindings: Env }>();

app.use('*', requestLogger);
app.onError(errorHandler);

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

app.get('/', (c) => ok(c, { name: 'dasoperator-api', version: '0.4.0', phase: '2.1' }));
app.route('/health', healthRoutes);
app.route('/api/products', productsRoutes);
app.route('/api/contacts', contactsRoutes);
app.route('/api/pricer', pricerRoutes);
app.route('/api/email', emailRoutes);

export default app;
