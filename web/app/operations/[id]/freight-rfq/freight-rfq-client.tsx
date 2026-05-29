'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, FileText, CheckCircle, Truck, Mail, Download } from 'lucide-react';
import {
  getOperation,
  type Operation,
  type OperationLineItem,
} from '@/lib/api';
import { formatMoney } from '@/lib/money';
import Breadcrumb from '@/components/layout/breadcrumb';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'https://dasoperator-api.dasexperten.workers.dev';

interface Shipper {
  id: string;
  slug: string;
  trade_name: string;
  legal_name_en: string | null;
  email: string | null;
  country: string | null;
}

interface IssueResult {
  document_id: string;
  document_number: string;
  r2_key: string;
  download_url: string;
  shipper: { id: string; name: string; email: string | null };
}

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

function formatDate(unixSec?: number | null): string {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toISOString().split('T')[0]!;
}

function buildEmailBody(
  operation: Operation,
  lineItems: OperationLineItem[],
  shipperName: string,
  documentNumber: string,
): string {
  const skuLines = lineItems.map((li, i) => {
    const sku = (li.product_id ?? '').toUpperCase().replace('PRD_', '');
    const name = li.product_name ?? li.invoice_label ?? sku;
    return `${i + 1}. ${sku} — ${name}\n   Qty: ${li.qty.toLocaleString('en-US')} pcs\n   Cartons: ${li.cartons}`;
  }).join('\n\n');

  const totalQty = lineItems.reduce((s, li) => s + li.qty, 0);
  const totalCartons = lineItems.reduce((s, li) => s + (li.cartons ?? 0), 0);

  return `Dear ${shipperName} team,

Please find attached our freight quotation request ${documentNumber}.

Shipment summary:
- Reference: ${operation.reference ?? operation.id}
- Operation type: ${operation.operation_type}
- Date: ${formatDate(operation.operation_date)}
- Manufacturer / Origin: ${operation.manufacturer_name ?? 'TBD'}
- Incoterms: ${operation.incoterms ?? 'TBD'}

Line items:
${skuLines}

Totals:
- Total quantity: ${totalQty.toLocaleString('en-US')} pcs
- Total cartons: ${totalCartons}
- Goods value: ${operation.currency} ${formatMoney(operation.total_amount, operation.currency)}

Please advise estimated freight cost, transit time, required documents from our side, and earliest pickup date.

Kind regards,
Das Experten`;
}

export default function FreightRfqClient({ operationId }: { operationId: string }) {
  const router = useRouter();

  const searchParams = useSearchParams();
  const [operation, setOperation] = useState<Operation | null>(null);
  const [lineItems, setLineItems] = useState<OperationLineItem[]>([]);
  const [shippers, setShippers] = useState<Shipper[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [shipperId, setShipperId] = useState<string>('');
  const [pickupDate, setPickupDate] = useState<string>('');
  const [notes, setNotes] = useState('');

  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssueResult | null>(null);

  const [sendEmail, setSendEmail] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [opRes, shipRes] = await Promise.all([
          getOperation(operationId),
          fetch(`${API_URL}/api/freight-rfq/shippers`).then(r => r.json() as Promise<{
            success: boolean; result?: { shippers: Shipper[] }; errors?: { message: string }[];
          }>),
        ]);

        if (opRes.success && opRes.result) {
          setOperation(opRes.result.operation);
          setLineItems(opRes.result.line_items);
        } else {
          setLoadError(opRes.errors?.[0]?.message ?? 'Operation not found');
        }

        if (shipRes.success && shipRes.result) {
          setShippers(shipRes.result.shippers);
          const preselected = searchParams?.get('shipper');
          const exists = preselected && shipRes.result.shippers.some(s => s.id === preselected);
          if (exists) {
            setShipperId(preselected!);
          } else if (shipRes.result.shippers.length > 0) {
            setShipperId(shipRes.result.shippers[0]!.id);
          }
        } else {
          setLoadError(shipRes.errors?.[0]?.message ?? 'Could not load shippers');
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    })();
  }, [operationId]);

  const selectedShipper = shippers.find(s => s.id === shipperId);

  async function handleCreate() {
    setIssueError(null);
    if (!shipperId) { setIssueError('Pick a shipper first'); return; }

    setIssuing(true);
    try {
      const pickupTs = pickupDate ? Math.floor(new Date(pickupDate).getTime() / 1000) : null;
      const res = await fetch(`${API_URL}/api/freight-rfq/operations/${operationId}/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shipper_id: shipperId,
          requested_pickup_date: pickupTs,
          notes: notes.trim() || null,
        }),
      });
      const data = await res.json() as {
        success: boolean;
        result?: IssueResult;
        errors?: { message: string }[];
      };
      if (data.success && data.result) {
        setIssued(data.result);
        if (operation && selectedShipper) {
          setRecipientEmail(selectedShipper.email ?? '');
          setEmailSubject(`Freight RFQ ${data.result.document_number} — ${operation.reference ?? operationId}`);
          setEmailBody(buildEmailBody(
            operation, lineItems,
            data.result.shipper.name,
            data.result.document_number,
          ));
        }
      } else {
        setIssueError(data.errors?.[0]?.message ?? 'Failed to create RFQ document');
      }
    } catch (e) {
      setIssueError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setIssuing(false);
    }
  }

  async function handleSendEmail() {
    if (!issued) return;
    setSendError(null);
    if (!recipientEmail.trim()) { setSendError('Enter recipient email'); return; }

    setSending(true);
    try {
      const attachmentUrl = `${API_URL}/api/documents/${issued.document_id}/file/${encodeURIComponent(issued.document_number)}.docx`;
      const res = await fetch(`${API_URL}/api/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send',
          recipient: recipientEmail.trim(),
          subject: emailSubject.trim(),
          body_plain: emailBody,
          context: `Freight RFQ ${issued.document_number} for operation ${operation?.reference ?? operationId} to ${issued.shipper.name}`,
          attachments: [attachmentUrl],
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

  if (issued) {
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
            RFQ created — {issued.document_number}
          </h1>
        </div>

        <div className="dx-ribbon-rule" />

        <div style={{
          maxWidth: '720px',
          padding: '20px 24px',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
          backgroundColor: 'var(--paper)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <CheckCircle style={{ color: 'var(--status-success)', width: 24, height: 24 }} />
            <div>
              <p style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', margin: 0 }}>
                Document saved to operation
              </p>
              <p style={{ fontSize: '14px', color: 'var(--fg-3)', margin: 0 }}>
                Recipient: <strong>{issued.shipper.name}</strong>
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <a
              href={issued.download_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ padding: '10px 16px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-1)', cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px' }}
            >
              <Download className="h-4 w-4" /> Download .docx
            </a>
            <button
              onClick={() => router.push(`/operations/${operationId}`)}
              style={{ padding: '10px 16px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-1)', cursor: 'pointer' }}
            >
              Back to operation
            </button>
          </div>
        </div>

        <div style={{ maxWidth: '720px' }}>
          {!sendEmail && !sent && (
            <button
              onClick={() => setSendEmail(true)}
              style={{ padding: '10px 16px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'transparent', color: 'var(--fg-1)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '8px' }}
            >
              <Mail className="h-4 w-4" /> Send by email (optional)
            </button>
          )}

          {sent && (
            <div style={{ padding: '14px 16px', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper)', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <CheckCircle style={{ color: 'var(--status-success)', width: 20, height: 20 }} />
              <p style={{ fontSize: '14px', color: 'var(--fg-1)', margin: 0 }}>
                Email sent to <strong>{recipientEmail}</strong> with {issued.document_number}.docx attached.
              </p>
            </div>
          )}

          {sendEmail && !sent && (
            <div style={{ padding: '20px 24px', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--paper)', marginTop: '16px', display: 'grid', gap: '16px' }}>
              <p style={{ fontSize: '14px', color: 'var(--fg-3)', margin: 0 }}>
                The RFQ .docx will be attached to the email automatically.
              </p>

              <div>
                <label style={labelStyle}>Recipient email</label>
                <input
                  type="email"
                  placeholder="logistics@shipper.com"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>Subject</label>
                <input
                  type="text"
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>Body</label>
                <textarea
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  rows={16}
                  style={{
                    ...inputStyle,
                    fontFamily: 'var(--font-mono, monospace)',
                    fontWeight: 400,
                    minHeight: '320px',
                    resize: 'vertical',
                    lineHeight: '1.6',
                  }}
                />
              </div>

              {sendError && <p style={{ fontSize: '14px', color: 'var(--brand-rot)', margin: 0 }}>{sendError}</p>}

              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  onClick={() => setSendEmail(false)}
                  style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper-raised)', color: 'var(--fg-1)', cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSendEmail}
                  disabled={sending}
                  style={{ padding: '10px 24px', fontSize: '14px', fontWeight: 600, border: 'none', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--brand-rot)', color: 'var(--fg-on-brand)', cursor: sending ? 'not-allowed' : 'pointer', opacity: sending ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: '8px' }}
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                  Send with attachment
                </button>
              </div>
            </div>
          )}
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
          Create RFQ — {operation.reference ?? operationId}
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px' }}>
          Pick a shipper. A Freight RFQ document is created and saved to this operation. Email is optional.
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div style={{ maxWidth: '720px', display: 'grid', gap: '20px' }}>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>Shipper</label>
            <Link
              href={`/operations/${operationId}/freight-rfq/add-shipper`}
              style={{
                fontSize: '13px', fontWeight: 600, padding: '6px 12px',
                background: 'var(--paper-raised, #fff)', color: 'var(--fg-1)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-md, 6px)', textDecoration: 'none',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}
            >
              + Add shipper
            </Link>
          </div>
          <div style={{ display: 'grid', gap: '8px' }}>
            {shippers.length === 0 && (
              <p style={{ fontSize: '14px', color: 'var(--fg-3)' }}>No shippers configured.</p>
            )}
            {shippers.map((s) => (
              <button
                key={s.id}
                onClick={() => setShipperId(s.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '14px 16px',
                  border: `1px solid ${shipperId === s.id ? 'var(--brand-rot)' : 'var(--border-hairline)'}`,
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: shipperId === s.id ? 'rgba(229,32,44,0.06)' : 'var(--paper-sunk)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  border: `2px solid ${shipperId === s.id ? 'var(--brand-rot)' : 'var(--border-hairline)'}`,
                  flexShrink: 0,
                  backgroundColor: shipperId === s.id ? 'var(--brand-rot)' : 'transparent',
                }} />
                <Truck className="h-4 w-4" style={{ color: 'var(--fg-3)' }} />
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', margin: 0 }}>
                    {s.legal_name_en || s.trade_name}
                  </p>
                  {s.country && (
                    <p style={{ fontSize: '14px', color: 'var(--fg-3)', margin: 0 }}>{s.country}</p>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={labelStyle}>Requested pickup date <span style={{ fontWeight: 400, color: 'var(--fg-3)' }}>(optional)</span></label>
          <input
            type="date"
            value={pickupDate}
            onChange={(e) => setPickupDate(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div>
          <label style={labelStyle}>Notes <span style={{ fontWeight: 400, color: 'var(--fg-3)' }}>(optional)</span></label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Any extra context for the shipper — packaging requirements, special handling, deadlines..."
            style={{ ...inputStyle, fontWeight: 400, minHeight: '100px', resize: 'vertical', lineHeight: '1.5' }}
          />
        </div>

        {issueError && <p style={{ fontSize: '14px', color: 'var(--brand-rot)' }}>{issueError}</p>}

        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={() => router.push(`/operations/${operationId}`)}
            style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper-raised)', color: 'var(--fg-1)', cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={issuing || !shipperId}
            style={{ padding: '10px 24px', fontSize: '14px', fontWeight: 600, border: 'none', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--brand-rot)', color: 'var(--fg-on-brand)', cursor: issuing ? 'not-allowed' : 'pointer', opacity: issuing ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: '8px' }}
          >
            {issuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            Create RFQ document
          </button>
        </div>
      </div>
    </div>
  );
}
