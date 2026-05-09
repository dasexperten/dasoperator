'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Send, CheckCircle, Truck } from 'lucide-react';
import {
  getOperation,
  type Operation,
  type OperationLineItem,
} from '@/lib/api';
import { formatMoney } from '@/lib/money';
import Breadcrumb from '@/components/layout/breadcrumb';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: '14px',
  fontWeight: 700,
  backgroundColor: 'var(--paper-sunk)',
  border: '1px solid var(--border-hairline)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--fg-1)',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '14px',
  fontWeight: 600,
  color: 'var(--fg-2)',
  marginBottom: '6px',
};

// Predefined shipper preset list — populated from the shippers directory.
// Email is left blank by default — user enters it before sending.
const SHIPPER_PRESETS: { slug: string; name: string; email: string }[] = [
  { slug: 'inter-freight', name: 'Inter-Freight LTD', email: '' },
  { slug: 'trans-imperial', name: 'Trans Imperial', email: '' },
  { slug: 'dd-logistics', name: 'DD Logistics', email: '' },
  { slug: 'neptune', name: 'Neptune', email: '' },
  { slug: 'avis-trans', name: 'Avis-Trans', email: '' },
  { slug: 'custom', name: 'Other (manual entry)', email: '' },
];

function formatDate(unixSec?: number | null): string {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toISOString().split('T')[0]!;
}

function buildEmailBody(operation: Operation, lineItems: OperationLineItem[]): string {
  const skuLines = lineItems.map((li, i) => {
    const sku = (li.product_id ?? '').toUpperCase().replace('PRD_', '');
    const name = li.product_name ?? li.invoice_label ?? sku;
    return `${i + 1}. ${sku} — ${name}\n   Qty: ${li.qty.toLocaleString('en-US')} pcs\n   Cartons: ${li.cartons}`;
  }).join('\n\n');

  const totalQty = lineItems.reduce((s, li) => s + li.qty, 0);
  const totalCartons = lineItems.reduce((s, li) => s + (li.cartons ?? 0), 0);

  return `Dear partner,

We would like to request a freight quote for the following shipment.

SHIPMENT DETAILS
Reference: ${operation.reference ?? operation.id}
Operation type: ${operation.operation_type}
Date: ${formatDate(operation.operation_date)}
Manufacturer / Origin: ${operation.manufacturer_name ?? 'TBD'}
Incoterms: ${operation.incoterms ?? 'TBD'}

LINE ITEMS
${skuLines}

TOTALS
Total quantity: ${totalQty.toLocaleString('en-US')} pcs
Total cartons: ${totalCartons}
Goods value: ${operation.currency} ${formatMoney(operation.total_amount, operation.currency)}

Please advise:
- Estimated freight cost
- Transit time
- Required documents from our side
- Earliest pickup date

Thank you,
Das Experten`;
}

export default function FreightRfqClient({ operationId }: { operationId: string }) {
  const router = useRouter();

  const [operation, setOperation] = useState<Operation | null>(null);
  const [lineItems, setLineItems] = useState<OperationLineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [shipperSlug, setShipperSlug] = useState<string>('inter-freight');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Load operation
  useEffect(() => {
    (async () => {
      const res = await getOperation(operationId);
      if (res.success && res.result) {
        setOperation(res.result.operation);
        setLineItems(res.result.line_items);
        setLoadError(null);
      } else {
        setLoadError(res.errors?.[0]?.message ?? 'Operation not found');
      }
      setLoading(false);
    })();
  }, [operationId]);

  // Auto-fill subject and body once operation is loaded
  useEffect(() => {
    if (!operation) return;
    setSubject(`Freight RFQ — ${operation.reference ?? operation.id}`);
    setBodyText(buildEmailBody(operation, lineItems));
  }, [operation, lineItems]);

  const selectedShipper = useMemo(
    () => SHIPPER_PRESETS.find((s) => s.slug === shipperSlug) ?? SHIPPER_PRESETS[0]!,
    [shipperSlug]
  );

  async function handleSend() {
    setSendError(null);
    if (!recipientEmail.trim()) { setSendError('Enter recipient email'); return; }
    if (!subject.trim()) { setSendError('Subject cannot be empty'); return; }
    if (!bodyText.trim()) { setSendError('Body cannot be empty'); return; }

    setSending(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'https://dasoperator-api.dasexperten.workers.dev';
      const res = await fetch(`${apiUrl}/api/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send',
          recipient: recipientEmail.trim(),
          subject: subject.trim(),
          body_plain: bodyText,
          context: `Freight RFQ for operation ${operation?.reference ?? operationId} to ${selectedShipper.name}`,
        }),
      });
      const data = await res.json() as { success: boolean; errors?: { message: string }[] };
      if (data.success) {
        setSent(true);
      } else {
        setSendError(data.errors?.[0]?.message ?? 'Failed to send email');
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-3)' }} />
      </div>
    );
  }

  if (loadError || !operation) {
    return (
      <div className="space-y-4">
        <Breadcrumb items={[
          { label: 'Operations', href: '/operations' },
          { label: 'Freight RFQ' },
        ]} />
        <p style={{ fontSize: '14px', color: 'var(--brand-rot)' }}>{loadError ?? 'Failed to load operation'}</p>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="space-y-6">
        <Breadcrumb items={[
          { label: 'Operations', href: '/operations' },
          { label: operation.reference ?? operationId, href: `/operations/${operationId}` },
          { label: 'Freight RFQ' },
        ]} />
        <div style={{
          padding: '32px',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
          backgroundColor: 'var(--paper)',
          textAlign: 'center',
        }}>
          <CheckCircle style={{ color: 'var(--status-success)', width: 40, height: 40, margin: '0 auto 16px' }} />
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)', marginBottom: '8px' }}>
            Заявка отправлена
          </h2>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '24px' }}>
            Sent to <strong>{recipientEmail}</strong> ({selectedShipper.name})
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <button
              onClick={() => router.push(`/operations/${operationId}`)}
              style={{ padding: '10px 24px', fontSize: '14px', fontWeight: 600, border: 'none', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--brand-rot)', color: '#FFFFFF', cursor: 'pointer' }}
            >
              Back to operation
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Breadcrumb items={[
        { label: 'Operations', href: '/operations' },
        { label: operation.reference ?? operationId, href: `/operations/${operationId}` },
        { label: 'Freight RFQ' },
      ]} />

      <div>
        <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>Freight forwarding request</p>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)', marginTop: '4px' }}>
          Заявка логисту — {operation.reference ?? operationId}
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px' }}>
          Выбери шиппера, проверь содержимое и отправь запрос на котировку
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div style={{ maxWidth: '720px', display: 'grid', gap: '20px' }}>

        {/* Shipper select */}
        <div>
          <label style={labelStyle}>Шиппер</label>
          <div style={{ display: 'grid', gap: '8px' }}>
            {SHIPPER_PRESETS.map((s) => (
              <button
                key={s.slug}
                onClick={() => setShipperSlug(s.slug)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '14px 16px',
                  border: `1px solid ${shipperSlug === s.slug ? 'var(--brand-rot)' : 'var(--border-hairline)'}`,
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: shipperSlug === s.slug ? 'rgba(229,32,44,0.06)' : 'var(--paper-sunk)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  border: `2px solid ${shipperSlug === s.slug ? 'var(--brand-rot)' : 'var(--border-hairline)'}`,
                  flexShrink: 0,
                  backgroundColor: shipperSlug === s.slug ? 'var(--brand-rot)' : 'transparent',
                }} />
                <Truck className="h-4 w-4" style={{ color: 'var(--fg-3)' }} />
                <p style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', margin: 0 }}>{s.name}</p>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={labelStyle}>Email получателя</label>
          <input
            type="email"
            placeholder="logistics@inter-freight.com"
            value={recipientEmail}
            onChange={(e) => setRecipientEmail(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div>
          <label style={labelStyle}>Тема</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div>
          <label style={labelStyle}>Текст письма <span style={{ fontWeight: 400, color: 'var(--fg-3)' }}>(автозаполнено из операции)</span></label>
          <textarea
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            rows={20}
            style={{
              ...inputStyle,
              fontFamily: 'var(--font-mono, monospace)',
              fontWeight: 400,
              fontSize: '14px',
              minHeight: '380px',
              resize: 'vertical',
              lineHeight: '1.6',
            }}
          />
        </div>

        {sendError && <p style={{ fontSize: '14px', color: 'var(--brand-rot)' }}>{sendError}</p>}

        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={() => router.push(`/operations/${operationId}`)}
            style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-1)', cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending}
            style={{ padding: '10px 24px', fontSize: '14px', fontWeight: 600, border: 'none', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--brand-rot)', color: '#FFFFFF', cursor: sending ? 'not-allowed' : 'pointer', opacity: sending ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: '8px' }}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Отправить заявку
          </button>
        </div>
      </div>
    </div>
  );
}
