'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPost } from '@/lib/api';
export const runtime = 'edge';

type Status = {
  checkedAt: string; oauthConfigured: boolean; replacementReady: boolean;
  accounts: { email: string; connected: boolean; messageCount: number | null; error: string | null }[];
  addresses: { address: string; owner: string; connectedMailbox: string | null }[];
  remainingChecks: string[];
};
type ImportResult = { email: string; receipts: { messageId: string; direction: string; attachments: number; keys: string[] }[]; nextPageToken: string | null; complete: boolean };
export default function WorkspaceTestPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [imports, setImports] = useState<Record<string, ImportResult>>({});
  const refresh = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const response = await apiGet<Status>('/api/email/workspace/status');
      if (!response.success || !response.result) throw new Error(response.errors?.[0]?.message || 'Connection check failed');
      setStatus(response.result);
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection check failed'); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function importPage(email: string) {
    setBusy(true); setError('');
    try {
      const response = await apiPost<ImportResult>('/api/email/workspace/sync', { email, pageToken: imports[email]?.nextPageToken || undefined });
      if (!response.success || !response.result) throw new Error(response.errors?.[0]?.message || 'Import failed');
      const result = response.result;
      setImports(previous => ({ ...previous, [email]: result }));
    } catch (e) { setError(e instanceof Error ? e.message : 'Import failed'); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
    <Link href="/emailer" className="text-sm underline">← ERP mail</Link>
    <header><h1 className="text-3xl font-semibold">Workspace email test</h1><div className="mt-2"><p className="text-muted-foreground">Connect business Gmail to the ERP and verify the mail history before switching delivery.</p></div></header>
    <section className="rounded-lg border border-warning bg-muted p-4">
      <h2 className="font-semibold">Mail replacement is not yet verified</h2>
      <p className="mt-1 text-sm">Connection, delivery, replies, attachments and the Gmail copy must all pass. This page does not change live mail routing.</p>
    </section>
    <button onClick={() => void refresh()} disabled={busy} className="rounded bg-schwarz px-4 py-2 text-white disabled:opacity-50">{busy ? 'Checking…' : 'Check connections'}</button>
    {error && <p role="alert" className="rounded border border-error bg-card p-4">{error}</p>}
    {status && <>
      <p className="text-sm text-muted-foreground">Checked {new Date(status.checkedAt).toLocaleString()}</p>
      {!status.accounts.length && <section className="rounded-lg border p-4"><h2 className="font-semibold">Connect Workspace first</h2><p className="mt-2">Business Gmail access has not been connected to the ERP. Your Google sign-in alone does not grant the ERP access to mail.</p></section>}
      {status.accounts.map(account => <section key={account.email} className="space-y-3 rounded-lg border p-4">
        <h2 className="break-all text-base md:text-lg font-semibold">{account.email}</h2>
        <p>{account.connected ? `Connected · ${account.messageCount} messages in Gmail` : account.error}</p>
        {account.connected && <><p className="text-sm text-muted-foreground">Import up to 20 messages with their attachments into ERP history. Messages remain in Gmail. Continue until the mailbox history is imported.</p>
          <button disabled={busy || imports[account.email]?.complete} onClick={() => void importPage(account.email)} className="rounded border px-4 py-2 disabled:opacity-50">{imports[account.email]?.complete ? 'Import complete' : imports[account.email]?.nextPageToken ? 'Import next 20' : 'Import first 20'}</button></>}
        {imports[account.email] && <p role="status">{imports[account.email].receipts.length} messages verified in the ERP archive on this page. {imports[account.email].complete ? 'No more pages.' : 'More history remains.'}</p>}
      </section>)}
      <section><h2 className="mb-3 text-xl font-semibold">Your business addresses</h2><div className="grid gap-3 sm:grid-cols-2">{status.addresses.map(row => <article key={row.address} className="rounded-lg border p-4"><h3 className="break-all text-base font-medium">{row.address}</h3><p className="text-sm">{row.owner}</p><p className="mt-2 text-sm">{row.connectedMailbox ? `Sending identity found in ${row.connectedMailbox}` : 'Workspace identity not verified'}</p></article>)}</div></section>
      <section className="rounded-lg border p-4"><h2 className="font-semibold">Before replacing current email</h2><ul className="mt-3 list-disc space-y-2 pl-5">{status.remainingChecks.map(check => <li key={check}>{check}</li>)}</ul></section>
    </>}
  </main>;
}
