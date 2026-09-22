// @ts-expect-error Cloudflare runtime API documented for current compatibility date
import { createHash } from 'node:crypto';
import { runLogged, type BaseEnv } from '../../_shared/run';
import {
  callJson,
  codeOf,
  downloadInvoice,
  invoiceFacts,
  isConfigurationBlock,
  isMissingIkey,
  isProviderSuccess,
  needsVerification,
  providerMessage,
  statusBody,
  strictBaseUrl,
  submitBody,
  type EasyInvoiceConfig,
  type InvoiceAction,
  type ProviderEnvelope,
} from './easyinvoice';

interface Env extends BaseEnv {
  DOCS: R2Bucket;
  EASYINVOICE_ENABLED?: string;
  EASYINVOICE_BASE_URL?: string;
  EASYINVOICE_USERNAME?: string;
  EASYINVOICE_PASSWORD?: string;
  EASYINVOICE_TAX_CODE?: string;
  EASYINVOICE_PATTERN?: string;
  EASYINVOICE_SERIAL?: string;
  SWIFTHUB_INGEST_SECRET?: string;
}

interface IngestEvent {
  source_event_id?: unknown;
  order_id?: unknown;
  action?: unknown;
  ikey?: unknown;
  original_ikey?: unknown;
  xml_data?: unknown;
  pattern?: unknown;
  serial?: unknown;
  completed_at?: unknown;
  metadata?: unknown;
}

interface DocumentRow {
  id: string;
  source: string;
  source_event_id: string;
  source_order_id: string;
  action: InvoiceAction;
  ikey: string;
  original_ikey: string | null;
  pattern: string | null;
  serial: string | null;
  state: string;
  request_r2_key: string;
  retry_count: number;
  verify_count: number;
}

const WORKER = 'erp-vn-einvoice';
const RETRY_SECONDS = 5 * 60;
const MAX_VERIFY_MISSES = 3;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function safeString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'event';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function defaultIkey(orderId: string, action: InvoiceAction, eventId: string): string {
  const order = safeKey(orderId);
  if (action === 'issue' && order.length <= 70) return `swh-${order}`;
  return `swh-${order.slice(0, 45)}-${action}-${digest(eventId).slice(0, 16)}`;
}

function sameSecret(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(request: Request, secret: string | undefined): boolean {
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return Boolean(secret && sameSecret(given, secret));
}

function readiness(env: Env): { ready: boolean; blockers: string[]; config: EasyInvoiceConfig | null } {
  const blockers: string[] = [];
  if (env.EASYINVOICE_ENABLED !== '1') blockers.push('provider_disabled');
  let baseUrl = '';
  try {
    baseUrl = strictBaseUrl(env.EASYINVOICE_BASE_URL || '');
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : 'easyinvoice_base_url_invalid');
  }
  if (!env.EASYINVOICE_USERNAME) blockers.push('username_missing');
  if (!env.EASYINVOICE_PASSWORD) blockers.push('password_missing');
  if (!env.EASYINVOICE_TAX_CODE) blockers.push('tax_code_missing');
  if (!env.EASYINVOICE_PATTERN) blockers.push('pattern_missing');
  if (!env.EASYINVOICE_SERIAL) blockers.push('serial_missing');
  const ready = blockers.length === 0;
  return {
    ready,
    blockers,
    config: ready ? {
      baseUrl,
      username: env.EASYINVOICE_USERNAME!,
      password: env.EASYINVOICE_PASSWORD!,
      taxCode: env.EASYINVOICE_TAX_CODE!,
      pattern: env.EASYINVOICE_PATTERN!,
      serial: env.EASYINVOICE_SERIAL!,
    } : null,
  };
}

async function archiveJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.DOCS.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { system: 'vn-einvoice', private: 'true' },
  });
}

async function updateDocument(env: Env, id: string, values: Record<string, unknown>): Promise<void> {
  const allowed = new Set([
    'state', 'provider_status', 'provider_error_code', 'provider_message', 'invoice_no', 'lookup_code',
    'response_r2_key', 'provider_xml_r2_key', 'provider_pdf_r2_key', 'retry_count', 'verify_count',
    'next_attempt_at', 'updated_at', 'issued_at', 'completed_at',
  ]);
  const entries = Object.entries(values).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  const sql = `UPDATE vn_einvoice_documents SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`;
  await env.DB.prepare(sql).bind(...entries.map(([, value]) => value), id).run();
}

async function recordAttempt(
  env: Env,
  documentId: string,
  phase: 'preflight' | 'submit' | 'verify' | 'archive_xml' | 'archive_pdf',
  startedAt: number,
  outcome: string,
  result?: { httpStatus?: number | null; body?: ProviderEnvelope | null; detail?: string | null; responseKey?: string | null },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO vn_einvoice_attempts
      (document_id, phase, started_at, finished_at, http_status, provider_status,
       provider_error_code, outcome, detail, response_r2_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    documentId,
    phase,
    startedAt,
    Math.floor(Date.now() / 1000),
    result?.httpStatus ?? null,
    result?.body?.Status === undefined ? null : Number(result.body.Status),
    result?.body ? codeOf(result.body) || null : null,
    outcome,
    result?.detail?.slice(0, 1000) ?? null,
    result?.responseKey ?? null,
  ).run();
}

async function loadPayload(env: Env, row: DocumentRow): Promise<IngestEvent> {
  const object = await env.DOCS.get(row.request_r2_key);
  if (!object) throw new Error('request_archive_missing');
  return JSON.parse(await object.text()) as IngestEvent;
}

async function archiveProviderResponse(
  env: Env,
  row: DocumentRow,
  phase: string,
  response: unknown,
): Promise<string> {
  const key = `vn-einvoice/${safeKey(row.source_order_id)}/${row.id}/${Date.now()}-${safeKey(phase)}.json`;
  await archiveJson(env, key, response);
  return key;
}

async function saveProviderFacts(
  env: Env,
  row: DocumentRow,
  body: ProviderEnvelope,
  state: string,
  responseKey: string,
): Promise<void> {
  const facts = invoiceFacts(body, row.ikey);
  const now = Math.floor(Date.now() / 1000);
  await updateDocument(env, row.id, {
    state,
    provider_status: body.Status === undefined ? null : Number(body.Status),
    provider_error_code: codeOf(body) || null,
    provider_message: providerMessage(body) || null,
    invoice_no: facts.invoiceNo,
    lookup_code: facts.lookupCode,
    response_r2_key: responseKey,
    updated_at: now,
    next_attempt_at: state === 'issued_archive_pending' ? now : null,
    issued_at: row.action === 'cancel' ? null : now,
    completed_at: state === 'cancelled' ? now : null,
  });
}

async function archiveIssuedFiles(env: Env, row: DocumentRow, config: EasyInvoiceConfig): Promise<boolean> {
  let xmlKey: string | null = null;
  let pdfKey: string | null = null;
  const base = `vn-einvoice/${safeKey(row.source_order_id)}/${row.id}`;
  for (const item of [
    { phase: 'archive_xml' as const, option: -1 as const, name: 'invoice.xml', contentType: 'application/xml' },
    { phase: 'archive_pdf' as const, option: 2 as const, name: 'invoice-archive.pdf', contentType: 'application/pdf' },
  ]) {
    const started = Math.floor(Date.now() / 1000);
    try {
      const file = await downloadInvoice(config, row.ikey, row.pattern || config.pattern, item.option);
      const key = `${base}/${item.name}`;
      await env.DOCS.put(key, file.bytes, {
        httpMetadata: { contentType: file.contentType || item.contentType },
        customMetadata: { system: 'vn-einvoice', private: 'true', ikey_sha256: digest(row.ikey) },
      });
      if (item.option === -1) xmlKey = key;
      else pdfKey = key;
      await recordAttempt(env, row.id, item.phase, started, 'ok', { httpStatus: file.httpStatus });
    } catch (error) {
      await recordAttempt(env, row.id, item.phase, started, 'retry', {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const complete = Boolean(xmlKey && pdfKey);
  const now = Math.floor(Date.now() / 1000);
  await updateDocument(env, row.id, {
    state: complete ? 'issued' : 'issued_archive_pending',
    provider_xml_r2_key: xmlKey,
    provider_pdf_r2_key: pdfKey,
    next_attempt_at: complete ? null : now + RETRY_SECONDS,
    updated_at: now,
    completed_at: complete ? now : null,
  });
  return complete;
}

async function markProviderFailure(
  env: Env,
  row: DocumentRow,
  body: ProviderEnvelope,
  responseKey: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const state = isConfigurationBlock(body)
    ? 'blocked_config'
    : needsVerification(body)
      ? 'verify_pending'
      : 'failed_terminal';
  await updateDocument(env, row.id, {
    state,
    provider_status: body.Status === undefined ? null : Number(body.Status),
    provider_error_code: codeOf(body) || null,
    provider_message: providerMessage(body) || null,
    response_r2_key: responseKey,
    retry_count: row.retry_count + 1,
    next_attempt_at: state === 'verify_pending' ? now + RETRY_SECONDS : null,
    updated_at: now,
  });
}

async function verifyDocument(env: Env, row: DocumentRow, config: EasyInvoiceConfig): Promise<string> {
  const started = Math.floor(Date.now() / 1000);
  const target = row.action === 'cancel' ? row.original_ikey || row.ikey : row.ikey;
  try {
    const result = await callJson(config, 'status', statusBody(target));
    const responseKey = await archiveProviderResponse(env, row, 'verify', result);
    if (isProviderSuccess(result.body)) {
      const nextState = row.action === 'cancel' ? 'cancelled' : 'issued_archive_pending';
      await saveProviderFacts(env, row, result.body, nextState, responseKey);
      await recordAttempt(env, row.id, 'verify', started, 'found', {
        httpStatus: result.httpStatus, body: result.body, responseKey,
      });
      if (row.action !== 'cancel') await archiveIssuedFiles(env, row, config);
      return 'verified';
    }
    if (isMissingIkey(result.body)) {
      const misses = row.verify_count + 1;
      const manual = row.state === 'verify_pending' && misses >= MAX_VERIFY_MISSES;
      await updateDocument(env, row.id, {
        state: manual ? 'manual_review' : row.state,
        verify_count: misses,
        provider_status: result.body.Status === undefined ? null : Number(result.body.Status),
        provider_error_code: codeOf(result.body),
        provider_message: providerMessage(result.body),
        response_r2_key: responseKey,
        next_attempt_at: manual ? null : Math.floor(Date.now() / 1000) + RETRY_SECONDS,
        updated_at: Math.floor(Date.now() / 1000),
      });
      await recordAttempt(env, row.id, 'verify', started, manual ? 'manual_review' : 'not_found', {
        httpStatus: result.httpStatus, body: result.body, responseKey,
      });
      return manual ? 'manual_review' : 'not_found';
    }
    await markProviderFailure(env, row, result.body, responseKey);
    await recordAttempt(env, row.id, 'verify', started, 'provider_error', {
      httpStatus: result.httpStatus, body: result.body, responseKey,
    });
    return 'provider_error';
  } catch (error) {
    const now = Math.floor(Date.now() / 1000);
    await updateDocument(env, row.id, {
      state: 'verify_pending',
      verify_count: row.verify_count + 1,
      next_attempt_at: now + RETRY_SECONDS,
      updated_at: now,
      provider_message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    await recordAttempt(env, row.id, 'verify', started, 'transport_error', {
      detail: error instanceof Error ? error.message : String(error),
    });
    return 'transport_error';
  }
}

async function submitDocument(env: Env, row: DocumentRow, config: EasyInvoiceConfig): Promise<string> {
  const payload = await loadPayload(env, row);
  const body = submitBody({
    action: row.action,
    ikey: row.ikey,
    originalIkey: row.original_ikey,
    xmlData: safeString(payload.xml_data, 2_000_000) || null,
    pattern: row.pattern || config.pattern,
    serial: row.serial || config.serial,
  });
  const started = Math.floor(Date.now() / 1000);
  await updateDocument(env, row.id, { state: 'submitting', updated_at: started });
  try {
    const result = await callJson(config, row.action, body);
    const responseKey = await archiveProviderResponse(env, row, 'submit', result);
    if (isProviderSuccess(result.body)) {
      const nextState = row.action === 'cancel' ? 'cancelled' : 'issued_archive_pending';
      await saveProviderFacts(env, row, result.body, nextState, responseKey);
      await recordAttempt(env, row.id, 'submit', started, 'accepted', {
        httpStatus: result.httpStatus, body: result.body, responseKey,
      });
      if (row.action !== 'cancel') await archiveIssuedFiles(env, row, config);
      return 'accepted';
    }
    await markProviderFailure(env, row, result.body, responseKey);
    await recordAttempt(env, row.id, 'submit', started, 'provider_error', {
      httpStatus: result.httpStatus, body: result.body, responseKey,
    });
    return 'provider_error';
  } catch (error) {
    const now = Math.floor(Date.now() / 1000);
    await updateDocument(env, row.id, {
      state: 'verify_pending',
      retry_count: row.retry_count + 1,
      next_attempt_at: now + RETRY_SECONDS,
      updated_at: now,
      provider_message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    await recordAttempt(env, row.id, 'submit', started, 'uncertain_transport', {
      detail: error instanceof Error ? error.message : String(error),
    });
    return 'uncertain_transport';
  }
}

async function processDocument(env: Env, row: DocumentRow, config: EasyInvoiceConfig): Promise<string> {
  if (row.state === 'issued_archive_pending') {
    return await archiveIssuedFiles(env, row, config) ? 'archive_complete' : 'archive_pending';
  }
  if (row.state === 'verify_pending') return verifyDocument(env, row, config);
  await updateDocument(env, row.id, { state: 'checking', updated_at: Math.floor(Date.now() / 1000) });
  const preflight = await verifyDocument(env, { ...row, state: 'checking' }, config);
  if (preflight === 'not_found') {
    if (row.action === 'cancel') {
      await updateDocument(env, row.id, {
        state: 'failed_terminal',
        provider_message: 'original_invoice_not_found',
        next_attempt_at: null,
        updated_at: Math.floor(Date.now() / 1000),
      });
      return 'original_not_found';
    }
    return submitDocument(env, row, config);
  }
  return preflight;
}

async function loadDocument(env: Env, id: string): Promise<DocumentRow | null> {
  return env.DB.prepare(
    `SELECT id, source, source_event_id, source_order_id, action, ikey, original_ikey,
            pattern, serial, state, request_r2_key, retry_count, verify_count
       FROM vn_einvoice_documents WHERE id = ?`,
  ).bind(id).first<DocumentRow>();
}

async function queueRun(env: Env, dry: boolean): Promise<{ rows: number; note: string }> {
  const ready = readiness(env);
  if (dry) return { rows: 0, note: `dry · ready=${ready.ready} · blockers=${ready.blockers.join(',') || 'none'}` };
  if (!ready.ready || !ready.config) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `UPDATE vn_einvoice_documents
          SET state='blocked_config', provider_message=?, next_attempt_at=NULL, updated_at=?
        WHERE state IN ('received','checking','submitting','verify_pending','blocked_config')`,
    ).bind(ready.blockers.join(','), now).run();
    return { rows: 0, note: `blocked · ${ready.blockers.join(',')}` };
  }
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(
    `SELECT id, source, source_event_id, source_order_id, action, ikey, original_ikey,
            pattern, serial, state, request_r2_key, retry_count, verify_count
       FROM vn_einvoice_documents
      WHERE state IN ('received','blocked_config','verify_pending','issued_archive_pending')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC LIMIT 20`,
  ).bind(now).all<DocumentRow>();
  let handled = 0;
  for (const row of rows.results ?? []) {
    await processDocument(env, row, ready.config);
    handled++;
  }
  return { rows: handled, note: `ready · handled=${handled}` };
}

async function health(env: Env): Promise<Response> {
  const ready = readiness(env);
  let lastRun: unknown = null;
  let counts: unknown[] = [];
  try {
    [lastRun, counts] = await Promise.all([
      env.DB.prepare(
        `SELECT started_at, finished_at, ok, rows, note, error
           FROM erp_cron_runs WHERE worker=? ORDER BY id DESC LIMIT 1`,
      ).bind(WORKER).first(),
      env.DB.prepare(
        `SELECT state, COUNT(*) AS count FROM vn_einvoice_documents GROUP BY state ORDER BY state`,
      ).all().then((r) => r.results ?? []),
    ]);
  } catch {
    // Migration may not have landed yet. Readiness remains truthful.
  }
  return json({
    ok: true,
    worker: WORKER,
    ready: ready.ready,
    blockers: ready.blockers,
    transport: ready.blockers.includes('easyinvoice_https_required') ? 'blocked_non_https' : 'https_only',
    credentials_configured: Boolean(env.EASYINVOICE_USERNAME && env.EASYINVOICE_PASSWORD && env.EASYINVOICE_TAX_CODE),
    pattern_configured: Boolean(env.EASYINVOICE_PATTERN),
    serial_configured: Boolean(env.EASYINVOICE_SERIAL),
    ingress_configured: Boolean(env.SWIFTHUB_INGEST_SECRET),
    last_run: lastRun,
    documents: counts,
  });
}

async function ingest(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env.SWIFTHUB_INGEST_SECRET)) return json({ ok: false, error: 'unauthorized' }, 401);
  let body: IngestEvent;
  try {
    body = await request.json() as IngestEvent;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const eventId = safeString(body.source_event_id, 160);
  const orderId = safeString(body.order_id, 120);
  const action = safeString(body.action, 16) || 'issue';
  if (!eventId || !orderId) return json({ ok: false, error: 'source_event_id_and_order_id_required' }, 400);
  if (!['issue', 'adjust', 'replace', 'cancel'].includes(action)) return json({ ok: false, error: 'invalid_action' }, 400);
  const invoiceAction = action as InvoiceAction;
  const existingByEvent = await env.DB.prepare(
    `SELECT id, source_order_id, action, ikey, state, invoice_no, provider_error_code, provider_message
       FROM vn_einvoice_documents WHERE source_event_id=?`,
  ).bind(eventId).first();
  if (existingByEvent) return json({ ok: true, idempotent: true, document: existingByEvent });
  if (invoiceAction === 'issue') {
    const existingOrder = await env.DB.prepare(
      `SELECT id, source_order_id, action, ikey, state, invoice_no, provider_error_code, provider_message
         FROM vn_einvoice_documents WHERE source='swifthub' AND source_order_id=? AND action='issue'`,
    ).bind(orderId).first();
    if (existingOrder) return json({ ok: true, idempotent: true, document: existingOrder });
  }
  const ikey = safeString(body.ikey, 120) || defaultIkey(orderId, invoiceAction, eventId);
  const originalIkey = safeString(body.original_ikey, 120) || null;
  const xmlData = safeString(body.xml_data, 2_000_000) || null;
  if (invoiceAction !== 'cancel' && !xmlData) return json({ ok: false, error: 'xml_data_required' }, 400);
  if (invoiceAction !== 'issue' && !originalIkey) return json({ ok: false, error: 'original_ikey_required' }, 400);
  try {
    submitBody({
      action: invoiceAction,
      ikey,
      originalIkey,
      xmlData,
      pattern: safeString(body.pattern, 40) || env.EASYINVOICE_PATTERN || '',
      serial: safeString(body.serial, 40) || env.EASYINVOICE_SERIAL || '',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!['serial_required', 'pattern_required'].includes(message)) return json({ ok: false, error: message }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const requestKey = `vn-einvoice/${safeKey(orderId)}/${id}/source-event.json`;
  await archiveJson(env, requestKey, { ...body, ikey, source: 'swifthub', received_at: new Date().toISOString() });
  const ready = readiness(env);
  const state = ready.ready ? 'received' : 'blocked_config';
  try {
    await env.DB.prepare(
      `INSERT INTO vn_einvoice_documents
        (id, source, source_event_id, source_order_id, action, ikey, original_ikey,
         pattern, serial, state, provider_message, request_r2_key, next_attempt_at,
         created_at, updated_at)
       VALUES (?, 'swifthub', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, eventId, orderId, invoiceAction, ikey, originalIkey,
      safeString(body.pattern, 40) || env.EASYINVOICE_PATTERN || null,
      safeString(body.serial, 40) || env.EASYINVOICE_SERIAL || null,
      state,
      ready.ready ? null : ready.blockers.join(','),
      requestKey,
      ready.ready ? now : null,
      now,
      now,
    ).run();
  } catch (error) {
    const existing = await env.DB.prepare(
      `SELECT id, source_order_id, action, ikey, state, invoice_no, provider_error_code, provider_message
         FROM vn_einvoice_documents
        WHERE source_event_id=? OR (source='swifthub' AND source_order_id=? AND action='issue')
        ORDER BY created_at LIMIT 1`,
    ).bind(eventId, orderId).first();
    if (existing) return json({ ok: true, idempotent: true, document: existing });
    throw error;
  }
  if (ready.ready && ready.config) {
    const row = await loadDocument(env, id);
    if (row) await processDocument(env, row, ready.config);
  }
  const stored = await env.DB.prepare(
    `SELECT id, source_order_id, action, ikey, state, invoice_no, provider_error_code, provider_message
       FROM vn_einvoice_documents WHERE id=?`,
  ).bind(id).first();
  return json({ ok: true, idempotent: false, document: stored }, 202);
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runLogged(env, WORKER, event.cron, async (e, dry) => queueRun(e, dry), event.scheduledTime)
        .then((result) => { if (!result.ok) throw new Error(result.error); }),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return health(env);
    if (request.method === 'POST' && url.pathname === '/webhooks/swifthub') return ingest(request, env);
    if (request.method === 'POST' && url.pathname === '/run') {
      if (!authorized(request, env.ERP_RUN_SECRET)) return json({ ok: false, error: 'unauthorized' }, 401);
      return json(await runLogged(env, WORKER, 'manual', async (e, dry) => queueRun(e, dry)));
    }
    return json({ ok: false, error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;
