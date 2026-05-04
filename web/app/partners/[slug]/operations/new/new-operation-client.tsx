'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import {
  getPartner, getPartnerContracts, getProducts,
  createOperation, getProductPriceForContract,
  type Partner, type Contract, type Product
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

export default function NewOperationClient({ partnerSlug }: { partnerSlug: string }) {
  const router = useRouter();

  // Reference data
  const [partner, setPartner] = useState<Partner | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingRef, setLoadingRef] = useState(true);

  // Form state
  const [contractId, setContractId] = useState<string>('');
  const [opType, setOpType] = useState<'sale' | 'purchase' | 'transfer'>('sale');
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

  useEffect(() => {
    const fetch = async () => {
      try {
        const [pRes, cRes, prodRes] = await Promise.all([
          getPartner(partnerSlug),
          getPartnerContracts(partnerSlug),
          getProducts('DE'),
        ]);
        if (pRes.success && pRes.result) setPartner(pRes.result);
        if (cRes.success && cRes.result) setContracts(cRes.result.contracts.filter((c) => c.status === 'active'));
        if (prodRes.success && prodRes.result) setProducts(prodRes.result.products);
      } catch (e) {
        // silent — user sees disabled form
      } finally {
        setLoadingRef(false);
      }
    };
    fetch();
  }, [partnerSlug]);

  const selectedContract = useMemo(
    () => contracts.find((c) => c.id === contractId),
    [contracts, contractId]
  );

  const contractCurrency = selectedContract?.currency ?? '';
  const contractEntity = selectedContract?.entity_abbreviation ?? '';

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
        router.push(`/partners/${partnerSlug}`);
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
      <Breadcrumb items={[
        { label: 'Partners', href: '/partners' },
        { label: partner?.trade_name ?? partnerSlug, href: `/partners/${partnerSlug}` },
        { label: 'New Operation' },
      ]} />

      <div>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'var(--fs-display-md)',
          fontWeight: 900,
          letterSpacing: '-0.025em',
          color: 'var(--fg-1)',
        }}>
          New Operation
        </h1>
        <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          For partner: <strong>{partner?.trade_name ?? partnerSlug}</strong>
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      {/* Section 1: Contract */}
      <Section label="Contract">
        <div>
          <Label>Select contract *</Label>
          {contracts.length === 0 ? (
            <p style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--status-warning)' }}>
              No active contracts for this partner. Create a contract first.
            </p>
          ) : (
            <select value={contractId} onChange={(e) => setContractId(e.target.value)}
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
              <option value="">— Choose contract —</option>
              {contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.contract_no} ({c.entity_abbreviation} · {c.currency})
                </option>
              ))}
            </select>
          )}
          {selectedContract && (
            <div className="mt-3 grid grid-cols-3 gap-3" style={{ fontSize: 'var(--fs-caption)' }}>
              <div><Label>Entity</Label><div className="dx-mono" style={{ color: 'var(--fg-1)' }}>{contractEntity}</div></div>
              <div><Label>Currency</Label><div className="dx-mono" style={{ color: 'var(--fg-1)' }}>{contractCurrency}</div></div>
              <div><Label>Contract</Label><div className="dx-mono" style={{ color: 'var(--fg-1)' }}>{selectedContract.contract_no}</div></div>
            </div>
          )}
        </div>
      </Section>

      {/* Section 2: Operation Details — disabled until contract selected */}
      <Section label="Operation Details" disabled={!contractId}>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Type *</Label>
            <select value={opType} onChange={(e) => setOpType(e.target.value as 'sale' | 'purchase' | 'transfer')} disabled={!contractId}
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
              <option value="sale">Sale</option>
              <option value="purchase">Purchase</option>
              <option value="transfer">Transfer</option>
            </select>
          </div>
          <div>
            <Label>Date *</Label>
            <input type="date" value={opDate} onChange={(e) => setOpDate(e.target.value)} disabled={!contractId}
              className="w-full px-3 py-2 text-sm focus:outline-none dx-mono"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mt-4">
          <div>
            <Label>Warehouse From {(opType === 'sale' || opType === 'transfer') && '*'}</Label>
            <input type="text" value={warehouseFromId} onChange={(e) => setWarehouseFromId(e.target.value)} disabled={!contractId}
              placeholder="e.g. wh_lbr"
              className="w-full px-3 py-2 text-sm focus:outline-none dx-mono"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
          </div>
          <div>
            <Label>Warehouse To {(opType === 'purchase' || opType === 'transfer') && '*'}</Label>
            <input type="text" value={warehouseToId} onChange={(e) => setWarehouseToId(e.target.value)} disabled={!contractId}
              placeholder="e.g. wh_yer"
              className="w-full px-3 py-2 text-sm focus:outline-none dx-mono"
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
                <td className="px-3 py-2 dx-mono" style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{idx + 1}</td>
                <td className="px-3 py-2">
                  <select value={li.product_id} onChange={(e) => handleProductChange(idx, e.target.value)} disabled={!contractId}
                    className="w-full px-2 py-1 text-sm focus:outline-none dx-mono"
                    style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)', fontSize: '12px' }}>
                    <option value="">—</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.id.replace('prd_', '').toUpperCase()} — {p.product_name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input type="number" value={li.qty || ''} onChange={(e) => updateLineItem(idx, { qty: parseInt(e.target.value) || 0 })} disabled={!contractId} min={0}
                    className="w-20 px-2 py-1 text-sm focus:outline-none dx-mono text-right"
                    style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)' }} />
                </td>
                <td className="px-3 py-2">
                  <input type="number" value={li.unit_price || ''} onChange={(e) => updateLineItem(idx, { unit_price: parseInt(e.target.value) || 0 })} disabled={!contractId} min={0}
                    className="w-28 px-2 py-1 text-sm focus:outline-none dx-mono text-right"
                    style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)' }} />
                </td>
                <td className="px-3 py-2 dx-mono text-right" style={{ fontSize: '12px', color: 'var(--fg-1)' }}>
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
                className="w-24 px-2 py-1 text-sm focus:outline-none dx-mono text-right"
                style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)' }} />
            </div>
            <div className="text-right">
              <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-3)' }}>Subtotal: {formatMoney(subtotal, contractCurrency)} {contractCurrency}</div>
              <div className="dx-mono mt-1" style={{ fontSize: '24px', fontWeight: 700, color: 'var(--fg-1)' }}>
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
        letterSpacing: '-0.005em',
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
    <label className="dx-eyebrow block mb-1" style={{ fontSize: '10px', color: 'var(--fg-3)' }}>
      {children}
    </label>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left px-3 py-2 dx-eyebrow" style={{ fontSize: '10px', color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)' }}>
      {children}
    </th>
  );
}
