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
import { ok } from './lib/responses';

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

app.get('/', (c) => ok(c, { name: 'dasoperator-api', version: '0.6.0', phase: '3.0c' }));
app.route('/health', healthRoutes);
app.route('/api/products', productsRoutes);
app.route('/api/contacts', contactsRoutes);
app.route('/api/partners', partnersRoutes);
app.route('/api/pricer', pricerRoutes);
app.route('/api/email', emailRoutes);

export default app;
