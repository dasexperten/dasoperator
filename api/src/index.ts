import { Hono } from 'hono';
import type { Env } from './types';
import { errorHandler } from './middleware/error';
import { requestLogger } from './middleware/logger';
import { corsMiddleware } from './middleware/cors';
import healthRoutes from './routes/health';
import productsRoutes from './routes/products';
import contactsRoutes from './routes/contacts';
import directoriesRoutes from './routes/directories';
import pricerRoutes from './routes/pricer';
import emailRoutes from './routes/email';
import partnersRoutes from './routes/partners';
import sequencesRoutes from './routes/sequences';
import operationsRoutes from './routes/operations';
import operationsImportRoutes from './routes/operations-import';
import fxRoutes from './routes/fx';
import contractsRoutes from './routes/contracts';
import paymentsRoutes from './routes/payments';
import { netBalancePerPartner, netBalanceBulk } from './routes/net-balance';
import productsPricingRoutes from './routes/products-pricing';
import documentsRoutes from './routes/documents';
import stocksRoutes, { productStock } from './routes/stocks';
import stockMovementsRoutes from './routes/stock-movements';
import inventorySessionsRoutes from './routes/inventory-sessions';
import warehousesRoutes from './routes/warehouses';
import productsPhotosRoutes from './routes/products-photos';
import adminMigrationsRoutes from './routes/admin-migrations';
import marketplacesRoutes from './routes/marketplaces';
import marketplacesExtrasRoutes from './routes/marketplaces-extras';
import bundlingRoutes from './routes/bundling';
import attachmentsRoutes from './routes/attachments';
import attachmentFilesRoutes from './routes/attachment-files';
import banksModulbankRoutes from './routes/banks-modulbank';
import bankStatementSourcesRoutes from './routes/bank-statement-sources';
import bankStatementsRoutes from './routes/bank-statements';
import crmRoutes from './routes/crm';
import metrikaRoutes from './routes/metrika';
import inboxRoutes from './routes/inbox';
import inboxBankingRoutes from './routes/inbox-banking';
import freightRfqRoutes from './routes/freight-rfq';
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

app.get('/', (c) => ok(c, { name: 'dasoperator-api', version: '1.8.0', phase: '7.0-bank-integration' }));
app.route('/health', healthRoutes);
app.route('/api/products', productsRoutes);
app.route('/api/products', productsPricingRoutes);  // adds :productId/price
app.route('/api/products', productStock);           // adds :id/stock
app.route('/api/products', productsPhotosRoutes);   // adds :id/images endpoints
app.route('/api/contacts', contactsRoutes);
app.route('/api', directoriesRoutes);  // companies + manufacturers list
app.route('/api/partners', partnersRoutes);
app.route('/api/partners', netBalancePerPartner);   // adds :slug/net-balance
app.route('/api/net-balance', netBalanceBulk);
app.route('/api/contracts', contractsRoutes);
app.route('/api/pricer', pricerRoutes);
app.route('/api/email', emailRoutes);
app.route('/api/sequences', sequencesRoutes);
app.route('/', attachmentsRoutes);
app.route('/api', attachmentFilesRoutes);  // /operations/:opId/files (POST) and /attachment-files/* (GET)
app.route('/api/operations', operationsRoutes);
app.route('/api/operations', operationsImportRoutes);  // adds /parse-excel

// Manual trigger for the auto-delivery sweep (same code path as cron).
// Useful for ops: hit this when you've just imported stock and want to
// fast-forward any pending shipments without waiting for the next cron tick.
app.post('/api/cron/auto-delivery', async (c) => {
  const { runAutoDeliverySweep } = await import('./auto-delivery');
  const result = await runAutoDeliverySweep(c.env);
  return ok(c, result);
});
app.route('/api/payments', paymentsRoutes);
app.route('/api/fx', fxRoutes);
app.route('/api/documents', documentsRoutes);
app.route('/api/stocks', stocksRoutes);
app.route('/api/stock-movements', stockMovementsRoutes);
app.route('/api/inventory-sessions', inventorySessionsRoutes);
app.route('/api/warehouses', warehousesRoutes);
app.route('/admin', adminMigrationsRoutes);
app.route('/api/marketplaces', marketplacesRoutes);
app.route('/api/marketplaces', marketplacesExtrasRoutes);
app.route('/api/bundling', bundlingRoutes);
app.route('/api/banks/modulbank', banksModulbankRoutes);
app.route('/api/bank-statement-sources', bankStatementSourcesRoutes);
app.route('/api/bank-statements', bankStatementsRoutes);
app.route('/api/crm', crmRoutes);
app.route('/api/metrika', metrikaRoutes);
app.route('/api/inbox/banking', inboxBankingRoutes);
app.route('/api/inbox', inboxRoutes);
app.route('/api/freight-rfq', freightRfqRoutes);

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;

