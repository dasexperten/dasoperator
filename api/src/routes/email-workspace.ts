import { Hono } from 'hono';
import type { Env } from '../types';
import { validateSession } from '../lib/auth';
import { ok, fail } from '../lib/responses';
import { workspaceStatus, syncWorkspacePage } from '../lib/google-workspace';

const route = new Hono<{ Bindings: Env }>();
route.use('*', async (c, next) => {
  const token = /^Bearer\s+(.+)$/i.exec(c.req.header('Authorization') || '')?.[1];
  const user = token ? await validateSession(c.env.DB, token) : null;
  if (!user || user.role !== 'admin') return fail(c, 403, [{ code: 'FORBIDDEN', message: 'Administrator access required' }]);
  return next();
});
route.get('/status', async c => {
  try { return ok(c, await workspaceStatus(c.env)); }
  catch { return fail(c, 503, [{ code: 'WORKSPACE_CONFIG', message: 'Workspace configuration could not be read. Check the server-side account configuration.' }]); }
});
route.post('/sync', async c => {
  const body = await c.req.json<{ email?: string; pageToken?: string }>().catch(() => null);
  if (!body) return fail(c, 422, [{ code: 'INVALID_INPUT', message: 'A JSON request body is required' }]);
  if (typeof body.email !== 'string' || (body.pageToken !== undefined && (typeof body.pageToken !== 'string' || body.pageToken.length > 2048))) return fail(c, 422, [{ code: 'INVALID_INPUT', message: 'Business mailbox and valid page token required' }]);
  try { return ok(c, await syncWorkspacePage(c.env, body.email.toLowerCase(), body.pageToken)); }
  catch { return fail(c, 502, [{ code: 'SYNC_FAILED', message: 'Import did not complete. No progress cursor was advanced; retry this page after checking the connection and archive.' }]); }
});
export default route;
