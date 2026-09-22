// The pinned Workers types trail the runtime; node:crypto is available through
// the worker's nodejs_compat flag on the selected compatibility date.
// @ts-expect-error Cloudflare runtime API documented for current compatibility date
import { createHash, randomBytes } from 'node:crypto';

export type InvoiceAction = 'issue' | 'adjust' | 'replace' | 'cancel';

export interface EasyInvoiceConfig {
  baseUrl: string;
  username: string;
  password: string;
  taxCode: string;
  pattern: string;
  serial: string;
  timeoutMs?: number;
}

export interface ProviderEnvelope {
  Status?: number | string;
  ErrorCode?: number | string;
  Message?: string;
  Data?: unknown;
  [key: string]: unknown;
}

export interface ProviderResult {
  httpStatus: number;
  body: ProviderEnvelope;
}

export interface SubmitInput {
  action: InvoiceAction;
  ikey: string;
  originalIkey?: string | null;
  xmlData?: string | null;
  pattern: string;
  serial: string;
}

const ENDPOINTS: Record<InvoiceAction | 'status' | 'download', string> = {
  issue: 'api/publish/importAndIssueInvoice',
  adjust: 'api/business/adjustInvoice',
  replace: 'api/business/replaceInvoice',
  cancel: 'api/business/cancelInvoice',
  status: 'api/publish/checkInvoiceState',
  download: 'api/publish/getInvoicePdf',
};

export function strictBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('easyinvoice_https_required');
  if (url.username || url.password || url.search || url.hash) throw new Error('easyinvoice_base_url_invalid');
  return url.toString().replace(/\/$/, '');
}

export function buildAuthentication(input: {
  method?: string;
  username: string;
  password: string;
  taxCode: string;
  timestamp?: string;
  nonce?: string;
}): string {
  const method = (input.method ?? 'POST').toUpperCase();
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const nonce = input.nonce ?? randomBytes(16).toString('hex');
  const signature = createHash('md5').update(`${method}${timestamp}${nonce}`).digest('base64');
  return `${signature}:${nonce}:${timestamp}:${input.username}:${input.password}:${input.taxCode}`;
}

export function endpointFor(action: InvoiceAction | 'status' | 'download'): string {
  return ENDPOINTS[action];
}

export function isCircular78Pattern(pattern: string): boolean {
  return /^\dC\d{2}[A-Z0-9]{3}$/i.test(pattern.trim());
}

export function extractXmlIkey(xml: string): string | null {
  const match = xml.match(/<Ikey>\s*([^<]+?)\s*<\/Ikey>/i);
  return match?.[1]?.trim() || null;
}

export function submitBody(input: SubmitInput): Record<string, unknown> {
  if (!input.pattern) throw new Error('pattern_required');
  // Circular 78 combines the old template number and symbol in Pattern.
  // EasyInvoice v8 explicitly requires Serial to be the empty string for
  // values such as 1C26TAA. Legacy Circular 32 patterns still need Serial.
  if (!input.serial && !isCircular78Pattern(input.pattern)) throw new Error('serial_required');
  if (input.action === 'cancel') {
    const target = input.originalIkey || input.ikey;
    if (!target) throw new Error('original_ikey_required');
    return { Ikey: target, Pattern: input.pattern, Serial: input.serial };
  }
  if (!input.xmlData) throw new Error('xml_data_required');
  const xmlIkey = extractXmlIkey(input.xmlData);
  if (!xmlIkey) throw new Error('xml_ikey_required');
  if (xmlIkey !== input.ikey) throw new Error('xml_ikey_mismatch');
  if (input.action === 'issue') {
    return { XmlData: input.xmlData, Pattern: input.pattern, Serial: input.serial };
  }
  if (!input.originalIkey) throw new Error('original_ikey_required');
  return {
    Ikey: input.originalIkey,
    XmlData: input.xmlData,
    Pattern: input.pattern,
    Serial: input.serial,
  };
}

export function statusBody(ikey: string): Record<string, unknown> {
  if (!ikey) throw new Error('ikey_required');
  return { Ikeys: [ikey] };
}

export function downloadBody(ikey: string, pattern: string, option: -1 | 0 | 1 | 2): Record<string, unknown> {
  return { Ikey: ikey, Pattern: pattern, Option: option };
}

export function codeOf(body: ProviderEnvelope): string {
  return body.ErrorCode === undefined || body.ErrorCode === null ? '' : String(body.ErrorCode);
}

export function statusOf(body: ProviderEnvelope): number | null {
  const status = Number(body.Status);
  return Number.isFinite(status) ? status : null;
}

export function isProviderSuccess(body: ProviderEnvelope): boolean {
  return statusOf(body) === 2 || codeOf(body) === '0';
}

export function isMissingIkey(body: ProviderEnvelope): boolean {
  return codeOf(body) === '128';
}

export function needsVerification(body: ProviderEnvelope): boolean {
  return ['125', '126', '169', '170', '193'].includes(codeOf(body));
}

export function isConfigurationBlock(body: ProviderEnvelope): boolean {
  return ['107', '111', '117', '174', '175', '176', '177', '178', '195', '196'].includes(codeOf(body));
}

export function providerMessage(body: ProviderEnvelope): string {
  const raw = body.Message;
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
}

export function invoiceFacts(body: ProviderEnvelope, ikey: string): { invoiceNo: string | null; lookupCode: string | null } {
  const data = body.Data && typeof body.Data === 'object' ? body.Data as Record<string, unknown> : {};
  const keyInvoiceNo = data.KeyInvoiceNo && typeof data.KeyInvoiceNo === 'object'
    ? data.KeyInvoiceNo as Record<string, unknown>
    : {};
  const invoiceNo = keyInvoiceNo[ikey] === undefined ? null : String(keyInvoiceNo[ikey]);
  const invoices = Array.isArray(data.Invoices) ? data.Invoices : [];
  const invoice = invoices.find((row) => row && typeof row === 'object' && String((row as Record<string, unknown>).Ikey ?? '') === ikey) as Record<string, unknown> | undefined;
  return {
    invoiceNo: invoiceNo ?? (invoice?.No === undefined ? null : String(invoice.No)),
    lookupCode: invoice?.LookupCode === undefined ? null : String(invoice.LookupCode),
  };
}

async function post(config: EasyInvoiceConfig, endpoint: string, body: Record<string, unknown>): Promise<Response> {
  const base = strictBaseUrl(config.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 20_000);
  try {
    return await fetch(`${base}/${endpoint}`, {
      method: 'POST',
      headers: {
        Authentication: buildAuthentication(config),
        'Content-Type': 'application/json',
        Accept: 'application/json, application/pdf, application/xml, text/xml',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function callJson(
  config: EasyInvoiceConfig,
  action: InvoiceAction | 'status',
  body: Record<string, unknown>,
): Promise<ProviderResult> {
  const response = await post(config, endpointFor(action), body);
  const text = await response.text();
  let parsed: ProviderEnvelope;
  try {
    parsed = JSON.parse(text) as ProviderEnvelope;
  } catch {
    parsed = { Status: response.ok ? 2 : 5, ErrorCode: `HTTP_${response.status}`, Message: text.slice(0, 500) };
  }
  return { httpStatus: response.status, body: parsed };
}

export async function downloadInvoice(
  config: EasyInvoiceConfig,
  ikey: string,
  pattern: string,
  option: -1 | 0 | 1 | 2,
): Promise<{ httpStatus: number; contentType: string; bytes: ArrayBuffer }> {
  const response = await post(config, endpointFor('download'), downloadBody(ikey, pattern, option));
  const bytes = await response.arrayBuffer();
  if (!response.ok) {
    const text = new TextDecoder().decode(bytes.slice(0, 500));
    throw new Error(`easyinvoice_download_http_${response.status}:${text}`);
  }
  return {
    httpStatus: response.status,
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    bytes,
  };
}
