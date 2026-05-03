import { Hono } from 'hono';
import type { Env } from './types';
import { errorHandler } from './middleware/error';
import { requestLogger } from './middleware/logger';
import healthRoutes from './routes/health';
import { ok } from './lib/responses';

// =============================================================================
// Das Operator ERP — Workers API entrypoint
// Phase 2.0a — foundation only. Skill endpoints land in Phase 2.0b.
// =============================================================================

const app = new Hono<{ Bindings: Env }>();

// Middleware chain — order matters
app.use('*', requestLogger);

// Error handler — catches all unhandled throws and maps to ApiResponse
app.onError(errorHandler);

// 404 handler — unified shape for unknown routes
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
app.get('/', (c) => ok(c, { name: 'dasoperator-api', version: '0.2.0', phase: '2.0a' }));
app.route('/health', healthRoutes);

export default app;
