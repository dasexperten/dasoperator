'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Upload, FileText, Eye, Replace, Trash2, Pencil, X, Check } from 'lucide-react';
import {
  getContract, getPartner, type Contract, type Partner,
  getContractFileUrl, uploadContractFile, deleteContractFile,
  patchContract, type PatchContractBody, type AgreementType,
} from '@/lib/api';
import { CopyableValue, SectionCard } from '@/components/ui/copyable';
import Breadcrumb from '@/components/layout/breadcrumb';
import { AGREEMENT_TYPE_LABELS, AGREEMENT_TYPE_ORDER, agreementTypeLabel } from '@/lib/agreement-types';

const STATUS_COLORS: Record<Contract['status'], { bg: string; fg: string; border: string }> = {
  active:    { bg: 'rgba(46,125,79,0.08)',  fg: 'var(--status-success)', border: 'rgba(46,125,79,0.3)' },
  draft:     { bg: 'rgba(199,122,0,0.08)',  fg: 'var(--status-warning)', border: 'rgba(199,122,0,0.3)' },
  expired:   { bg: 'var(--paper-sunk)',     fg: 'var(--fg-3)',           border: 'var(--border-hairline)' },
  cancelled: { bg: 'rgba(229,32,44,0.08)',  fg: 'var(--brand-rot)',      border: 'rgba(229,32,44,0.3)' },
};

function formatDate(unix?: number | null): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toISOString().split('T')[0]!;
}

export default function ContractDetailClient({ partnerSlug, contractId }: { partnerSlug: string; contractId: string }) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [partner, setPartner] = useState<Partner | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [cRes, pRes] = await Promise.all([
          getContract(contractId),
          getPartner(partnerSlug),
        ]);
        if (cRes.success && cRes.result) setContract(cRes.result);
        else setError(cRes.errors[0]?.message ?? 'Contract not found');
        if (pRes.success && pRes.result) setPartner(pRes.result);
      } catch (e) { setError(e instanceof Error ? e.message : 'Network error'); }
      finally { setLoading(false); }
    };
    fetchData();
  }, [contractId, partnerSlug]);

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>;

  if (error || !contract) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Breadcrumb items={[
          { label: 'Partners', href: '/partners' },
          { label: partner?.trade_name ?? partnerSlug, href: `/partners/${partnerSlug}` },
          { label: 'Contract not found' },
        ]} />
        <div className="p-4 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          {error ?? 'Contract not found'}
        </div>
      </div>
    );
  }

  const statusStyle = STATUS_COLORS[contract.status];
  const partyFields = [
    { label: 'Our Entity', value: contract.entity_abbreviation },
    { label: 'Partner', value: contract.partner_trade_name },
    { label: 'Currency', value: contract.currency },
  ];
  const termsFields = [
    { label: 'Signed', value: formatDate(contract.signed_date) },
    { label: 'Expires', value: formatDate(contract.expiry_date) },
    { label: 'Incoterms', value: contract.incoterms },
  ];
  const typeLabel = agreementTypeLabel(contract.agreement_type);

  return (
    <div className="space-y-8 max-w-4xl">
      <Breadcrumb items={[
        { label: 'Partners', href: '/partners' },
        { label: partner?.trade_name ?? partnerSlug, href: `/partners/${partnerSlug}` },
        { label: contract.contract_no },
      ]} />

      {editing ? (
        <EditContractForm
          contract={contract}
          onCancel={() => setEditing(false)}
          onSaved={(updated) => {
            setContract(updated);
            setEditing(false);
          }}
        />
      ) : (
        <div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-3">
                <span style={{ fontSize: '14px', padding: '3px 8px', backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--fg-2)' }}>{contract.id}</span>
                <span style={{ fontSize: '14px', padding: '3px 8px', backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-pill)', color: 'var(--fg-2)', fontWeight: 600, textTransform: 'uppercase' }}>{typeLabel}</span>
                <span className="inline-block" style={{ padding: '3px 8px', fontSize: '14px', backgroundColor: statusStyle.bg, color: statusStyle.fg, border: `1px solid ${statusStyle.border}`, borderRadius: 'var(--radius-pill)' }}>{contract.status}</span>
              </div>
              <h1 style={{ fontSize: '36px', color: 'var(--fg-1)', lineHeight: 1.1 }}>{contract.contract_no}</h1>
              <p className="mt-3" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
                {contract.entity_abbreviation} ↔ {contract.partner_trade_name} <span>({contract.currency})</span>
              </p>
            </div>
            <button
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-2 px-4 py-2"
              style={{
                backgroundColor: 'var(--paper)',
                color: 'var(--fg-1)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <Pencil className="h-4 w-4" />
              Edit
            </button>
          </div>
        </div>
      )}

      <div className="dx-ribbon-rule" />

      <div className="grid grid-cols-2 gap-5">
        <SectionCard label="Parties" fields={partyFields}>
          <CopyableField label="Our Entity" value={contract.entity_abbreviation} mono />
          <CopyableField label="Partner" value={contract.partner_trade_name} />
          <CopyableField label="Currency" value={contract.currency} mono />
        </SectionCard>
        <SectionCard label="Dates & Terms" fields={termsFields}>
          <CopyableField label="Signed" value={formatDate(contract.signed_date)} mono />
          <CopyableField label="Expires" value={formatDate(contract.expiry_date)} mono />
          <CopyableField label="Incoterms" value={contract.incoterms ?? '—'} />
        </SectionCard>
      </div>

      {(contract.our_company_id === 'dee' || contract.partner_id === 'dee_partner') && (
        <div
          className="p-5"
          style={{
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <div
            className="mb-3"
            style={{
              fontSize: '14px',
              fontWeight: 700,
              color: 'var(--fg-1)',
              textTransform: 'uppercase',
              letterSpacing: 0,
            }}
          >
            Russian currency control (УНК)
          </div>
          <div className="grid grid-cols-2 gap-5">
            <CopyableField label="УНК (Unique Contract Number)" value={contract.unk_reference ?? '—'} mono />
            <CopyableField label="Valid Until" value={formatDate(contract.unk_valid_until)} mono />
          </div>
        </div>
      )}

      {contract.notes && (
        <div className="p-4" style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
          <div className="mb-2" style={{ fontSize: '14px' }}>Notes</div>
          <p style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>{contract.notes}</p>
        </div>
      )}

      <ContractFileSection contract={contract} onChange={(updated) => setContract(updated)} />
    </div>
  );
}

// =============================================================================
// Inline edit form for contract details — Phase 8.x
// Replaces the hero card with a tight grid of editable fields. Saves via PATCH
// /api/contracts/:id and folds back into view mode on success.
// =============================================================================
function EditContractForm({
  contract,
  onCancel,
  onSaved,
}: {
  contract: Contract;
  onCancel: () => void;
  onSaved: (next: Contract) => void;
}) {
  const [contractNo, setContractNo] = useState(contract.contract_no);
  const [agreementType, setAgreementType] = useState<AgreementType>(
    (contract.agreement_type ?? 'main') as AgreementType
  );
  const [signedDate, setSignedDate] = useState(
    contract.signed_date ? new Date(contract.signed_date * 1000).toISOString().slice(0, 10) : ''
  );
  const [expiryDate, setExpiryDate] = useState(
    contract.expiry_date ? new Date(contract.expiry_date * 1000).toISOString().slice(0, 10) : ''
  );
  const [status, setStatus] = useState<Contract['status']>(contract.status);
  const [currency, setCurrency] = useState(contract.currency);
  const [incoterms, setIncoterms] = useState(contract.incoterms ?? '');
  const [vatRate, setVatRate] = useState<0 | 5 | 20>((contract.vat_rate ?? 0) as 0 | 5 | 20);
  const [notes, setNotes] = useState(contract.notes ?? '');
  const [unkReference, setUnkReference] = useState(contract.unk_reference ?? '');
  const [unkValidUntil, setUnkValidUntil] = useState(
    contract.unk_valid_until ? new Date(contract.unk_valid_until * 1000).toISOString().slice(0, 10) : ''
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isRussianEntity = contract.our_company_id === 'dee' || contract.partner_id === 'dee_partner';

  function buildPatch(): PatchContractBody {
    const p: PatchContractBody = {};
    if (contractNo !== contract.contract_no) p.contract_no = contractNo;
    if (agreementType !== (contract.agreement_type ?? 'main')) p.agreement_type = agreementType;
    const newSigned = signedDate ? Math.floor(new Date(signedDate + 'T00:00:00Z').getTime() / 1000) : null;
    if (newSigned !== (contract.signed_date ?? null)) p.signed_date = newSigned;
    const newExpiry = expiryDate ? Math.floor(new Date(expiryDate + 'T00:00:00Z').getTime() / 1000) : null;
    if (newExpiry !== (contract.expiry_date ?? null)) p.expiry_date = newExpiry;
    if (status !== contract.status) p.status = status;
    if (currency !== contract.currency) p.currency = currency;
    const newIncoterms = incoterms.trim() || null;
    if (newIncoterms !== (contract.incoterms ?? null)) p.incoterms = newIncoterms;
    if (vatRate !== (contract.vat_rate ?? 0)) p.vat_rate = vatRate;
    const newNotes = notes.trim() || null;
    if (newNotes !== (contract.notes ?? null)) p.notes = newNotes;
    // Russian currency-control fields — only patch when DEE
    if (isRussianEntity) {
      const newUnkRef = unkReference.trim() || null;
      if (newUnkRef !== (contract.unk_reference ?? null)) p.unk_reference = newUnkRef;
      const newUnkValidUntil = unkValidUntil
        ? Math.floor(new Date(unkValidUntil + 'T00:00:00Z').getTime() / 1000)
        : null;
      if (newUnkValidUntil !== (contract.unk_valid_until ?? null)) p.unk_valid_until = newUnkValidUntil;
    }
    return p;
  }

  async function handleSave() {
    setErr(null);
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      await patchContract(contract.id, patch);
      // Refetch contract to get JOINs (entity_abbreviation, partner_trade_name)
      const refreshed = await getContract(contract.id);
      if (refreshed.success && refreshed.result) {
        onSaved(refreshed.result);
      } else {
        setErr(refreshed.errors[0]?.message ?? 'Failed to refresh contract after save');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-5" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--paper)' }}>
      <div className="flex items-center justify-between mb-4">
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '20px', fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase', letterSpacing: '0' }}>
          Edit Contract
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2"
            style={{ backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-2)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer' }}
          >
            <X className="h-4 w-4" />
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2"
            style={{ backgroundColor: busy ? 'var(--paper-sunk)' : 'var(--brand-rot)', color: busy ? 'var(--fg-3)' : 'var(--paper)', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer' }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Save
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-4 p-3" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)', fontSize: '14px' }}>
          {err}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <FormField label="Contract No">
          <input
            type="text"
            value={contractNo}
            onChange={(e) => setContractNo(e.target.value)}
            disabled={busy}
            style={inputStyle}
          />
        </FormField>
        <FormField label="Type">
          <select
            value={agreementType}
            onChange={(e) => setAgreementType(e.target.value as AgreementType)}
            disabled={busy}
            style={inputStyle}
          >
            {AGREEMENT_TYPE_ORDER.map((t) => (
              <option key={t} value={t}>{AGREEMENT_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Signed Date">
          <input
            type="date"
            value={signedDate}
            onChange={(e) => setSignedDate(e.target.value)}
            disabled={busy}
            style={inputStyle}
          />
        </FormField>
        <FormField label="Expiry Date">
          <input
            type="date"
            value={expiryDate}
            onChange={(e) => setExpiryDate(e.target.value)}
            disabled={busy}
            style={inputStyle}
          />
        </FormField>
        <FormField label="Status">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as Contract['status'])}
            disabled={busy}
            style={inputStyle}
          >
            <option value="draft">draft</option>
            <option value="active">active</option>
            <option value="expired">expired</option>
            <option value="cancelled">cancelled</option>
          </select>
        </FormField>
        <FormField label="Currency">
          <input
            type="text"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
            disabled={busy}
            style={inputStyle}
            maxLength={3}
          />
        </FormField>
        <FormField label="Incoterms">
          <input
            type="text"
            value={incoterms}
            onChange={(e) => setIncoterms(e.target.value)}
            disabled={busy}
            style={inputStyle}
            placeholder="e.g. FOB, CIF, DAP"
          />
        </FormField>
        <FormField label="VAT Rate">
          <select
            value={vatRate}
            onChange={(e) => setVatRate(Number(e.target.value) as 0 | 5 | 20)}
            disabled={busy}
            style={inputStyle}
          >
            <option value={0}>0%</option>
            <option value={5}>5%</option>
            <option value={20}>20%</option>
          </select>
        </FormField>
      </div>

      <div className="mt-4">
        {isRussianEntity && (
          <div className="grid grid-cols-2 gap-4 mb-4">
            <FormField label="УНК (Unique Contract Number — from RU bank registration)">
              <input
                type="text"
                value={unkReference}
                onChange={(e) => setUnkReference(e.target.value)}
                disabled={busy}
                style={inputStyle}
                placeholder="25010001/1481/0001/2/1"
              />
            </FormField>
            <FormField label="УНК Valid Until">
              <input
                type="date"
                value={unkValidUntil}
                onChange={(e) => setUnkValidUntil(e.target.value)}
                disabled={busy}
                style={inputStyle}
              />
            </FormField>
          </div>
        )}
        <FormField label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={busy}
            rows={3}
            style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
          />
        </FormField>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: '14px',
  fontWeight: 700,
  color: 'var(--fg-1)',
  backgroundColor: 'var(--paper)',
  border: '1px solid var(--border-hairline)',
  borderRadius: 'var(--radius-sm)',
  letterSpacing: '0',
};

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block mb-1" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{label}</label>
      {children}
    </div>
  );
}

function CopyableField({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  const missing = !value || value === 'MISSING' || value === '—' || value.trim() === '';
  return (
    <div>
      <dt className="mb-1" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{label}</dt>
      <dd>
        {missing ? <span style={{ fontSize: mono ? '12px' : 'var(--fs-body-sm)', color: 'var(--fg-3)' }}>—</span>
                 : <CopyableValue value={value!} mono={mono} style={{ fontSize: mono ? '12px' : 'var(--fs-body-sm)', color: 'var(--fg-1)' }} />}
      </dd>
    </div>
  );
}

// =============================================================================
// Contract File section — Phase 7.1
// Empty state: drag-and-drop zone for PDF upload
// Filled state: filename + View / Replace / Delete buttons
// =============================================================================
function ContractFileSection({
  contract,
  onChange,
}: {
  contract: Contract;
  onChange: (next: Contract) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileKey = contract.contract_file_key;
  const filename = fileKey ? fileKey.split('/').pop() || fileKey : null;

  async function handleUpload(file: File) {
    setError(null);
    if (!file) return;
    if (file.type && file.type !== 'application/pdf') {
      setError(`Only PDF files are allowed (got ${file.type})`);
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 20 MB.`);
      return;
    }
    setBusy(true);
    try {
      const res = await uploadContractFile(contract.id, file);
      if (!res.success) {
        setError(res.errors[0]?.message ?? 'Upload failed');
      } else {
        onChange({ ...contract, contract_file_key: res.result?.contract_file_key ?? null });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this PDF file? The contract record itself will remain.')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await deleteContractFile(contract.id);
      if (!res.success) {
        setError(res.errors[0]?.message ?? 'Delete failed');
      } else {
        onChange({ ...contract, contract_file_key: null });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-3" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>Contract File</div>

      {fileKey ? (
        // Filled state — file exists in R2
        <div
          className="flex items-center justify-between p-4"
          style={{
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <div className="flex items-center gap-3">
            <FileText size={20} style={{ color: 'var(--fg-2)' }} />
            <div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>{filename}</div>
              <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: 2 }}>PDF in R2</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={getContractFileUrl(contract.id)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-3 py-2"
              style={{
                fontSize: '14px',
                backgroundColor: 'var(--paper-1)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--fg-1)',
                textDecoration: 'none',
              }}
            >
              <Eye size={16} /> View
            </a>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="inline-flex items-center gap-2 px-3 py-2"
              style={{
                fontSize: '14px',
                backgroundColor: 'var(--paper-1)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--fg-1)',
                cursor: busy ? 'wait' : 'pointer',
              }}
            >
              <Replace size={16} /> Replace
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              className="inline-flex items-center gap-2 px-3 py-2"
              style={{
                fontSize: '14px',
                backgroundColor: 'rgba(229,32,44,0.05)',
                border: '1px solid rgba(229,32,44,0.2)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--brand-rot)',
                cursor: busy ? 'wait' : 'pointer',
              }}
            >
              <Trash2 size={16} /> Delete
            </button>
          </div>
        </div>
      ) : (
        // Empty state — drop zone
        <div
          onClick={() => !busy && inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handleUpload(f);
          }}
          className="flex flex-col items-center justify-center py-10 px-6"
          style={{
            backgroundColor: dragOver ? 'rgba(46,125,79,0.05)' : 'var(--paper-sunk)',
            border: `2px dashed ${dragOver ? 'var(--status-success)' : 'var(--border-hairline)'}`,
            borderRadius: 'var(--radius-md)',
            cursor: busy ? 'wait' : 'pointer',
            transition: 'background-color 0.15s, border-color 0.15s',
          }}
        >
          {busy ? (
            <Loader2 size={28} className="animate-spin" style={{ color: 'var(--fg-muted)' }} />
          ) : (
            <Upload size={28} style={{ color: 'var(--fg-3)' }} />
          )}
          <div className="mt-3" style={{ fontSize: '14px', color: 'var(--fg-1)', fontWeight: 700 }}>
            {busy ? 'Uploading…' : 'Drop PDF here or click to browse'}
          </div>
          <div className="mt-1" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
            Filename will be saved as <span style={{ fontWeight: 700 }}>{contract.entity_abbreviation || contract.our_company_id.toUpperCase()}-[abbreviation]-[date].pdf</span>
          </div>
          <div className="mt-1" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
            PDF only, max 20 MB
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload(f);
          e.target.value = '';
        }}
      />

      {error && (
        <div
          className="mt-3 p-3"
          style={{
            fontSize: '14px',
            backgroundColor: 'rgba(229,32,44,0.05)',
            border: '1px solid rgba(229,32,44,0.2)',
            color: 'var(--brand-rot)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
