import { Hono } from 'hono';
import type { Env } from '../types';
import { receiveNotification } from '../lib/vietinbank-notify.mjs';

const app = new Hono<{ Bindings: Env }>();
// Public bank callback. The handler verifies bank signatures itself, not ERP sessions.
// No inbox read endpoint: financial PII is available only through admin D1 access.
app.post('/notify-bill', c => receiveNotification(c.req.raw, c.env));
export default app;
