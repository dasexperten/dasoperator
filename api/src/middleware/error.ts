import type { Context, ErrorHandler } from 'hono';
import { fail, fromError } from '../lib/responses';

// Hono onError handler — catches all unhandled throws.
// Maps to unified ApiResponse shape with success: false.
export const errorHandler: ErrorHandler = (err, c: Context) => {
  console.error('[API ERROR]', {
    path: c.req.path,
    method: c.req.method,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  return fail(c, 500, [fromError(err)]);
};
