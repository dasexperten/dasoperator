'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, AlertTriangle, Loader2, FileText, Sparkles, X, Trash2 } from 'lucide-react';
import {
  getPartner, getPartnerContracts, getOperations, getPayments, getPartnerNetBalance,
  generatePartnerNda, agreementDownloadUrl,
  getContractFileUrl,
  deleteOperation, updateOperationStatus,
  getPartnerBankAccounts,
  getPartnerTimeline,
  type TimelineEvent,
  type Partner, type Contract, type Operation, type Payment, type PartnerNetBalance,
  type PartnerBankAccount,
} from '@/lib/api';
import { CopyableValue, SectionCard } from '@/components/ui/copyable';
import { ContractRef, isPlaceholderContractNo } from '@/components/ui/contract-ref';
import NetBalance from '@/components/ui/net-balance';
import Breadcrumb from '@/components/layout/breadcrumb';
import { agreementTypeLabel } from '@/lib/agreement-types';

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

// Delivery status — physical fulfilment, independent of document/payment state.
const DELIVERY_OVERLAY: Record<string, { icon: string; color: string; label: string }> = {
  delivered: { icon: '✓', color: 'var(--success, #1a7f3a)',  label: 'Delivered' },
  pending:   { icon: '⏱', color: 'var(--warning, #b07900)',  label: 'Pending'   },
  disputed:  { icon: '!', color: 'var(--danger,  #A82029)',  label: 'Disputed'  },
  refunded:  { icon: '↩', color: 'var(--fg-3,    #6b6964)',  label: 'Refunded'  },
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
  production:       'Production',
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

const DOC_MODE_LABELS: Record<string, string> = {
  'EN':        'English only',
  'RU':        'Русский only (legacy)',
  'BILINGUAL': 'English + national language (bilingual)',
};

function docModeLabel(mode: string | null | undefined): string {
  if (!mode) return 'Issuer default';
  return DOC_MODE_LABELS[mode] ?? mode;
}

const NATIONAL_LANGUAGE_LABELS: Record<string, string> = {
  'EN': 'English',          'RU': 'Русский',            'KA': 'ქართული',
  'ZH': '中文',               'VI': 'Tiếng Việt',         'AM': 'Հայերեն',
  'UK': 'Українська',       'DE': 'Deutsch',            'TR': 'Türkçe',
  'UZ': "O'zbek",           'KK': 'Қазақша',            'TH': 'ไทย',
  'ID': 'Bahasa Indonesia', 'MS': 'Bahasa Melayu',      'HI': 'हिन्दी',
  'AR': 'العربية',          'FR': 'Français',           'ES': 'Español',
  'PT': 'Português',
};

function nationalLanguageLabel(code: string | null | undefined): string {
  if (!code) return '';
  return NATIONAL_LANGUAGE_LABELS[code] ?? code;
}

const MISSING = 'MISSING';
function isMissing(value: string | null | undefined): boolean {
  return !value || value === MISSING || value.trim() === '';
}
function formatDate(unixSec?: number | null): string {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toISOString().split('T')[0]!;
}

function formatMoney(amount: number, currency: string): string {
  const isZeroDecimal = ['VND', 'JPY', 'KRW'].includes(currency);
  const fractionDigits = isZeroDecimal ? 0 : 2;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

// Convert canonical partner kind to a human-readable label.
const KIND_LABEL: Record<string, string> = {
  buyer: 'Buyer (клиент)',
  manufacturer: 'Manufacturer (фабрика)',
  service_provider: 'Service Provider',
  '3pl': '3PL (склад)',
  shipper: 'Shipper (логистика)',
  other: 'Other',
};

export default function PartnerDetailClient({ slug }: { slug: string }) {
  const [partner, setPartner] = useState<Partner | null>(null);
  const [bankAccounts, setBankAccounts] = useState<PartnerBankAccount[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [netBalance, setNetBalance] = useState<PartnerNetBalance | null>(null);
  const [generatingNda, setGeneratingNda] = useState(false);
  const [ndaError, setNdaError] = useState<string | null>(null);
  const [opBusyId, setOpBusyId] = useState<string | null>(null);
  const [opActionMsg, setOpActionMsg] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState<boolean>(false);

  async function handleOpCancel(op: Operation) {
    const label = op.reference ?? op.id;
    if (!confirm(`Cancel operation ${label}?\n\nThis will move it to status 'cancelled'. If stock has already moved, a return movement will be written. This action cannot be undone.`)) return;
    setOpBusyId(op.id);
    setOpActionMsg(null);
    try {
      const res = await updateOperationStatus(op.id, 'cancelled');
      if (res.success) {
        setOperations((prev) => prev.map((o) => o.id === op.id ? { ...o, status: 'cancelled', payment_state: 'neutral' } : o));
        setOpActionMsg(`${label} cancelled`);
      } else {
        setOpActionMsg(`Failed to cancel ${label}: ${res.errors?.[0]?.message ?? 'unknown error'}`);
      }
    } catch (e) {
      setOpActionMsg(`Network error cancelling ${label}`);
    } finally {
      setOpBusyId(null);
    }
  }

  async function handleOpDelete(op: Operation) {
    const label = op.reference ?? op.id;
    if (!confirm(`Permanently DELETE draft operation ${label}?\n\nThis removes it entirely. Only possible for drafts with no documents, payments, or stock movements. This cannot be undone.`)) return;
    setOpBusyId(op.id);
    setOpActionMsg(null);
    try {
      const res = await deleteOperation(op.id);
      if (res.success) {
        setOperations((prev) => prev.filter((o) => o.id !== op.id));
        setOpActionMsg(`${label} deleted`);
      } else {
        setOpActionMsg(`Failed to delete ${label}: ${res.errors?.[0]?.message ?? 'unknown error'}`);
      }
    } catch (e) {
      setOpActionMsg(`Network error deleting ${label}`);
    } finally {
      setOpBusyId(null);
    }
  }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Correspondence lives in the R2 archive, not in D1, so it loads on its own
  // and never delays the card. A partner card that waits for mail to render
  // banking details is a worse card.
  const [letters, setLetters] = useState<TimelineEvent[]>([]);
  const [lettersLoaded, setLettersLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await getPartnerTimeline(slug, 25);
        if (alive && r.success) setLetters((r.result?.events || []).filter((e) => e.kind === 'email'));
      } catch { /* no correspondence is a state, not a failure */ }
      finally { if (alive) setLettersLoaded(true); }
    })();
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [partnerRes, contractsRes, opsRes, paysRes, balRes, bankAccountsRes] = await Promise.all([
          getPartner(slug),
          getPartnerContracts(slug),
          getOperations({ partner_id: slug, include_cancelled: showCancelled, compact: true }),
          getPayments({ partner_id: slug }),
          getPartnerNetBalance(slug),
          getPartnerBankAccounts(slug),
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

        if (bankAccountsRes.success && bankAccountsRes.result) {
          setBankAccounts(bankAccountsRes.result.accounts);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, [slug, showCancelled]);

  // Trigger NDA generation via DeepSeek PRO. On success, refresh contracts list
  // (NDA now lives in `contracts` table — see Phase 8.x agreements unification).
  // For 'draft' generated NDA the promotion does NOT trigger yet — only on signed.
  async function handleGenerateNda() {
    setNdaError(null);
    setGeneratingNda(true);
    try {
      const res = await generatePartnerNda(slug);
      if (res.success && res.result) {
        // Refresh contracts (NDA appears here now, since agreements live in contracts)
        const refreshed = await getPartnerContracts(slug);
        if (refreshed.success && refreshed.result) {
          setContracts(refreshed.result.contracts);
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

  // Price list on the counterparty card. The column and the API carried it all
  // along; neither the card nor the edit form ever showed it, so most buyers sat
  // with no list and an operation could not resolve a price for them.
  // Owner 2026-08-13.
  const PRICE_LIST_LABEL: Record<string, string> = {
    distr_usd: 'International (USD)',
    distr_rub: 'Russia Distr (RUB)',
    distr_base_usd: 'Distributor base (USD)',
    dasex_group: 'Dasex (USD)',
    wb_ru: 'Russia RSP (RUB)',
    export_usd: 'Purchasing (USD)',
    purchase_cny: 'Purchasing (CNY)',
    cogs_ru: 'COGS-RU',
  };
  const priceListName =
    (partner as { price_type_code?: string | null }).price_type_code ??
    (partner.price_type_id ? PRICE_LIST_LABEL[partner.price_type_id] ?? partner.price_type_id : null);

  const isPending = partner.status === 'pending';
  const statusStyle = STATUS_COLORS[partner.status];

  const generalFields = [
    { label: 'Country', value: partner.country },
    { label: 'Type', value: KIND_LABEL[partner.kind ?? ''] ?? partner.kind ?? partner.partner_type },
    { label: 'Price list', value: priceListName },
    { label: 'Currency', value: partner.currency },
    { label: 'Tax ID', value: partner.tax_id },
    { label: 'Email', value: partner.email },
    { label: 'Contact person', value: partner.contact_person },
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
        <div className="flex items-center justify-between gap-3 mb-3">
          <span style={{ fontSize: '14px', fontWeight: 600, padding: '4px 10px', backgroundColor: statusStyle.bg, color: statusStyle.fg, border: `1px solid ${statusStyle.border}`, borderRadius: 'var(--radius-pill)' }}>
            {partner.status}
          </span>
          <Link
            href={`/partners/${slug}/edit`}
            className="inline-flex items-center gap-2 px-3 py-2"
            style={{
              fontSize: '14px',
              fontWeight: 600,
              backgroundColor: 'var(--paper-1)',
              color: 'var(--fg-1)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              textDecoration: 'none',
            }}
          >
            Edit Partner
          </Link>
        </div>
        <h1 className="dx-product-name" style={{ fontSize: 'clamp(26px, 7vw, 40px)', color: 'var(--fg-1)', lineHeight: 1.05 }}>
          {partner.trade_name}
        </h1>
        {partner.legal_name && !isMissing(partner.legal_name) && (
          <p className="mt-3" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>{partner.legal_name}</p>
        )}
        {partner.abbreviation && (
          <div className="mt-2 inline-flex items-center gap-2 px-2 py-1" style={{
            fontSize: '14px',
            fontWeight: 700,
            letterSpacing: 0,
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-xs)',
            color: 'var(--fg-2)',
          }}>
            <span style={{ color: 'var(--fg-3)', fontWeight: 600 }}>Code:</span> {partner.abbreviation}
          </div>
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <SectionCard label="General" fields={generalFields}>
          <CopyableField label="Country" value={partner.country} />
          <CopyableField label="Type" value={KIND_LABEL[partner.kind ?? ""] ?? partner.kind ?? partner.partner_type} />
          <CopyableField label="Language" value={languageLabel(partner.partner_language)} />
          <CopyableField label="Price list" value={priceListName} />
          <CopyableField label="Currency" value={partner.currency} mono />
          <CopyableField label="Document mode" value={docModeLabel(partner.preferred_invoice_language)} />
          <CopyableField label="National language" value={nationalLanguageLabel((partner as { partner_local_language?: string | null }).partner_local_language)} />
          <CopyableField label="Tax ID" value={partner.tax_id} mono />
          <CopyableField label="Email" value={partner.email} mono />
          {partner.contact_person && <CopyableField label="Contact person" value={partner.contact_person} />}
        </SectionCard>

        <SectionCard label="Banking" fields={bankAccounts.length > 0
          ? bankAccounts.flatMap((a) => {
              const out = [
                { label: `${a.account_label} — Account`, value: a.account_number },
                { label: `${a.account_label} — Bank`, value: a.bank_name },
              ];
              // For Russian accounts (BIK), don't show SWIFT as MISSING — it's not used.
              if (a.bik_code) {
                out.push({ label: `${a.account_label} — BIK`, value: a.bik_code });
              } else if (a.swift_bic !== undefined && a.swift_bic !== null) {
                out.push({ label: `${a.account_label} — SWIFT`, value: a.swift_bic });
              }
              return out;
            })
          : bankingFields}>
          {bankAccounts.length > 0 ? (
            <div className="space-y-5">
              {bankAccounts.map((a, idx) => {
                const routing = a.routing_buyer_entities
                  ? a.routing_buyer_entities.split(',').map((s) => s.trim().toUpperCase()).join(' / ')
                  : null;
                return (
                  <div key={a.id} style={{
                    paddingBottom: idx < bankAccounts.length - 1 ? '20px' : 0,
                    borderBottom: idx < bankAccounts.length - 1 ? '0.5px solid var(--border-hairline)' : 'none',
                  }}>
                    <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: '10px' }}>
                      <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>
                        {a.account_label}
                      </span>
                      {a.currency && (
                        <span style={{ fontSize: '12px', padding: '1px 7px', backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-2)', borderRadius: 'var(--radius-pill)', fontWeight: 600 }}>
                          {a.currency}
                        </span>
                      )}
                      {a.is_default === 1 && (
                        <span style={{ fontSize: '12px', padding: '1px 7px', backgroundColor: 'rgba(46,125,79,0.10)', color: 'var(--status-success)', borderRadius: 'var(--radius-pill)', fontWeight: 600 }}>
                          DEFAULT
                        </span>
                      )}
                      {routing && (
                        <span style={{ fontSize: '12px', padding: '1px 7px', backgroundColor: 'rgba(229,32,44,0.08)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-pill)', fontWeight: 600 }} title="Routes to this account when the buyer entity is one of these">
                          → {routing}
                        </span>
                      )}
                    </div>
                    <CopyableField label="Account" value={a.account_number} mono />
                    {a.swift_bic && <CopyableField label="SWIFT/BIC" value={a.swift_bic} mono />}
                    {a.bik_code && <CopyableField label="BIK (РФ)" value={a.bik_code} mono />}
                    {a.cnaps_code && <CopyableField label="CNAPS" value={a.cnaps_code} mono />}
                    {a.iban && <CopyableField label="IBAN" value={a.iban} mono />}
                    <CopyableField label="Bank" value={a.bank_name} />
                    {a.bank_address && <CopyableField label="Bank address" value={a.bank_address} />}
                    {a.correspondent_bank_name && (
                      <CopyableField label="Correspondent bank" value={a.correspondent_bank_name} />
                    )}
                    {a.correspondent_swift && (
                      <CopyableField label="Correspondent SWIFT" value={a.correspondent_swift} mono />
                    )}
                    {a.notes && (
                      <p style={{ fontSize: '13px', color: 'var(--fg-3)', marginTop: '8px', fontStyle: 'italic' }}>
                        {a.notes}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <>
              <CopyableField label="IBAN" value={partner.iban} mono />
              <CopyableField label="SWIFT/BIC" value={partner.swift_bic} mono />
              <CopyableField label="Bank" value={partner.bank_name} />
            </>
          )}
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

      {/* AGREEMENTS SECTION (Phase 8.x — unified contracts table)
          Holds business contracts (Main / Addendum / Annex / SLA) AND legal docs
          (NDA / MoU / LoI / Other) in a single source of truth. */}
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
              {contracts.length} on file
            </span>
          </div>
          <div className="flex items-center gap-2">
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
            <Link
              href={`/partners/${slug}/contracts/new`}
              className="inline-flex items-center gap-2 px-4 py-2"
              style={{
                backgroundColor: 'var(--paper)',
                color: 'var(--fg-1)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '14px',
                fontWeight: 600,
              }}
            >
              <Plus className="h-4 w-4" />
              Add new
            </Link>
          </div>
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

        {contracts.length === 0 ? (
          <p style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
            No agreements yet. Click <strong>Generate NDA</strong> to draft a Mutual NDA via DeepSeek,
            or <strong>Add new</strong> to record an existing contract or addendum.
            A signed agreement promotes this partner from <strong>Lead</strong> to <strong>Potential</strong>.
          </p>
        ) : (
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <Th>Contract No</Th><Th>Type</Th><Th>Entity</Th><Th>Currency</Th><Th>Signed</Th><Th>File</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => {
                const ss = CONTRACT_STATUS_COLORS[c.status];
                const isAddendum = c.agreement_type === 'addendum' || c.agreement_type === 'annex';
                return (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                    <td className="px-4 py-3">
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', paddingLeft: isAddendum ? '24px' : '0' }}>
                        {isAddendum && (
                          <span aria-hidden="true" style={{ color: 'var(--fg-muted)', fontSize: '14px', fontWeight: 400 }}>└─</span>
                        )}
                        <Link href={`/partners/${slug}/contracts/${c.id}`} style={{ fontSize: '14px', fontWeight: 700, color: isAddendum ? 'var(--fg-2)' : 'var(--fg-1)', textDecoration: 'underline', textDecorationColor: 'var(--border-hairline)', textUnderlineOffset: '3px' }}>
                          {isPlaceholderContractNo(c.contract_no) ? (
                            <span style={{ color: 'var(--fg-3)', fontStyle: 'italic' }}>—</span>
                          ) : c.contract_no}
                        </Link>
                        {isPlaceholderContractNo(c.contract_no) && (
                          <span
                            className="inline-flex items-center gap-1.5"
                            style={{
                              padding: '2px 8px',
                              fontSize: '12px',
                              fontWeight: 600,
                              color: 'var(--fg-3)',
                              backgroundColor: 'var(--paper-sunk)',
                              border: '1px dashed var(--border-hairline)',
                              borderRadius: 'var(--radius-pill)',
                            }}
                            title="Technical placeholder — replace when a real contract is signed"
                          >
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: 'var(--fg-muted)', display: 'inline-block' }} />
                            Placeholder
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3" style={{ fontSize: '14px' }}>
                      {c.agreement_type === 'addendum' ? (
                        <span style={{ color: 'var(--fg-3)', fontWeight: 600 }}>Addendum {c.addendum_no ? `№${c.addendum_no}` : ''}</span>
                      ) : (
                        <span style={{ color: c.agreement_type === 'main' || !c.agreement_type ? 'var(--fg-2)' : 'var(--fg-3)', fontWeight: 600 }}>
                          {agreementTypeLabel(c.agreement_type)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>{c.entity_abbreviation ?? '—'}</td>
                    <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>{c.currency}</td>
                    <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{formatDate(c.signed_date)}</td>
                    <td className="px-4 py-3">
                      {c.contract_file_key ? (
                        <a
                          href={getContractFileUrl(c.id)}
                          target="_blank"
                          rel="noreferrer"
                          title={c.contract_file_key.split('/').pop() || 'View PDF'}
                          className="inline-flex items-center gap-1.5"
                          style={{
                            padding: '3px 8px',
                            fontSize: '14px',
                            fontWeight: 600,
                            color: 'var(--status-success)',
                            backgroundColor: 'rgba(46,125,79,0.08)',
                            border: '1px solid rgba(46,125,79,0.3)',
                            borderRadius: 'var(--radius-pill)',
                            textDecoration: 'none',
                          }}
                        >
                          <FileText size={14} /> PDF
                        </a>
                      ) : (
                        <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>—</span>
                      )}
                    </td>
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
      </div>

      {/* OPERATIONS SECTION */}
      <SectionListBlock
        label="Operations"
        count={operations.length}
        addNewHref={`/partners/${slug}/operations/new`}
      >
        <div className="px-4 py-2 flex justify-end" style={{ borderBottom: '1px solid var(--border-hairline)' }}>
          <label className="inline-flex items-center gap-2" style={{ fontSize: '14px', color: 'var(--fg-2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
            Show cancelled
          </label>
        </div>
        {operations.length === 0 ? (
          <EmptyTable message="No operations yet — click [+ Add new] to create draft" />
        ) : (
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <Th>Reference</Th><Th>Date</Th><Th>Type</Th><Th>Contract</Th><Th>Total</Th><Th>Status</Th><Th>Actions</Th>
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
                      <ContractRef contractNo={op.contract_no} />
                    </td>
                    <td className="px-4 py-3 text-right" style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>
                      {formatMoney(op.total_amount, op.currency)} {op.currency}
                    </td>
                    <td className="px-4 py-3">
                      <div className="inline-flex items-center gap-2">
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
                        </div>
                        {(() => {
                          const ds = op.delivery_status ?? 'delivered';
                          const dv = DELIVERY_OVERLAY[ds]!;
                          return (
                            <span
                              title={`Delivery: ${dv.label}`}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: '20px',
                                height: '20px',
                                borderRadius: '50%',
                                border: `1px solid ${dv.color}`,
                                color: dv.color,
                                fontSize: '12px',
                                fontWeight: 700,
                                lineHeight: 1,
                              }}
                            >
                              {dv.icon}
                            </span>
                          );
                        })()}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        {op.status === 'draft' && (
                          <button
                            onClick={() => handleOpDelete(op)}
                            disabled={opBusyId === op.id}
                            title="Delete (draft only — permanent)"
                            style={{
                              fontSize: '14px', fontWeight: 600,
                              padding: '4px 10px',
                              border: '1px solid rgba(229,32,44,0.3)',
                              borderRadius: 'var(--radius-sm)',
                              color: '#A82029',
                              backgroundColor: opBusyId === op.id ? 'var(--paper-sunk)' : 'transparent',
                              cursor: opBusyId === op.id ? 'wait' : 'pointer',
                              display: 'inline-flex', alignItems: 'center', gap: '4px',
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                          </button>
                        )}
                        {op.status !== 'draft' && op.status !== 'cancelled' && op.status !== 'delivered' && (
                          <button
                            onClick={() => handleOpCancel(op)}
                            disabled={opBusyId === op.id}
                            title="Cancel operation (reverses stock if shipped)"
                            style={{
                              fontSize: '14px', fontWeight: 600,
                              padding: '4px 10px',
                              border: '1px solid var(--border-hairline)',
                              borderRadius: 'var(--radius-sm)',
                              color: 'var(--fg-2)',
                              backgroundColor: opBusyId === op.id ? 'var(--paper-sunk)' : 'transparent',
                              cursor: opBusyId === op.id ? 'wait' : 'pointer',
                              display: 'inline-flex', alignItems: 'center', gap: '4px',
                            }}
                          >
                            <X className="h-3.5 w-3.5" />
                            Cancel
                          </button>
                        )}
                        {(op.status === 'cancelled' || op.status === 'delivered') && (
                          <span style={{ fontSize: '14px', color: 'var(--fg-muted)' }}>—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {opActionMsg && (
          <div className="px-4 py-3 mt-3" style={{
            fontSize: '14px',
            color: 'var(--fg-1)',
            backgroundColor: 'rgba(46,125,79,0.08)',
            border: '1px solid rgba(46,125,79,0.2)',
            borderRadius: 'var(--radius-sm)',
          }}>
            {opActionMsg}
          </div>
        )}
      </SectionListBlock>

      {/* CORRESPONDENCE SECTION
          Owner 2026-08-03: the card knew the money and the shipments and not a
          word of what was actually said. The summary line is computed from the
          letters themselves — no model, no guessing: who spoke last, how long
          ago, and whether the ball is on our side. That single line answers
          "what is happening with this partner" faster than any list. */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 style={{
            fontFamily: 'var(--font-accent-jakarta)', fontSize: '24px', fontWeight: 800,
            textTransform: 'uppercase', color: 'var(--fg-1)', lineHeight: 1,
          }}>Correspondence <span style={{ color: 'var(--fg-3)' }}>{letters.length}</span></h2>
          <Link href="/emailer" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>Открыть почту →</Link>
        </div>

        <div style={{
          border: '1px solid var(--border-hairline)', borderRadius: '8px',
          backgroundColor: 'var(--paper)', overflow: 'hidden',
        }}>
          {!lettersLoaded ? (
            <EmptyTable message="Загружаю переписку…" />
          ) : letters.length === 0 ? (
            <EmptyTable message="Писем нет — либо переписки не было, либо письма ещё не привязаны к этому контрагенту" />
          ) : (
            <>
              <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border-hairline)', fontSize: '14px', color: 'var(--fg-2)' }}>
                {correspondenceSummary(letters)}
              </div>
              <table className="w-full">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                    <Th>Направление</Th><Th>Тема</Th><Th>Дата</Th>
                  </tr>
                </thead>
                <tbody>
                  {letters.slice(0, 15).map((l, i) => (
                    <tr key={`${l.at}-${i}`} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                      <td className="px-4 py-3" style={{ fontSize: '14px', whiteSpace: 'nowrap', color: l.direction === 'sent' ? 'var(--brand-rot)' : 'var(--status-success)' }}>
                        {l.direction === 'sent' ? '↑ мы' : '↓ они'}
                      </td>
                      <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-1)' }}>{l.title}</td>
                      <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>
                        {new Date(l.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

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

// Plain arithmetic over the letters, deliberately not an LLM summary: this line
// must be true every time it renders, and a model that is right nine times out
// of ten is the wrong tool for a line people will trust without checking.
function correspondenceSummary(letters: TimelineEvent[]): string {
  if (letters.length === 0) return '';
  const sorted = letters.slice().sort((a, b) => b.at - a.at);
  const last = sorted[0]!;
  const days = Math.floor((Date.now() - last.at) / 86400000);
  const when = days === 0 ? 'сегодня' : days === 1 ? 'вчера' : `${days} дн. назад`;
  const sent = letters.filter((l) => l.direction === 'sent').length;

  if (last.direction === 'received') {
    return `Последнее письмо ${when} — от них. Ответ за нами. Всего писем ${letters.length}, наших ${sent}.`;
  }
  return `Последнее письмо ${when} — наше. Ждём ответа. Всего писем ${letters.length}, наших ${sent}.`;
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
