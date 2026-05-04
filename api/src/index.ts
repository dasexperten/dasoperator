import { Hono } from 'hono';
import type { Env } from './types';
import { errorHandler } from './middleware/error';
import { requestLogger } from './middleware/logger';
import { corsMiddleware } from './middleware/cors';
import healthRoutes from './routes/health';
import productsRoutes from './routes/products';
import contactsRoutes from './routes/contacts';
import pricerRoutes from './routes/pricer';
import emailRoutes from './routes/email';
import partnersRoutes from './routes/partners';
import sequencesRoutes from './routes/sequences';
import operationsRoutes from './routes/operations';
import fxRoutes from './routes/fx';
import contractsRoutes from './routes/contracts';
import paymentsRoutes from './routes/payments';
import { netBalancePerPartner, netBalanceBulk } from './routes/net-balance';
import productsPricingRoutes from './routes/products-pricing';
import { ok } from './lib/responses';
import { handleScheduled } from './scheduled';

const app = new Hono<{ Bindings: Env }>();

app.use('*', corsMiddleware);
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

app.get('/', (c) => ok(c, { name: 'dasoperator-api', version: '1.2.1', phase: '3.0e-operations-form' }));
app.route('/health', healthRoutes);
app.route('/api/products', productsRoutes);
app.route('/api/products', productsPricingRoutes);  // adds :productId/price
app.route('/api/contacts', contactsRoutes);
app.route('/api/partners', partnersRoutes);
app.route('/api/partners', netBalancePerPartner);   // adds :slug/net-balance
app.route('/api/net-balance', netBalanceBulk);
app.route('/api/contracts', contractsRoutes);
app.route('/api/pricer', pricerRoutes);
app.route('/api/email', emailRoutes);
app.route('/api/sequences', sequencesRoutes);
app.route('/api/operations', operationsRoutes);
app.route('/api/payments', paymentsRoutes);
app.route('/api/fx', fxRoutes);

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
