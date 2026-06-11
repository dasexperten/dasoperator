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
// !! KEEP — registered route for /api/price-types — DO NOT REMOVE on parallel edits
import priceTypesRoutes from './routes/price-types';
import emailRoutes from './routes/email';
import partnersRoutes from './routes/partners';
import partnersParseCreate from './routes/partners-parse-create';
import sequencesRoutes from './routes/sequences';
import operationsRoutes from './routes/operations';
import operationsImportRoutes from './routes/operations-import';
import operationDocsRoutes from './routes/operation-docs';
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
import productsLandedCostRoutes from './routes/products-landed-cost';
import adminMigrationsRoutes from './routes/admin-migrations';
import adminAutoHealRoutes from './routes/admin-auto-heal';
import marketplacesRoutes from './routes/marketplaces';
import marketplacesExtrasRoutes from './routes/marketplaces-extras';
import marketplacesPromosRoutes from './routes/marketplaces-promos';
import externalStocksRoutes from './routes/external-stocks';
import externalRequestsRoutes from './routes/external-requests';
import bundlingRoutes from './routes/bundling';
import attachmentsRoutes from './routes/attachments';
import attachmentFilesRoutes from './routes/attachment-files';
import banksModulbankRoutes from './routes/banks-modulbank';
import bankStatementSourcesRoutes from './routes/bank-statement-sources';
import operationDocumentSourcesRoutes from './routes/operation-document-sources';
import operationDocumentsRoutes from './routes/operation-documents';
import bankStatementsRoutes from './routes/bank-statements';
import agentSettlementsRoutes from './routes/agent-settlements';
import bankMatchRulesRoutes from './routes/bank-match-rules';
import financeCategoriesRoutes from './routes/finance-categories';
import documentExtractionsRoutes from './routes/document-extractions';
import crmRoutes from './routes/crm';
import metrikaRoutes from './routes/metrika';
import inboxRoutes from './routes/inbox';
import inboxBankingRoutes from './routes/inbox-banking';
import marketplaceMatchRoutes from './routes/marketplace-match';
import freightRfqRoutes from './routes/freight-rfq';
import marketplacePullRoutes from './routes/marketplace-pull';
import salesBreakdownRoutes from './routes/sales-breakdown';
import reviewsRoutes from './routes/reviews';
import wbHealthRoutes from './routes/wb-health';
import skillsRoutes from './routes/skills';
import integrationsRoutes from './routes/integrations';
import loyaltyRoutes from './routes/loyalty';
import plannerRoutes from './routes/planner';
import authRoutes from './routes/auth';
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

// =============================================================================
// LLM diagnostic — verifies which provider actually serves traffic.
// GET /api/_llm-diag?model=pro|flash&prefer=auto|anthropic|deepseek
//   model:  pro=Sonnet 4.6 (default) | flash=Haiku 4.5
//   prefer: auto=Anthropic→DeepSeek fallback (default)
//           anthropic=pin Anthropic, no fallback
//           deepseek=skip Anthropic, force DeepSeek
// Returns { provider, model, ok, latency_ms, sample_text }.
// Non-destructive: tiny ping prompt, no D1/R2 writes.
// =============================================================================
app.get('/api/_llm-diag', async (c) => {
  const { callPro, callFlash } = await import('./lib/llm');
  const model = c.req.query('model') === 'flash' ? 'flash' : 'pro';
  const preferRaw = c.req.query('prefer');
  const prefer = (preferRaw === 'anthropic' || preferRaw === 'deepseek') ? preferRaw : 'auto';
  const t0 = Date.now();
  try {
    const fn = model === 'flash' ? callFlash : callPro;
    const r = await fn(
      [{ role: 'user', content: 'Reply with exactly: pong' }],
      { env: c.env, maxTokens: 500, temperature: 0, prefer },
    );
    return ok(c, {
      ok: true,
      requested: { model, prefer },
      provider: r.provider,
      model: r.model,
      latency_ms: Date.now() - t0,
      sample_text: r.text.slice(0, 60),
      tokens: r.usage,
      providers_configured: {
        anthropic_oauth: !!c.env.CLAUDE_CODE_OAUTH_TOKEN,
        deepseek: !!c.env.DEEPSEEK_API_KEY,
      },
    });
  } catch (e: any) {
    return c.json({
      ok: false,
      requested: { model, prefer },
      error: String(e?.message ?? e),
      latency_ms: Date.now() - t0,
      providers_configured: {
        anthropic_oauth: !!c.env.CLAUDE_CODE_OAUTH_TOKEN,
        deepseek: !!c.env.DEEPSEEK_API_KEY,
      },
    }, 500);
  }
});

app.route('/health', healthRoutes);
app.route('/api/products', productsRoutes);
app.route('/api/products', productsPricingRoutes);  // adds :productId/price
app.route('/api/products', productStock);           // adds :id/stock
app.route('/api/products', productsPhotosRoutes);   // adds :id/images endpoints
app.route('/api/products', productsLandedCostRoutes); // adds :id/landed-cost
app.route('/api/contacts', contactsRoutes);
app.route('/api', directoriesRoutes);  // companies + manufacturers list
app.route('/api/partners', partnersRoutes);
app.route('/api/partners', netBalancePerPartner);   // adds :slug/net-balance
app.route('/api/partners', partnersParseCreate);     // POST :slug/parse-and-create
app.route('/api/net-balance', netBalanceBulk);
app.route('/api/contracts', contractsRoutes);
app.route('/api/pricer', pricerRoutes);
// !! KEEP — /api/price-types CRUD (GET, POST, PATCH) — see api/src/routes/price-types.ts
app.route('/api/price-types', priceTypesRoutes);
app.route('/api/email', emailRoutes);
app.route('/api/sequences', sequencesRoutes);
app.route('/', attachmentsRoutes);
app.route('/api', attachmentFilesRoutes);  // /operations/:opId/files (POST) and /attachment-files/* (GET)
app.route('/api/operations', operationDocsRoutes);  // /upload-document — must come BEFORE :id routes
app.route('/api/operations', operationsRoutes);
app.route('/api/operations', operationsImportRoutes);  // adds /parse-excel
app.route('/api/marketplace-pull', marketplacePullRoutes);
app.route('/api/dashboard', salesBreakdownRoutes);
app.route('/api/reviews', reviewsRoutes);
app.route('/api/wb/health', wbHealthRoutes);
app.route('/api/skills', skillsRoutes);
app.route('/api/planner', plannerRoutes);
app.route('/api/auth', authRoutes);

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
app.route('/api/admin/auto-heal', adminAutoHealRoutes);
app.route('/api/marketplaces', marketplacesRoutes);
app.route('/api/marketplaces', marketplacesExtrasRoutes);
app.route('/api/marketplaces', marketplacesPromosRoutes);
app.route('/api/external-stocks', externalStocksRoutes);
app.route('/api/external-requests', externalRequestsRoutes);
app.route('/api/bundling', bundlingRoutes);
app.route('/api/banks/modulbank', banksModulbankRoutes);
app.route('/api/bank-statement-sources', bankStatementSourcesRoutes);
app.route('/api/operation-document-sources', operationDocumentSourcesRoutes);
app.route('/api/operation-documents', operationDocumentsRoutes);
app.route('/api/bank-statements', bankStatementsRoutes);
app.route('/api/agent-settlements', agentSettlementsRoutes);
app.route('/api/marketplace', marketplaceMatchRoutes);
app.route('/api/bank-match-rules', bankMatchRulesRoutes);
app.route('/api/finance-categories', financeCategoriesRoutes);
app.route('/api/document-extractions', documentExtractionsRoutes);
app.route('/api/crm', crmRoutes);
app.route('/api/metrika', metrikaRoutes);
app.route('/api/inbox/banking', inboxBankingRoutes);
app.route('/api/inbox', inboxRoutes);
app.route('/api/freight-rfq', freightRfqRoutes);
app.route('/api/integrations', integrationsRoutes);
app.route('/api/loyalty', loyaltyRoutes);

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;

