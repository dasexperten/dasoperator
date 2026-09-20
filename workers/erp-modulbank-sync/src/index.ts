// The pinned Workers types trail the runtime; node:tls is available from
// compatibility_date 2026-08-04 onward.
// @ts-expect-error Cloudflare runtime API documented for current compatibility date
import { connect } from 'node:tls';
import { erpWorker, type BaseEnv } from '../../_shared/run';

interface Env extends BaseEnv {
  ERP: Fetcher;
  MODULBANK_TOKEN_DEE?: string;
}

interface Account {
  id: string;
  account_number: string;
  external_account_id: string;
  last_transaction_at: number | null;
}

// Public Russian Trusted Root CA served in api.modulbank.ru's verified chain.
// Pinning this root keeps certificate and hostname verification enabled; the
// API bearer token remains a Worker secret and is never stored in source.
const RUSSIAN_TRUSTED_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIFwjCCA6qgAwIBAgICEAAwDQYJKoZIhvcNAQELBQAwcDELMAkGA1UEBhMCUlUx
PzA9BgNVBAoMNlRoZSBNaW5pc3RyeSBvZiBEaWdpdGFsIERldmVsb3BtZW50IGFu
ZCBDb21tdW5pY2F0aW9uczEgMB4GA1UEAwwXUnVzc2lhbiBUcnVzdGVkIFJvb3Qg
Q0EwHhcNMjIwMzAxMjEwNDE1WhcNMzIwMjI3MjEwNDE1WjBwMQswCQYDVQQGEwJS
VTE/MD0GA1UECgw2VGhlIE1pbmlzdHJ5IG9mIERpZ2l0YWwgRGV2ZWxvcG1lbnQg
YW5kIENvbW11bmljYXRpb25zMSAwHgYDVQQDDBdSdXNzaWFuIFRydXN0ZWQgUm9v
dCBDQTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAMfFOZ8pUAL3+r2n
qqE0Zp52selXsKGFYoG0GM5bwz1bSFtCt+AZQMhkWQheI3poZAToYJu69pHLKS6Q
XBiwBC1cvzYmUYKMYZC7jE5YhEU2bSL0mX7NaMxMDmH2/NwuOVRj8OImVa5s1F4U
zn4Kv3PFlDBjjSjXKVY9kmjUBsXQrIHeaqmUIsPIlNWUnimXS0I0abExqkbdrXbX
YwCOXhOO2pDUx3ckmJlCMUGacUTnylyQW2VsJIyIGA8V0xzdaeUXg0VZ6ZmNUr5Y
Ber/EAOLPb8NYpsAhJe2mXjMB/J9HNsoFMBFJ0lLOT/+dQvjbdRZoOT8eqJpWnVD
U+QL/qEZnz57N88OWM3rabJkRNdU/Z7x5SFIM9FrqtN8xewsiBWBI0K6XFuOBOTD
4V08o4TzJ8+Ccq5XlCUW2L48pZNCYuBDfBh7FxkB7qDgGDiaftEkZZfApRg2E+M9
G8wkNKTPLDc4wH0FDTijhgxR3Y4PiS1HL2Zhw7bD3CbslmEGgfnnZojNkJtcLeBH
BLa52/dSwNU4WWLubaYSiAmA9IUMX1/RpfpxOxd4Ykmhz97oFbUaDJFipIggx5sX
ePAlkTdWnv+RWBxlJwMQ25oEHmRguNYf4Zr/Rxr9cS93Y+mdXIZaBEE0KS2iLRqa
OiWBki9IMQU4phqPOBAaG7A+eP8PAgMBAAGjZjBkMB0GA1UdDgQWBBTh0YHlzlpf
BKrS6badZrHF+qwshzAfBgNVHSMEGDAWgBTh0YHlzlpfBKrS6badZrHF+qwshzAS
BgNVHRMBAf8ECDAGAQH/AgEEMA4GA1UdDwEB/wQEAwIBhjANBgkqhkiG9w0BAQsF
AAOCAgEAALIY1wkilt/urfEVM5vKzr6utOeDWCUczmWX/RX4ljpRdgF+5fAIS4vH
tmXkqpSCOVeWUrJV9QvZn6L227ZwuE15cWi8DCDal3Ue90WgAJJZMfTshN4OI8cq
W9E4EG9wglbEtMnObHlms8F3CHmrw3k6KmUkWGoa+/ENmcVl68u/cMRl1JbW2bM+
/3A+SAg2c6iPDlehczKx2oa95QW0SkPPWGuNA/CE8CpyANIhu9XFrj3RQ3EqeRcS
AQQod1RNuHpfETLU/A2gMmvn/w/sx7TB3W5BPs6rprOA37tutPq9u6FTZOcG1Oqj
C/B7yTqgI7rbyvox7DEXoX7rIiEqyNNUguTk/u3SZ4VXE2kmxdmSh3TQvybfbnXV
4JbCZVaqiZraqc7oZMnRoWrXRG3ztbnbes/9qhRGI7PqXqeKJBztxRTEVj8ONs1d
WN5szTwaPIvhkhO3CO5ErU2rVdUr89wKpNXbBODFKRtgxUT70YpmJ46VVaqdAhOZ
D9EUUn4YaeLaS8AjSF/h7UkjOibNc4qVDiPP+rkehFWM66PVnP1Msh93tc+taIfC
EYVMxjh8zNbFuoc7fzvvrFILLe7ifvEIUqSVIC/AzplM/Jxw7buXFeGP1qVCBEHq
391d/9RAfaZ12zkwFsl+IKwE/OZxW8AHa9i1p4GO0YSNuczzEm4=
-----END CERTIFICATE-----`;

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((n, part) => n + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function indexOfBytes(haystack: Uint8Array, needle: number[], start = 0): number {
  outer: for (let i = start; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function decodeChunked(body: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const lineEnd = indexOfBytes(body, [13, 10], cursor);
    if (lineEnd < 0) throw new Error('Modulbank returned malformed chunked HTTP');
    const sizeLine = new TextDecoder().decode(body.slice(cursor, lineEnd));
    const size = Number.parseInt(sizeLine.split(';', 1)[0], 16);
    if (!Number.isFinite(size)) throw new Error('Modulbank returned invalid HTTP chunk size');
    cursor = lineEnd + 2;
    if (size === 0) break;
    parts.push(body.slice(cursor, cursor + size));
    cursor += size + 2;
  }
  return concat(parts);
}

async function modulbankPost(path: string, token: string, payload: unknown): Promise<unknown> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    let socket: ReturnType<typeof connect>;
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const parseCompleteResponse = (): unknown | undefined => {
      const raw = concat(chunks);
      const splitAt = indexOfBytes(raw, [13, 10, 13, 10]);
      if (splitAt < 0) return undefined;
      const head = new TextDecoder().decode(raw.slice(0, splitAt));
      const responseBytes = raw.slice(splitAt + 4);
      let responseBody: Uint8Array;
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        if (indexOfBytes(responseBytes, [13, 10, 48, 13, 10]) < 0) return undefined;
        responseBody = decodeChunked(responseBytes);
      } else {
        const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? -1);
        if (length < 0 || responseBytes.byteLength < length) return undefined;
        responseBody = responseBytes.slice(0, length);
      }
      const status = Number(head.split('\r\n', 1)[0].split(' ')[1]);
      const responseText = new TextDecoder().decode(responseBody);
      if (status < 200 || status >= 300) {
        throw new Error(`Modulbank HTTP ${status}: ${responseText.slice(0, 200)}`);
      }
      return JSON.parse(responseText);
    };
    const timer = setTimeout(() => finish(new Error('Modulbank TLS request timed out')), 15_000);
    socket = connect({
      host: 'api.modulbank.ru',
      port: 443,
      servername: 'api.modulbank.ru',
      ca: RUSSIAN_TRUSTED_ROOT_CA,
      rejectUnauthorized: true,
    }, () => {
      if (!socket.authorized) {
        socket.destroy();
        finish(new Error(`Modulbank TLS rejected: ${socket.authorizationError ?? 'unknown error'}`));
        return;
      }
      socket.end([
        `POST ${path} HTTP/1.1`,
        'Host: api.modulbank.ru',
        `Authorization: Bearer ${token}`,
        'Content-Type: application/json',
        'Accept: application/json',
        'Accept-Encoding: identity',
        `Content-Length: ${new TextEncoder().encode(body).byteLength}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'));
    });
    socket.on('data', (chunk: Uint8Array) => {
      chunks.push(new Uint8Array(chunk));
      try {
        const value = parseCompleteResponse();
        if (value !== undefined) finish(undefined, value);
      } catch (error) {
        finish(error);
      }
    });
    socket.on('error', (error: unknown) => finish(error));
    socket.on('end', () => {
      try {
        const value = parseCompleteResponse();
        if (value === undefined) throw new Error('Modulbank returned incomplete HTTP');
        finish(undefined, value);
      } catch (error) {
        finish(error);
      }
    });
  });
}

export default erpWorker<Env>('erp-modulbank-sync', async (env, dry) => {
  if (dry) return { note: 'dry · Modulbank API not called' };
  if (!env.ERP_RUN_SECRET) throw new Error('ERP_RUN_SECRET is not configured');
  if (!env.MODULBANK_TOKEN_DEE) throw new Error('MODULBANK_TOKEN_DEE is not configured');

  const auth = { Authorization: `Bearer ${env.ERP_RUN_SECRET}` };
  const accountsResponse = await env.ERP.fetch('https://internal/internal/cron/modulbank/accounts', { headers: auth });
  const accountBody = await accountsResponse.json() as { ok?: boolean; accounts?: Account[]; error?: string };
  if (!accountsResponse.ok || !accountBody.ok) {
    throw new Error(`ERP account cursor failed: HTTP ${accountsResponse.status} ${accountBody.error ?? ''}`.trim());
  }

  const today = new Date();
  let fetched = 0;
  let stored = 0;
  for (const account of accountBody.accounts ?? []) {
    const defaultFrom = today.getTime() - 90 * 24 * 3600_000;
    const fromMs = account.last_transaction_at
      ? Math.max(0, (account.last_transaction_at - 24 * 3600) * 1000)
      : defaultFrom;
    const from = new Date(fromMs).toISOString().slice(0, 10);
    const till = today.toISOString().slice(0, 10);

    for (let page = 0; page < 200; page++) {
      const operations = await modulbankPost(
        `/v1/operation-history/${encodeURIComponent(account.external_account_id)}`,
        env.MODULBANK_TOKEN_DEE,
        { from: `${from}T00:00:00`, till: `${till}T23:59:59`, skip: page * 50, records: 50 },
      );
      if (!Array.isArray(operations)) throw new Error('Modulbank history response is not an array');
      if (operations.length === 0) break;
      fetched += operations.length;

      const imported = await env.ERP.fetch('https://internal/internal/cron/modulbank/import', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: account.id, operations }),
      });
      const result = await imported.json() as { ok?: boolean; stored?: number; error?: string };
      if (!imported.ok || !result.ok) {
        throw new Error(`ERP Modulbank import failed: HTTP ${imported.status} ${result.error ?? ''}`.trim());
      }
      stored += result.stored ?? 0;
      if (operations.length < 50) break;
    }
  }
  return { rows: stored, note: `Modulbank API fetched ${fetched}, stored ${stored}` };
});
