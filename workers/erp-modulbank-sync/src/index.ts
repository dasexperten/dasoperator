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

async function modulbankPost(path: string, token: string, payload: unknown): Promise<unknown> {
  const response = await fetch(`https://api.modulbank.ru${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Modulbank HTTP ${response.status}: ${responseText.slice(0, 200)}`);
  }
  return JSON.parse(responseText);
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
