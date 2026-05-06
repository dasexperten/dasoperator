'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import {
  getPartner, getPartnerContracts, getProducts, getPartners,
  getCompanies, getManufacturers,
  createOperation, getProductPriceForContract,
  type Partner, type Contract, type Product, type Company, type Manufacturer
} from '@/lib/api';
import Breadcrumb from '@/components/layout/breadcrumb';

interface LineItemRow {
  id: string;            // local UUID for React key
  product_id: string;
  qty: number;
  unit_price: number;
  discount_pct: number;
  // computed:
  line_total: number;
}

function formatMoney(minor: number, currency: string): string {
  const factor = ['VND', 'JPY', 'KRW'].includes(currency) ? 1 : 100;
  return (minor / factor).toLocaleString('en-US', {
    minimumFractionDigits: factor === 1 ? 0 : 2,
    maximumFractionDigits: factor === 1 ? 0 : 2,
  });
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: '14px',
  backgroundColor: 'var(--paper-sunk)',
  border: '1px solid var(--border-hairline)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--fg-1)',
};

export default function NewOperationClient({ partnerSlug }: { partnerSlug: string }) {
  const router = useRouter();

  // Reference data
  const [partner, setPartner] = useState<Partner | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [allPartners, setAllPartners] = useState<Partner[]>([]);  // for global mode
  const [companies, setCompanies] = useState<Company[]>([]);
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [loadingRef, setLoadingRef] = useState(true);

  // In global mode (no partnerSlug), user picks partner from dropdown
  const [selectedPartnerSlug, setSelectedPartnerSlug] = useState<string>(partnerSlug);
  const isGlobalMode = !partnerSlug;

  // Form state
  const [opType, setOpType] = useState<'sale' | 'purchase' | 'transfer'>('sale');
  const [contractId, setContractId] = useState<string>('');
  const [manufacturerId, setManufacturerId] = useState<string>('');     // Purchase
  const [ourCompanyId, setOurCompanyId] = useState<string>('cmp_dee');  // for purchase/transfer
  const [receivingCompanyId, setReceivingCompanyId] = useState<string>('');  // Transfer
  const [viaDei, setViaDei] = useState<boolean>(false);  // Purchase: through DEI passthrough
  const [opDate, setOpDate] = useState<string>(new Date().toISOString().split('T')[0]!);
  const [warehouseFromId, setWarehouseFromId] = useState<string>('');
  const [warehouseToId, setWarehouseToId] = useState<string>('');
  const [incoterms, setIncoterms] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [overallDiscountPct, setOverallDiscountPct] = useState<number>(0);

  const [lineItems, setLineItems] = useState<LineItemRow[]>([
    { id: crypto.randomUUID(), product_id: '', qty: 0, unit_price: 0, discount_pct: 0, line_total: 0 },
  ]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // First effect: load products + (always) companies + manufacturers + partners
  useEffect(() => {
    const fetchInitial = async () => {
      try {
        const [prodRes, partnersRes, companiesRes, manufacturersRes] = await Promise.all([
          getProducts('DE'),
          getPartners(),
          getCompanies(),
          getManufacturers(),
        ]);
        if (prodRes.success && prodRes.result) setProducts(prodRes.result.products);
        if (partnersRes && partnersRes.success && partnersRes.result) {
          setAllPartners(partnersRes.result.partners.filter((p) => p.status === 'active'));
        }
        if (companiesRes.success && companiesRes.result) {
          setCompanies(companiesRes.result.companies);
        }
        if (manufacturersRes.success && manufacturersRes.result) {
          setManufacturers(manufacturersRes.result.manufacturers);
        }
      } catch {
        // silent
      } finally {
        if (!selectedPartnerSlug) setLoadingRef(false);
      }
    };
    fetchInitial();
  }, []);

  // Second effect: load partner-specific data when slug becomes available
  useEffect(() => {
    if (!selectedPartnerSlug) return;
    const fetchPartnerData = async () => {
      setLoadingRef(true);
      try {
        const [pRes, cRes] = await Promise.all([
          getPartner(selectedPartnerSlug),
          getPartnerContracts(selectedPartnerSlug),
        ]);
        if (pRes.success && pRes.result) setPartner(pRes.result);
        if (cRes.success && cRes.result) setContracts(cRes.result.contracts.filter((c) => c.status === 'active'));
      } catch {
        // silent — user sees disabled form
      } finally {
        setLoadingRef(false);
      }
    };
    fetchPartnerData();
  }, [selectedPartnerSlug]);

  const selectedContract = useMemo(
    () => contracts.find((c) => c.id === contractId),
    [contracts, contractId]
  );

  const contractCurrency = selectedContract?.currency ?? '';
  const contractEntity = selectedContract?.entity_abbreviation ?? '';

  // DEI passthrough auto-rules:
  // - DASEAN buyer → checkbox FORCED ON (DASEAN can't buy direct from factory, tax efficiency)
  // - DEI buyer → checkbox hidden + value reset (DEI can't pass to itself)
  useEffect(() => {
    if (opType !== 'purchase') return;
    if (ourCompanyId === 'cmp_dasean') {
      setViaDei(true);
    } else if (ourCompanyId === 'cmp_dei') {
      setViaDei(false);
    }
  }, [opType, ourCompanyId]);
  const isReadyForDetails = useMemo(() => {
    if (opType === 'sale')     return Boolean(contractId);
    if (opType === 'purchase') return Boolean(manufacturerId && ourCompanyId);
    if (opType === 'transfer') return Boolean(ourCompanyId && receivingCompanyId);
    return false;
  }, [opType, contractId, manufacturerId, ourCompanyId, receivingCompanyId]);

  // Subtotal before overall discount
  const subtotal = useMemo(
    () => lineItems.reduce((sum, li) => sum + li.line_total, 0),
    [lineItems]
  );
  const grandTotal = useMemo(
    () => Math.round(subtotal * (1 - overallDiscountPct / 100)),
    [subtotal, overallDiscountPct]
  );

  // Recalculate line_total when product/qty/price/discount changes
  function updateLineItem(idx: number, patch: Partial<LineItemRow>) {
    setLineItems((rows) => {
      const next = [...rows];
      const row = { ...next[idx]!, ...patch };
      row.line_total = Math.round(row.qty * row.unit_price * (1 - row.discount_pct / 100));
      next[idx] = row;
      return next;
    });
  }

  // Auto-fill price when product selected
  async function handleProductChange(idx: number, productId: string) {
    updateLineItem(idx, { product_id: productId });
    if (!productId || !contractId) return;
    try {
      const res = await getProductPriceForContract(productId, contractId);
      if (res.success && res.result?.price) {
        updateLineItem(idx, { product_id: productId, unit_price: res.result.price });
      }
    } catch (e) {
      // silent — user can enter price manually
    }
  }

  function addLineItem() {
    setLineItems((rows) => [
      ...rows,
      { id: crypto.randomUUID(), product_id: '', qty: 0, unit_price: 0, discount_pct: 0, line_total: 0 },
    ]);
  }

  function removeLineItem(id: string) {
    setLineItems((rows) => rows.filter((r) => r.id !== id));
  }

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);

    const validItems = lineItems.filter((li) => li.product_id && li.qty > 0 && li.unit_price >= 0);
    if (validItems.length === 0) {
      setError('At least one line item with product, qty, and price required');
      setSubmitting(false);
      return;
    }

    const body = {
      contract_id: contractId,
      operation_type: opType,
      operation_date: Math.floor(new Date(opDate).getTime() / 1000),
      warehouse_from_id: warehouseFromId || undefined,
      warehouse_to_id: warehouseToId || undefined,
      incoterms: incoterms.trim() || undefined,
      notes: notes.trim() || undefined,
      line_items: validItems.map((li) => ({
        product_id: li.product_id,
        qty: li.qty,
        unit_price: li.unit_price,
        discount_pct: overallDiscountPct,  // apply overall to each line per Q3
      })),
    };

    try {
      const res = await createOperation(body);
      if (res.success && res.result) {
        // Redirect back to partner hub (operation detail page comes in PR-C3)
        router.push(isGlobalMode ? '/operations' : `/partners/${selectedPartnerSlug}`);
      } else {
        setError(res.errors?.[0]?.message ?? 'Failed to create operation');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = contractId && lineItems.some((li) => li.product_id && li.qty > 0);

  if (loadingRef) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>;
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <Breadcrumb items={isGlobalMode ? [
        { label: 'Operations', href: '/operations' },
        { label: 'New Operation' },
      ] : [
        { label: 'Partners', href: '/partners' },
        { label: partner?.trade_name ?? selectedPartnerSlug, href: `/partners/${selectedPartnerSlug}` },
        { label: 'New Operation' },
      ]} />

      <div>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'var(--fs-display-md)',
          fontWeight: 900,
          color: 'var(--fg-1)',
        }}>
          New Operation
        </h1>
        {!isGlobalMode && (
          <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
            For partner: <strong>{partner?.trade_name ?? selectedPartnerSlug}</strong>
          </p>
        )}
      </div>

      <div className="dx-ribbon-rule" />

      {/* Section A: Operation Type — must come first, drives everything else */}
      <Section label="Type">
        <div className="grid grid-cols-3 gap-3">
          {([
            { id: 'sale',     label: 'Sales',    desc: 'Sell to a buyer',         color: '#2E7D4F' /* green */ },
            { id: 'purchase', label: 'Purchase', desc: 'Buy from factory',        color: '#7D481C' /* brown */ },
            { id: 'transfer', label: 'Transfer', desc: 'Between our entities',    color: '#5C5C5C' /* gray  */ },
          ] as const).map((t) => {
            const active = opType === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setOpType(t.id);
                  // reset counterparty fields on type change
                  setSelectedPartnerSlug(partnerSlug);
                  setContractId('');
                  setManufacturerId('');
                  setReceivingCompanyId('');
                }}
                style={{
                  padding: '14px 16px',
                  textAlign: 'left',
                  backgroundColor: active ? t.color : 'var(--paper-sunk)',
                  color: active ? 'var(--paper)' : 'var(--fg-1)',
                  border: `1px solid ${active ? t.color : 'var(--border-hairline)'}`,
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: '16px', marginBottom: '4px' }}>{t.label}</div>
                <div style={{ fontSize: '14px', opacity: active ? 0.9 : 0.7 }}>{t.desc}</div>
              </button>
            );
          })}
        </div>
      </Section>

      {/* Section B: Counterparty — varies by type */}
      {opType === 'sale' && (
        <Section label="Buyer & Contract">
          <div className={isGlobalMode ? 'grid grid-cols-2 gap-6' : ''}>
            {isGlobalMode && (
              <div>
                <Label>Select buyer *</Label>
                <select
                  value={selectedPartnerSlug}
                  onChange={(e) => {
                    setSelectedPartnerSlug(e.target.value);
                    setContractId('');
                  }}
                  style={selectStyle}
                >
                  <option value="">— Choose a buyer —</option>
                  {allPartners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.trade_name} ({p.country ?? '—'})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <Label>Select contract *</Label>
              {!selectedPartnerSlug ? (
                <p style={{ fontSize: '14px', color: 'var(--fg-3)' }}>Select a buyer first.</p>
              ) : contracts.length === 0 ? (
                <p style={{ fontSize: '14px', color: 'var(--status-warning)' }}>No active contracts.</p>
              ) : (
                <select value={contractId} onChange={(e) => setContractId(e.target.value)} style={selectStyle}>
                  <option value="">— Choose contract —</option>
                  {contracts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.contract_no} ({c.entity_abbreviation} · {c.currency})
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          {selectedContract && (
            <div className="mt-4 grid grid-cols-3 gap-3" style={{ fontSize: '14px' }}>
              <div><Label>Entity</Label><div style={{ color: 'var(--fg-1)' }}>{contractEntity}</div></div>
              <div><Label>Currency</Label><div style={{ color: 'var(--fg-1)' }}>{contractCurrency}</div></div>
              <div><Label>Contract</Label><div style={{ color: 'var(--fg-1)' }}>{selectedContract.contract_no}</div></div>
            </div>
          )}
        </Section>
      )}

      {opType === 'purchase' && (
        <Section label="Supplier (Factory)">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <Label>Manufacturer *</Label>
              <select value={manufacturerId} onChange={(e) => setManufacturerId(e.target.value)} style={selectStyle}>
                <option value="">— Choose factory —</option>
                {manufacturers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}{m.country ? ` (${m.country})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Buying company *</Label>
              <select value={ourCompanyId} onChange={(e) => setOurCompanyId(e.target.value)} style={selectStyle}>
                {companies.map((co) => (
                  <option key={co.id} value={co.id}>
                    {co.abbreviation} — {co.legal_name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* DEI passthrough — visible for DEE/DASEAN/DEC; hidden for DEI itself */}
          {ourCompanyId !== 'cmp_dei' && (
            <div
              className="mt-4 p-4"
              style={{
                backgroundColor: 'var(--paper-sunk)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <label
                className="flex items-start gap-3"
                style={{ cursor: ourCompanyId === 'cmp_dasean' ? 'not-allowed' : 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={viaDei}
                  disabled={ourCompanyId === 'cmp_dasean'}
                  onChange={(e) => setViaDei(e.target.checked)}
                  style={{ marginTop: '2px', width: '18px', height: '18px', cursor: 'inherit' }}
                />
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>
                    Through DEI
                  </div>
                  <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '2px' }}>
                    {ourCompanyId === 'cmp_dasean'
                      ? 'DASEAN always purchases through DEI for tax efficiency. This option is required.'
                      : 'Generates two document packages: factory → DEI (CI + PL), then DEI → buyer (CI + PL + IS).'}
                  </div>
                </div>
              </label>
            </div>
          )}
        </Section>
      )}

      {opType === 'transfer' && (
        <Section label="Internal Transfer">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <Label>From entity *</Label>
              <select value={ourCompanyId} onChange={(e) => setOurCompanyId(e.target.value)} style={selectStyle}>
                {companies.map((co) => (
                  <option key={co.id} value={co.id}>
                    {co.abbreviation} — {co.legal_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>To entity *</Label>
              <select value={receivingCompanyId} onChange={(e) => setReceivingCompanyId(e.target.value)} style={selectStyle}>
                <option value="">— Choose receiving entity —</option>
                {companies.filter((co) => co.id !== ourCompanyId).map((co) => (
                  <option key={co.id} value={co.id}>
                    {co.abbreviation} — {co.legal_name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="mt-3" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
            Documents will be issued as a sale invoice from the sending entity to the receiving entity.
          </p>
        </Section>
      )}

      {/* Section C: Operation Details — disabled until prerequisites met */}
      <Section label="Operation Details" disabled={!isReadyForDetails}>
        <div>
          <Label>Date *</Label>
          <input type="date" value={opDate} onChange={(e) => setOpDate(e.target.value)} disabled={!isReadyForDetails}
            className="w-full px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
        </div>
        <div className="grid grid-cols-2 gap-4 mt-4">
          <div>
            <Label>Warehouse From {(opType === 'sale' || opType === 'transfer') && '*'}</Label>
            <input type="text" value={warehouseFromId} onChange={(e) => setWarehouseFromId(e.target.value)} disabled={!isReadyForDetails}
              placeholder="e.g. wh_lbr"
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
          </div>
          <div>
            <Label>Warehouse To {(opType === 'purchase' || opType === 'transfer') && '*'}</Label>
            <input type="text" value={warehouseToId} onChange={(e) => setWarehouseToId(e.target.value)} disabled={!isReadyForDetails}
              placeholder="e.g. wh_yer"
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
          </div>
        </div>
        <div className="mt-4">
          <Label>Incoterms</Label>
          <input type="text" value={incoterms} onChange={(e) => setIncoterms(e.target.value)} disabled={!contractId} placeholder="FCA Saransk"
            className="w-full px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
        </div>
        <div className="mt-4">
          <Label>Notes</Label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!contractId} rows={2} placeholder="Optional"
            className="w-full px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
        </div>
      </Section>

      {/* Section 3: Line items */}
      <Section label="Line Items" disabled={!contractId}>
        <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
              <Th>#</Th><Th>SKU</Th><Th>Qty</Th><Th>Price ({contractCurrency || '—'})</Th><Th>Total</Th><Th></Th>
            </tr>
          </thead>
          <tbody>
            {lineItems.map((li, idx) => (
              <tr key={li.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <td className="px-3 py-2" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{idx + 1}</td>
                <td className="px-3 py-2">
                  <select value={li.product_id} onChange={(e) => handleProductChange(idx, e.target.value)} disabled={!contractId}
                    className="w-full px-2 py-1 text-sm focus:outline-none"
                    style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)', fontSize: '14px' }}>
                    <option value="">—</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.id.replace('prd_', '').toUpperCase()} — {p.product_name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input type="number" value={li.qty || ''} onChange={(e) => updateLineItem(idx, { qty: parseInt(e.target.value) || 0 })} disabled={!contractId} min={0}
                    className="w-20 px-2 py-1 text-sm focus:outline-none text-right"
                    style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)' }} />
                </td>
                <td className="px-3 py-2">
                  <input type="number" value={li.unit_price || ''} onChange={(e) => updateLineItem(idx, { unit_price: parseInt(e.target.value) || 0 })} disabled={!contractId} min={0}
                    className="w-28 px-2 py-1 text-sm focus:outline-none text-right"
                    style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)' }} />
                </td>
                <td className="px-3 py-2 text-right" style={{ fontSize: '14px', color: 'var(--fg-1)' }}>
                  {formatMoney(li.line_total, contractCurrency)} {contractCurrency}
                </td>
                <td className="px-3 py-2">
                  {lineItems.length > 1 && (
                    <button onClick={() => removeLineItem(li.id)} className="p-1" style={{ color: 'var(--fg-3)', cursor: 'pointer', backgroundColor: 'transparent', border: 'none' }} title="Remove line">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button onClick={addLineItem} disabled={!contractId}
          className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 text-sm transition-colors"
          style={{
            backgroundColor: 'transparent', color: 'var(--brand-rot)',
            border: '1px solid var(--brand-rot)', borderRadius: 'var(--radius-sm)',
            opacity: !contractId ? 0.5 : 1, cursor: !contractId ? 'not-allowed' : 'pointer',
          }}>
          <Plus className="h-3.5 w-3.5" /> Add line item
        </button>

        {/* Discount + Total */}
        <div className="mt-6 pt-4" style={{ borderTop: '1px solid var(--border-hairline)' }}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>Overall discount %</Label>
              <input type="number" value={overallDiscountPct || ''} onChange={(e) => setOverallDiscountPct(parseFloat(e.target.value) || 0)} disabled={!contractId} min={0} max={100} step={0.1}
                className="w-24 px-2 py-1 text-sm focus:outline-none text-right"
                style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)' }} />
            </div>
            <div className="text-right">
              <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-3)' }}>Subtotal: {formatMoney(subtotal, contractCurrency)} {contractCurrency}</div>
              <div className="mt-1" style={{ fontSize: '24px', fontWeight: 700, color: 'var(--fg-1)' }}>
                {formatMoney(grandTotal, contractCurrency)} {contractCurrency}
              </div>
            </div>
          </div>
        </div>
      </Section>

      {error && (
        <div className="p-3 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button onClick={() => router.back()}
          className="px-4 py-2"
          style={{ border: '1px solid var(--border-hairline)', backgroundColor: 'transparent', borderRadius: 'var(--radius-sm)', fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>
          Cancel
        </button>
        <button onClick={handleSubmit} disabled={!canSubmit || submitting}
          className="px-4 py-2 inline-flex items-center gap-2"
          style={{
            backgroundColor: 'var(--brand-rot)', color: 'var(--paper)',
            borderRadius: 'var(--radius-sm)', fontSize: 'var(--fs-body-sm)', fontWeight: 600,
            opacity: (!canSubmit || submitting) ? 0.5 : 1,
            cursor: (!canSubmit || submitting) ? 'not-allowed' : 'pointer',
          }}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Create Draft
        </button>
      </div>
    </div>
  );
}

function Section({ label, children, disabled = false }: { label: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <div className="bg-card p-5" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', opacity: disabled ? 0.5 : 1 }}>
      <h2 style={{
        fontFamily: 'var(--font-accent-jakarta)',
        fontSize: '24px',
        fontWeight: 800,
        
        textTransform: 'uppercase',
        color: 'var(--fg-1)',
        lineHeight: 1,
        marginBottom: '20px',
      }}>
        {label}
      </h2>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="block mb-1" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
      {children}
    </label>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th className="text-left px-3 py-2" style={{ fontSize: '14px', color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)' }}>
      {children}
    </th>
  );
}
