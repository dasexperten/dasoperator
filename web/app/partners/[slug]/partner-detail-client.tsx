'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, AlertTriangle, Loader2, FileText, Sparkles, Download } from 'lucide-react';
import {
  getPartner, getPartnerContracts, getOperations, getPayments, getPartnerNetBalance,
  getPartnerAgreements, generatePartnerNda, agreementDownloadUrl,
  type Partner, type Contract, type Operation, type Payment, type PartnerNetBalance,
  type PartnerAgreement,
} from '@/lib/api';
import { CopyableValue, SectionCard } from '@/components/ui/copyable';
import NetBalance from '@/components/ui/net-balance';
import Breadcrumb from '@/components/layout/breadcrumb';

const STATUS_COLORS: Record<Partner['status'], { bg: string; fg: string; border: string }> = {
  active:   { bg: 'rgba(46,125,79,0.08)',  fg: 'var(--status-success)', border: 'rgba(46,125,79,0.3)' },
  pending:  { bg: 'rgba(199,122,0,0.08)',  fg: 'var(--status-warning)', border: 'rgba(199,122,0,0.3)' },
  inactive: { bg: 'var(--paper-sunk)',     fg: 'var(--fg-3)',           border: 'var(--border-hairline)' },
  blocked:  { bg: 'rgba(229,32,44,0.08)',  fg: 'var(--brand-rot)',      border: 'rgba(229,32,44,0.3)' },
};

const CONTRACT_STATUS_COLORS: Record<Contract['status'], { bg: string; fg: string; border: string }> = {
  active:    { bg: 'rgba(46,125,79,0.08)',  fg: 'var(--status-success)', border: 'rgba(46,125,79,0.3)' },
  draft:     { bg: 'rgba(199,122,0,0.08)',  fg: 'var(--status-warning)', border: 'rgba(199,122,0,0.3)' },
  expired:   { bg: 'var(--paper-sunk)',     fg: 'var(--fg-3)',           border: 'var(--border-hairline)' },
  cancelled: { bg: 'rgba(229,32,44,0.08)',  fg: 'var(--brand-rot)',      border: 'rgba(229,32,44,0.3)' },
};

// Phase 4.3c — Payment overlay (mirror of /operations page)
const PAYMENT_OVERLAY: Record<string, { bg: string; fg: string; dot: string; label: string }> = {
  unpaid:  { bg: 'rgba(229,32,44,0.10)', fg: '#A82029', dot: '#E5202C', label: 'Unpaid' },
  partial: { bg: 'rgba(125,72,28,0.10)', fg: '#7D481C', dot: '#A06A2C', label: 'Partial' },
  paid:    { bg: 'rgba(46,125,79,0.10)', fg: '#2E7D4F', dot: '#3E9E63', label: 'Paid' },
  neutral: { bg: 'var(--paper-sunk)',    fg: 'var(--fg-3)', dot: 'var(--fg-muted)', label: '' },
};

// Phase 5.x — Status display labels (DB enum → human-readable)
const STATUS_LABELS: Record<string, string> = {
  draft:            'Draft',
  issued:           'Issued',
  order_fulfilment: 'Boxing',
  production:       'In Production',
  stocked:          'Stocked',
  shipped:          'Shipped',
  delivered:        'Delivered',
  cancelled:        'Cancelled',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

const LANGUAGE_LABELS: Record<string, string> = {
  'EN':    'English',
  'RU':    'Русский',
  'EN-RU': 'English + Русский',
  'EN-AR': 'English + العربية',
  'EN-VI': 'English + Tiếng Việt',
  'EN-ZH': 'English + 中文',
};

function languageLabel(lang: string | null | undefined): string {
  if (!lang) return 'English';
  return LANGUAGE_LABELS[lang] ?? lang;
}

const MISSING = 'MISSING';
function isMissing(value: string | null | undefined): boolean {
  return !value || value === MISSING || value.trim() === '';
}
function formatDate(unixSec?: number | null): string {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toISOString().split('T')[0]!;
}

function formatMoney(minor: number, currency: string): string {
  const factor = ['VND', 'JPY', 'KRW'].includes(currency) ? 1 : 100;
  return (minor / factor).toLocaleString('en-US', {
    minimumFractionDigits: factor === 1 ? 0 : 2,
    maximumFractionDigits: factor === 1 ? 0 : 2,
  });
}

export default function PartnerDetailClient({ slug }: { slug: string }) {
  const [partner, setPartner] = useState<Partner | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [netBalance, setNetBalance] = useState<PartnerNetBalance | null>(null);
  const [agreements, setAgreements] = useState<PartnerAgreement[]>([]);
  const [generatingNda, setGeneratingNda] = useState(false);
  const [ndaError, setNdaError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [partnerRes, contractsRes, opsRes, paysRes, balRes, agrRes] = await Promise.all([
          getPartner(slug),
          getPartnerContracts(slug),
          getOperations({ partner_id: slug }),
          getPayments({ partner_id: slug }),
          getPartnerNetBalance(slug),
          getPartnerAgreements(slug),
        ]);

        if (partnerRes.success && partnerRes.result) {
          setPartner(partnerRes.result);
          setError(null);
        } else {
          setError(partnerRes.errors?.[0]?.message ?? 'Partner not found');
        }

        if (contractsRes.success && contractsRes.result) {
          setContracts(contractsRes.result.contracts);
        }

        if (opsRes.success && opsRes.result) {
          setOperations(opsRes.result.operations);
        }

        if (paysRes.success && paysRes.result) {
          setPayments(paysRes.result.payments);
        }

        if (balRes.success && balRes.result) {
          setNetBalance(balRes.result);
        }

        if (agrRes.success && agrRes.result) {
          setAgreements(agrRes.result.agreements);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, [slug]);

  // Trigger NDA generation via DeepSeek PRO. On success, refresh agreements list
  // (and partner — promotion lead → potential happens server-side on FIRST signed
  // agreement; for 'draft' generated NDA the promotion does NOT trigger yet).
  async function handleGenerateNda() {
    setNdaError(null);
    setGeneratingNda(true);
    try {
      const res = await generatePartnerNda(slug);
      if (res.success && res.result) {
        // Refresh agreements list
        const refreshed = await getPartnerAgreements(slug);
        if (refreshed.success && refreshed.result) {
          setAgreements(refreshed.result.agreements);
        }
        // Open download in new tab
        window.open(res.result.download_url.startsWith('http')
          ? res.result.download_url
          : agreementDownloadUrl(slug, res.result.agreement_id), '_blank');
      } else {
        setNdaError(res.errors?.[0]?.message ?? 'Failed to generate NDA');
      }
    } catch (e) {
      setNdaError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setGeneratingNda(false);
    }
  }

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>;

  if (error || !partner) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Breadcrumb items={[{ label: 'Partners', href: '/partners' }, { label: 'Not found' }]} />
        <div className="p-4 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          {error ?? 'Partner not found'}
        </div>
      </div>
    );
  }

  const isPending = partner.status === 'pending';
  const statusStyle = STATUS_COLORS[partner.status];

  const generalFields = [
    { label: 'Country', value: partner.country },
    { label: 'Type', value: partner.partner_type },
    { label: 'Tax ID', value: partner.tax_id },
    { label: 'Email', value: partner.email },
  ];
  const bankingFields = [
    { label: 'IBAN', value: partner.iban },
    { label: 'SWIFT/BIC', value: partner.swift_bic },
    { label: 'Bank', value: partner.bank_name },
  ];

  return (
    <div className="space-y-8 max-w-6xl">
      <Breadcrumb items={[{ label: 'Partners', href: '/partners' }, { label: partner.trade_name }]} />

      {/* Hero */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <span style={{ fontSize: '14px', fontWeight: 600, padding: '4px 10px', backgroundColor: statusStyle.bg, color: statusStyle.fg, border: `1px solid ${statusStyle.border}`, borderRadius: 'var(--radius-pill)' }}>
            {partner.status}
          </span>
        </div>
        <h1 className="dx-product-name" style={{ fontSize: '40px', color: 'var(--fg-1)', lineHeight: 1.05 }}>
          {partner.trade_name}
        </h1>
        {partner.legal_name && !isMissing(partner.legal_name) && (
          <p className="mt-3" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>{partner.legal_name}</p>
        )}
      </div>

      <div className="dx-ribbon-rule" />

      {isPending && (
        <div className="p-4 flex items-start gap-3" style={{ backgroundColor: 'rgba(199,122,0,0.06)', border: '1px solid rgba(199,122,0,0.25)', borderRadius: 'var(--radius-md)' }}>
          <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--status-warning)' }} />
          <div>
            <div className="mb-1" style={{ color: 'var(--status-warning)', fontSize: '14px', fontWeight: 700 }}>Pending Partner</div>
            <p style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>
              Document generation will be blocked until all required fields are filled in.
            </p>
            {partner.notes && <p className="mt-2" style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-2)' }}>{partner.notes}</p>}
          </div>
        </div>
      )}

      {/* Reference cards (2 columns теперь, без Commercial — переехал в Contracts ниже) */}
      <div className="grid grid-cols-2 gap-5">
        <SectionCard label="General" fields={generalFields}>
          <CopyableField label="Country" value={partner.country} />
          <CopyableField label="Type" value={partner.partner_type} />
          <CopyableField label="Language" value={languageLabel(partner.partner_language)} />
          <CopyableField label="Tax ID" value={partner.tax_id} mono />
          <CopyableField label="Email" value={partner.email} mono />
        </SectionCard>

        <SectionCard label="Banking" fields={bankingFields}>
          <CopyableField label="IBAN" value={partner.iban} mono />
          <CopyableField label="SWIFT/BIC" value={partner.swift_bic} mono />
          <CopyableField label="Bank" value={partner.bank_name} />
        </SectionCard>
      </div>

      {/* NET BALANCE WIDGET */}
      {netBalance && (
        <NetBalance
          usd={netBalance.net_balance_usd}
          currencies={netBalance.currencies_breakdown.reduce((acc, b) => {
            acc[b.currency] = b.balance;
            return acc;
          }, {} as Record<string, number>)}
          fxDate={netBalance.fx_date}
          size="large"
        />
      )}

      {/* AGREEMENTS SECTION (Phase 5.x — NDA / MOU / LOI / Contract docs) */}
      <div className="bg-card p-5" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h2 style={{
              fontFamily: 'var(--font-display)',
              fontSize: '20px',
              fontWeight: 700,
              color: 'var(--fg-1)',
              textTransform: 'uppercase',
              letterSpacing: '0',
            }}>
              Agreements
            </h2>
            <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
              {agreements.length} on file
            </span>
          </div>
          <button
            onClick={handleGenerateNda}
            disabled={generatingNda}
            className="inline-flex items-center gap-2 px-4 py-2"
            style={{
              backgroundColor: generatingNda ? 'var(--paper-sunk)' : 'var(--brand-rot)',
              color: generatingNda ? 'var(--fg-3)' : 'var(--paper)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '14px',
              fontWeight: 600,
              cursor: generatingNda ? 'not-allowed' : 'pointer',
              border: 'none',
            }}
          >
            {generatingNda ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating NDA via DeepSeek...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Generate NDA ({partner.partner_language ?? 'EN'})
              </>
            )}
          </button>
        </div>

        {ndaError && (
          <div className="mb-4 p-3" style={{
            backgroundColor: 'rgba(229,32,44,0.05)',
            border: '1px solid rgba(229,32,44,0.2)',
            color: 'var(--brand-rot)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '14px',
          }}>
            {ndaError}
          </div>
        )}

        {agreements.length === 0 ? (
          <p style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
            No agreements yet. Click <strong>Generate NDA</strong> above to draft a Mutual NDA via DeepSeek.
            A signed agreement will promote this partner from <strong>Lead</strong> to <strong>Potential</strong>.
          </p>
        ) : (
          <table className="w-full" style={{ fontSize: '14px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <Th>Type</Th><Th>Title</Th><Th>Signed</Th><Th>Status</Th><Th>{' '}</Th>
              </tr>
            </thead>
            <tbody>
              {agreements.map((agr) => (
                <tr key={agr.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                  <td className="px-4 py-3" style={{ fontWeight: 700, textTransform: 'uppercase' }}>
                    {agr.agreement_type}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-1)' }}>{agr.title ?? '—'}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-2)' }}>{formatDate(agr.signed_date)}</td>
                  <td className="px-4 py-3">
                    <span className="inline-block" style={{
                      padding: '3px 8px',
                      borderRadius: 'var(--radius-pill)',
                      fontSize: '14px',
                      backgroundColor: agr.status === 'signed' ? 'rgba(46,125,79,0.08)' : 'var(--paper-sunk)',
                      color: agr.status === 'signed' ? 'var(--status-success)' : 'var(--fg-3)',
                      border: `1px solid ${agr.status === 'signed' ? 'rgba(46,125,79,0.3)' : 'var(--border-hairline)'}`,
                    }}>
                      {agr.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {agr.file_r2_key && (
                      <a
                        href={agreementDownloadUrl(slug, agr.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1"
                        style={{ color: 'var(--brand-rot)', fontSize: '14px' }}
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* CONTRACTS SECTION */}
      <SectionListBlock
        label="Contracts"
        count={contracts.length}
        addNewHref={`/partners/${slug}/contracts/new`}
      >
        {contracts.length === 0 ? (
          <EmptyTable message="No contracts yet" />
        ) : (
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <Th>Contract No</Th><Th>Type</Th><Th>Entity</Th><Th>Currency</Th><Th>Signed</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => {
                const ss = CONTRACT_STATUS_COLORS[c.status];
                const isAddendum = c.agreement_type === 'addendum' || c.agreement_type === 'annex';
                return (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                    <td className="px-4 py-3">
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', paddingLeft: isAddendum ? '24px' : '0' }}>
                        {isAddendum && (
                          <span aria-hidden="true" style={{ color: 'var(--fg-muted)', fontSize: '14px', fontWeight: 400 }}>└─</span>
                        )}
                        <Link href={`/partners/${slug}/contracts/${c.id}`} style={{ fontSize: '14px', fontWeight: 700, color: isAddendum ? 'var(--fg-2)' : 'var(--fg-1)', textDecoration: 'underline', textDecorationColor: 'var(--border-hairline)', textUnderlineOffset: '3px' }}>
                          {c.contract_no}
                        </Link>
                      </span>
                    </td>
                    <td className="px-4 py-3" style={{ fontSize: '14px' }}>
                      {c.agreement_type === 'main' || !c.agreement_type ? (
                        <span style={{ color: 'var(--fg-2)', fontWeight: 600 }}>Main</span>
                      ) : c.agreement_type === 'addendum' ? (
                        <span style={{ color: 'var(--fg-3)', fontWeight: 600 }}>Addendum {c.addendum_no ? `№${c.addendum_no}` : ''}</span>
                      ) : c.agreement_type === 'annex' ? (
                        <span style={{ color: 'var(--fg-3)', fontWeight: 600 }}>Annex</span>
                      ) : (
                        <span style={{ color: 'var(--fg-3)', fontWeight: 600 }}>{c.agreement_type.toUpperCase()}</span>
                      )}
                    </td>
                    <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>{c.entity_abbreviation ?? '—'}</td>
                    <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>{c.currency}</td>
                    <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{formatDate(c.signed_date)}</td>
                    <td className="px-4 py-3">
                      <span className="inline-block" style={{ padding: '4px 10px', fontSize: '14px', fontWeight: 600, backgroundColor: ss.bg, color: ss.fg, border: `1px solid ${ss.border}`, borderRadius: 'var(--radius-pill)' }}>
                        {c.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </SectionListBlock>

      {/* OPERATIONS SECTION */}
      <SectionListBlock
        label="Operations"
        count={operations.length}
        addNewHref={`/partners/${slug}/operations/new`}
      >
        {operations.length === 0 ? (
          <EmptyTable message="No operations yet — click [+ Add new] to create draft" />
        ) : (
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <Th>Reference</Th><Th>Date</Th><Th>Type</Th><Th>Contract</Th><Th>Total</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {operations.map((op) => {
                const ps = op.payment_state ?? 'neutral';
                const po = PAYMENT_OVERLAY[ps]!;
                const total = op.total_amount || 0;
                const paid = op.paid_amount ?? 0;
                const pct = total > 0 ? Math.round((paid / total) * 100) : 0;
                return (
                  <tr key={op.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                    <td className="px-4 py-3" style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>
                      <Link
                        href={`/operations/${op.id}`}
                        style={{ color: 'var(--fg-1)', textDecoration: 'underline', textDecorationColor: 'var(--border-hairline)', textUnderlineOffset: '3px' }}
                      >
                        {op.reference ?? op.id}
                      </Link>
                    </td>
                    <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
                      {formatDate(op.operation_date)}
                    </td>
                    <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
                      {op.operation_type}
                    </td>
                    <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
                      {op.contract_no ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-right" style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>
                      {formatMoney(op.total_amount, op.currency)} {op.currency}
                    </td>
                    <td className="px-4 py-3">
                      <div className="inline-flex items-center gap-2" style={{
                        padding: '4px 10px',
                        backgroundColor: po.bg,
                        color: po.fg,
                        borderRadius: 'var(--radius-sm)',
                        fontSize: '14px',
                        fontWeight: 500,
                      }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: po.dot, display: 'inline-block' }} />
                        <span style={{ color: 'var(--fg-1)', fontWeight: 600 }}>{statusLabel(op.status)}</span>
                        {ps !== 'neutral' && (
                          <span style={{ color: po.fg, fontWeight: 500 }}>· {po.label} {pct}%</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </SectionListBlock>

      {/* PAYMENTS SECTION */}
      <SectionListBlock
        label="Payments"
        count={payments.length}
        addNewHref={`/partners/${slug}/payments/new`}
      >
        {payments.length === 0 ? (
          <EmptyTable message="No payments yet — click [+ Add new] to record" />
        ) : (
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <Th>Date</Th><Th>Direction</Th><Th>Type</Th><Th>Operation</Th><Th>Amount</Th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                  <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{formatDate(p.payment_date)}</td>
                  <td className="px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: p.direction === 'incoming' ? 'var(--status-success)' : 'var(--brand-rot)' }}>
                    {p.direction}
                  </td>
                  <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>{p.type}</td>
                  <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
                    {p.operation_id ? (
                      <Link
                        href={`/operations/${p.operation_id}`}
                        style={{ color: 'var(--fg-2)', textDecoration: 'underline', textDecorationColor: 'var(--border-hairline)', textUnderlineOffset: '3px' }}
                      >
                        {p.operation_id.slice(0, 8)}
                      </Link>
                    ) : 'advance'}
                  </td>
                  <td className="px-4 py-3 text-right" style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>
                    {formatMoney(p.amount, p.currency)} {p.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionListBlock>
    </div>
  );
}

function SectionListBlock({
  label, count, addNewHref, addDisabled = false, children,
}: {
  label: string;
  count: number;
  addNewHref: string;
  addDisabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2
          style={{
            fontFamily: 'var(--font-accent-jakarta)',
            fontSize: '24px',
            fontWeight: 800,
            textTransform: 'uppercase',
            color: 'var(--fg-1)',
            lineHeight: 1,
          }}
        >
          {label}{' '}
          <span style={{ color: 'var(--fg-3)', fontWeight: 400 }}>({count})</span>
        </h2>
        {addDisabled ? (
          <button
            disabled
            className="inline-flex items-center gap-2 px-4 py-2"
            style={{
              backgroundColor: 'var(--paper-sunk)',
              color: 'var(--fg-3)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--fs-body-sm)',
              fontWeight: 600,
              cursor: 'not-allowed',
            }}
          >
            <Plus className="h-4 w-4" />
            Add new
          </button>
        ) : (
          <Link
            href={addNewHref}
            className="inline-flex items-center gap-2 px-4 py-2 transition-colors"
            style={{
              backgroundColor: 'var(--brand-rot)',
              color: 'var(--paper)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--fs-body-sm)',
              fontWeight: 600,
            }}
          >
            <Plus className="h-4 w-4" />
            Add new
          </Link>
        )}
      </div>
      <div
        className="bg-card overflow-hidden"
        style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}
      >
        {children}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      className="text-left px-4 py-3"
      style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)' }}
    >
      {children}
    </th>
  );
}

function EmptyTable({ message }: { message: string }) {
  return (
    <div className="text-center py-12" style={{ color: 'var(--fg-3)', fontSize: 'var(--fs-body-sm)' }}>
      {message}
    </div>
  );
}

function CopyableField({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  const missing = !value || value === 'MISSING' || value.trim() === '';
  return (
    <div>
      <dt className="mb-1" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-3)' }}>{label}</dt>
      <dd>
        {missing ? (
          <span style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--status-warning)' }}>⚠ MISSING</span>
        ) : (
          <CopyableValue value={value!} mono={mono} style={{ fontSize: '14px', color: 'var(--fg-1)' }} />
        )}
      </dd>
    </div>
  );
}
