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
import banksModulbankRoutes from './routes/banks-modulbank';
import crmRoutes from './routes/crm';
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
app.route('/api/operations', operationsRoutes);
app.route('/api/operations', operationsImportRoutes);  // adds /parse-excel
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
app.route('/api/crm', crmRoutes);

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;

