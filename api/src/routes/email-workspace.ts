import { Hono } from 'hono';
import type { Env } from '../types';
import { validateSession } from '../lib/auth';
import { ok, fail } from '../lib/responses';
import { workspaceStatus } from '../lib/google-workspace';

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
route.post('/sync', c => fail(c, 409, [{ code: 'GMAIL_PRIMARY', message: 'Google is the mail store. Gmail-to-R2 copying is disabled; use the direct Gmail client.' }]));
export default route;
