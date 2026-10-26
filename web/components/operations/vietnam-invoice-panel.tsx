'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { getToken } from '@/lib/auth';

const BASE = '/api/integrations/vn-einvoice/orders';
type Invoice = {
  id: string;
  source_order_id: string;
  display_status: string;
  invoice_no: string | null;
  lookup_code: string | null;
  provider_invoice_status: number | null;
  provider_pdf_r2_key: string | null;
  provider_xml_r2_key: string | null;
  provider_message: string | null;
  order: { channel: string; buyer: { name: string }; currency: string };
  fiscal_totals: { net: number; vat: number; gross: number };
  source_facts: { order_created_at: string | null; draft_date: string | null; carrier: string | null; tracking_number: string | null };
  provider_check: {
    invoice_no: string | null;
    invoice_date: string | null;
    invoice_status: number | null;
    tax_status_raw: string | null;
    tax_error: string | null;
    tax_authority_code: string | null;
  };
};
const button = { padding: '10px 16px', borderRadius: 7, border: '1px solid var(--line-1)', background: 'var(--paper)', color: 'var(--fg-1)', cursor: 'pointer', fontWeight: 600 } as const;
const labels: Record<string, string> = {
  draft: 'Готов к выпуску', received: 'Подготовка инвойса', awaiting_issue: 'Выпускаем инвойс…', submitting: 'Выпускаем инвойс…',
  verifying: 'Проверяем результат выпуска', issuance_disabled: 'Выпуск временно выключен', needs_attention: 'Нужна проверка',
  issued_pending_tax_or_archive: 'Выпущен · проверяем налоговый ответ и архив', tax_accepted_archived: 'Выпущен · принят налоговой',
};

export default function VietnamInvoicePanel({ documentId }: { documentId: string }) {
  const [doc, setDoc] = useState<Invoice | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const actionLock = useRef(false);
  const refresh = useCallback(async () => {
    const response = await apiGet<{ document: Invoice }>(`${BASE}/${encodeURIComponent(documentId)}`);
    if (!response.success || !response.result) throw new Error(response.errors?.[0]?.message || 'Не удалось загрузить инвойс');
    setDoc(response.result.document);
  }, [documentId]);

  useEffect(() => {
    let active = true;
    const load = () => refresh().catch(e => { if (active) setError(e instanceof Error ? e.message : 'Ошибка загрузки'); });
    void load();
    const timer = setInterval(load, 30000);
    return () => { active = false; clearInterval(timer); };
  }, [refresh]);

  async function action(kind: 'issue' | 'reconcile') {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await apiPost(`${BASE}/${encodeURIComponent(documentId)}/${kind}`, {});
      if (!response.success) throw new Error(response.errors?.[0]?.message || 'Не удалось выполнить действие');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Проверьте соединение и обновите статус');
    } finally { actionLock.current = false; setBusy(false); }
  }

  async function download(kind: 'pdf' | 'xml') {
    setError('');
    try {
      const response = await fetch(`https://dasoperator-api.dasexperten.workers.dev${BASE}/${encodeURIComponent(documentId)}/file/${kind}`, {
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      });
      if (!response.ok) throw new Error('Файл пока недоступен');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `invoice-${doc?.invoice_no || documentId}.${kind}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось скачать файл'); }
  }

  const number = doc?.provider_check?.invoice_no || doc?.invoice_no;
  const check = doc?.provider_check;
  const taxAccepted = !check?.tax_error && !!check?.tax_authority_code && ['1', 'Hợp lệ'].includes(check.tax_status_raw ?? '');
  const amount = (n: number) => `${n.toLocaleString('ru-RU')} ${doc?.order.currency ?? 'VND'}`;
  return (
    <section style={{ border: '1px solid var(--line-1)', borderRadius: 12, padding: 24, background: 'var(--paper)', display: 'grid', gap: 16 }}>
      {error && <p role="alert" style={{ color: 'var(--brand-rot)' }}>{error}</p>}
      {!doc ? <p>{error ? 'Инвойс не загружен.' : 'Загружаем инвойс…'}</p> : <>
        <div className="flex flex-wrap justify-between gap-4">
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 700 }}>Инвойс{number && number !== '0' ? ` № ${number}` : ''}</h2>
            <p style={{ color: 'var(--fg-2)', marginTop: 6 }}>{check?.invoice_date || doc.source_facts?.draft_date || 'Дата ещё не назначена'} · {doc.order.buyer.name}</p>
            <p style={{ color: 'var(--fg-3)', marginTop: 6 }}>{doc.order.channel} · Заказ {doc.source_order_id}</p>
          </div>
          <strong style={{ fontSize: 24 }}>{amount(doc.fiscal_totals.gross)}</strong>
        </div>
        <p>{taxAccepted ? 'Выпущен · принят налоговой' : labels[doc.display_status] || 'Проверяем статус инвойса'}</p>
        {check?.tax_error && <p role="alert" style={{ color: 'var(--brand-rot)' }}>{check.tax_error}</p>}
        <div className="flex flex-wrap gap-3">
          {doc.display_status === 'draft' && <button disabled={busy} onClick={() => action('issue')} style={{ ...button, background: 'var(--brand-rot)', borderColor: 'var(--brand-rot)', color: '#fff' }}>{busy ? 'Выпускаем…' : 'Выписать инвойс'}</button>}
          {doc.provider_pdf_r2_key && doc.provider_invoice_status !== 0 && <button style={button} onClick={() => download('pdf')}>Скачать PDF</button>}
        </div>
        <details style={{ borderTop: '1px solid var(--line-1)', paddingTop: 12 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--fg-2)' }}>Подробности</summary>
          <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
            <p>Без НДС: {amount(doc.fiscal_totals.net)} · НДС: {amount(doc.fiscal_totals.vat)}</p>
            {doc.source_facts?.order_created_at && <p>Дата заказа: {doc.source_facts.order_created_at}</p>}
            {doc.source_facts?.tracking_number && <p>{doc.source_facts.carrier} · {doc.source_facts.tracking_number}</p>}
            <p>Код поиска: {doc.lookup_code || 'ещё не присвоен'}</p>
            {check?.tax_authority_code && <p>Код налоговой: {check.tax_authority_code}</p>}
            <div className="flex flex-wrap gap-3">
              {doc.provider_xml_r2_key && <button style={button} onClick={() => download('xml')}>Скачать XML</button>}
              <button style={button} disabled={busy} onClick={() => action('reconcile')}>{busy ? 'Обновляем…' : 'Обновить статус'}</button>
            </div>
          </div>
        </details>
      </>}
      {!doc && error && <button style={button} onClick={() => refresh().then(() => setError('')).catch(e => setError(e.message))}>Повторить загрузку</button>}
    </section>
  );
}
