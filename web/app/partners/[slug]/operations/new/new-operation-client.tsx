'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import {
  getPartner, getPartnerContracts, getProductsList, getPartners,
  getCompanies, getManufacturers, getProductsByManufacturer,
  getWarehouses, getPricelistMap, getStocks,
  createOperation, getProductPriceForContract,
  type Partner, type Contract, type Product, type ProductListItem, type Company, type Manufacturer,
  type Warehouse
} from '@/lib/api';
import { formatMoney } from '@/lib/money';
import Breadcrumb from '@/components/layout/breadcrumb';

// Per-SKU entry — keyed by product_id. pieces > 0 means included in submission.
// cartons is derived from pieces / ctn_qty for display; sole source of truth is pieces.
// No per-line discount — discount applies to the operation as a whole (overallDiscountPct).
interface LineEntry {
  pieces: number;
  unit_price: number;
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
  const [products, setProducts] = useState<ProductListItem[]>([]);
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
  // Currency for purchase (default CNY) and transfer (default USD).
  // For sale, currency comes from contract — this state is unused.
  const [currency, setCurrency] = useState<string>('CNY');
  const [opDate, setOpDate] = useState<string>(new Date().toISOString().split('T')[0]!);
  const [warehouseFromId, setWarehouseFromId] = useState<string>('');
  const [warehouseToId, setWarehouseToId] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [overallDiscountPct, setOverallDiscountPct] = useState<number>(0);

  // entries: productId → { pieces, unit_price, discount_pct }
  // Only entries with pieces > 0 are submitted as line_items to the API.
  const [entries, setEntries] = useState<Record<string, LineEntry>>({});

  // Which category groups are expanded in the UI
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({});

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Warehouse dropdowns — filtered by counterparty context.
  // FROM list: depends on opType (sale=our company, purchase=manufacturer, transfer=our company)
  // TO list:   sale=hidden, purchase=our company, transfer=receiving company
  const [warehousesFrom, setWarehousesFrom] = useState<Warehouse[]>([]);
  const [warehousesTo, setWarehousesTo] = useState<Warehouse[]>([]);

  // Purchase pricelist — SKU → decimal price in CNY (from R2 via /api/pricer/list).
  // Loaded once when opType becomes 'purchase'. Used by handleProductChange.
  const [purchasePrices, setPurchasePrices] = useState<Record<string, number>>({});

  // Per-warehouse on-hand stock map: productId → on_hand pieces.
  // Reloaded whenever warehouseFromId changes. Used to render the "In stock"
  // column in the line items grid so user sees what's available at the
  // outgoing warehouse before deciding pieces.
  const [stockMap, setStockMap] = useState<Record<string, number>>({});

  // First effect: load products + (always) companies + manufacturers + partners
  useEffect(() => {
    const fetchInitial = async () => {
      try {
        const [prodRes, partnersRes, companiesRes, manufacturersRes] = await Promise.all([
          getProductsList(),
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

  // Effective currency for line item display & totals:
  //   sale     → from contract (selected by user)
  //   purchase → from currency state (CNY default)
  //   transfer → from currency state (USD default)
  const effectiveCurrency = useMemo(() => {
    if (opType === 'sale') return contractCurrency;
    return currency;
  }, [opType, contractCurrency, currency]);

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

  // Reset currency to sensible default when type changes:
  // purchase → CNY (we buy in yuan from Chinese factories)
  // transfer → USD (cross-border invoice between our entities, USD pivot)
  // sale     → comes from contract, not from this state
  useEffect(() => {
    if (opType === 'purchase') setCurrency('CNY');
    if (opType === 'transfer') setCurrency('USD');
  }, [opType]);

  // Warehouse FROM dropdown — context determines whose warehouses to show:
  //   sale     → seller's warehouses (our_company derived from contract)
  //   purchase → manufacturer's warehouses (factory ships from its own)
  //   transfer → sending company's warehouses
  useEffect(() => {
    let ownerCompany: string | undefined;
    let ownerManufacturer: string | undefined;

    if (opType === 'sale') {
      ownerCompany = selectedContract?.our_company_id ?? undefined;
    } else if (opType === 'purchase') {
      ownerManufacturer = manufacturerId || undefined;
    } else {
      // transfer
      ownerCompany = ourCompanyId || undefined;
    }

    if (!ownerCompany && !ownerManufacturer) {
      setWarehousesFrom([]);
      return;
    }

    getWarehouses({
      company_id: ownerCompany,
      manufacturer_id: ownerManufacturer,
    }).then((res) => {
      if (res.success && res.result) {
        setWarehousesFrom(res.result.warehouses);
        // Hybrid auto-select: if exactly one warehouse, pre-fill the field.
        if (res.result.warehouses.length === 1) {
          setWarehouseFromId(res.result.warehouses[0]!.id);
        } else if (!res.result.warehouses.find((w) => w.id === warehouseFromId)) {
          // Clear stale selection that doesn't match new context
          setWarehouseFromId('');
        }
      }
    }).catch(() => setWarehousesFrom([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opType, selectedContract?.our_company_id, manufacturerId, ourCompanyId]);

  // Warehouse TO dropdown:
  //   sale     → not used (B decision: deliver per incoterms, no warehouse_to)
  //   purchase → buying company's warehouses (where goods arrive)
  //   transfer → receiving company's warehouses
  useEffect(() => {
    if (opType === 'sale') {
      setWarehousesTo([]);
      setWarehouseToId('');
      return;
    }

    const ownerCompany =
      opType === 'purchase' ? ourCompanyId :
      opType === 'transfer' ? receivingCompanyId :
      '';

    if (!ownerCompany) {
      setWarehousesTo([]);
      return;
    }

    getWarehouses({ company_id: ownerCompany }).then((res) => {
      if (res.success && res.result) {
        setWarehousesTo(res.result.warehouses);
        if (res.result.warehouses.length === 1) {
          setWarehouseToId(res.result.warehouses[0]!.id);
        } else if (!res.result.warehouses.find((w) => w.id === warehouseToId)) {
          setWarehouseToId('');
        }
      }
    }).catch(() => setWarehousesTo([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opType, ourCompanyId, receivingCompanyId]);

  // Purchase pricelist — load once when entering purchase mode.
  // Cached in component state; used by handleProductChange to autofill price.
  useEffect(() => {
    if (opType !== 'purchase') {
      setPurchasePrices({});
      return;
    }
    getPricelistMap('pt_purchase_cny').then((res) => {
      if (res.success && res.result) {
        setPurchasePrices(res.result.prices);
      }
    }).catch(() => setPurchasePrices({}));
  }, [opType]);

  // Reload on-hand stock for the selected outgoing warehouse.
  // Empty when no warehouse selected — column hides naturally.
  useEffect(() => {
    if (!warehouseFromId) {
      setStockMap({});
      return;
    }
    getStocks({ warehouse_id: warehouseFromId }).then((res) => {
      if (res.success && res.result) {
        const map: Record<string, number> = {};
        for (const s of res.result.stocks) {
          map[s.product_id] = s.on_hand;
        }
        setStockMap(map);
      }
    }).catch(() => setStockMap({}));
  }, [warehouseFromId]);

  const isReadyForDetails = useMemo(() => {
    if (opType === 'sale')     return Boolean(contractId);
    if (opType === 'purchase') return Boolean(manufacturerId && ourCompanyId);
    if (opType === 'transfer') return Boolean(ourCompanyId && receivingCompanyId);
    return false;
  }, [opType, contractId, manufacturerId, ourCompanyId, receivingCompanyId]);

  // When contract / opType / manufacturer changes, re-resolve prices for any
  // already-picked line items. Without this, switching from a RUB contract to
  // a USD contract would leave stale RUB prices in lines but the column header
  // would now read "Price (USD)" — silent currency mismatch.
  useEffect(() => {
    if (!isReadyForDetails) return;
    let cancelled = false;
    async function refetch() {
      const productIds = Object.keys(entries);
      const updates: Record<string, number> = {};
      for (const productId of productIds) {
        if (opType === 'sale' && contractId) {
          try {
            const res = await getProductPriceForContract(productId, contractId);
            updates[productId] = (res.success && res.result?.price !== null && res.result?.price !== undefined)
              ? res.result.price
              : 0;
          } catch {
            updates[productId] = 0;
          }
        } else if (opType === 'purchase') {
          const sku = productId.toUpperCase();
          updates[productId] = purchasePrices[sku] ?? 0;
        } else {
          updates[productId] = 0;
        }
      }
      if (cancelled) return;
      setEntries((prev) => {
        const next = { ...prev };
        for (const [pid, price] of Object.entries(updates)) {
          const e = next[pid];
          if (!e) continue;
          next[pid] = { ...e, unit_price: price };
        }
        return next;
      });
    }
    refetch();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId, opType, manufacturerId, isReadyForDetails]);

  // Products available for line items.
  // For Purchase: filtered by manufacturer via product_manufacturers M:N table
  //   (paste factories Honghui/Meizhiyuan/WDAA all produce same 9 pastes).
  // For Sale/Transfer: all products.
  const [purchaseProducts, setPurchaseProducts] = useState<Product[]>([]);

  useEffect(() => {
    if (opType !== 'purchase' || !manufacturerId) {
      setPurchaseProducts([]);
      return;
    }
    getProductsByManufacturer(manufacturerId).then((res) => {
      if (res.success && res.result) setPurchaseProducts(res.result.products);
    }).catch(() => setPurchaseProducts([]));
  }, [opType, manufacturerId]);

  const availableProducts = useMemo<ProductListItem[]>(() => {
    if (opType === 'purchase' && manufacturerId) {
      // Filter the full ProductListItem set by ids returned for this manufacturer
      const ids = new Set(purchaseProducts.map((p) => p.id));
      return products.filter((p) => ids.has(p.id));
    }
    return products;
  }, [products, purchaseProducts, opType, manufacturerId]);

  // Subtotal = sum of (pieces × unit_price) across entries with pieces > 0.
  // Per-line discount does NOT exist — overallDiscountPct applies once to the whole subtotal.
  const subtotal = useMemo(() => {
    let s = 0;
    for (const e of Object.values(entries)) {
      if (e.pieces > 0 && e.unit_price > 0) {
        s += e.pieces * e.unit_price;
      }
    }
    return Math.round(s * 100) / 100;
  }, [entries]);

  const grandTotal = useMemo(
    () => Math.round(subtotal * (100 - overallDiscountPct)) / 100,
    [subtotal, overallDiscountPct]
  );

  // Patch a single SKU entry. If pieces and unit_price both fall to 0, drop the
  // entry entirely so empty rows don't pile up in state.
  function updateEntry(productId: string, patch: Partial<LineEntry>) {
    setEntries((prev) => {
      const existing = prev[productId] ?? { pieces: 0, unit_price: 0 };
      const next = { ...existing, ...patch };
      if (next.pieces <= 0 && next.unit_price <= 0) {
        const { [productId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [productId]: next };
    });
  }

  // When user starts entering pieces for a SKU that has no price yet, fetch it.
  // Used as a fallback to the bulk refetch effect when entry is created mid-form.
  async function ensurePriceFor(productId: string) {
    const current = entries[productId];
    if (current && current.unit_price > 0) return;
    if (opType === 'sale' && contractId) {
      try {
        const res = await getProductPriceForContract(productId, contractId);
        if (res.success && res.result?.price) {
          updateEntry(productId, { unit_price: res.result.price });
        }
      } catch { /* silent */ }
    } else if (opType === 'purchase') {
      const decimal = purchasePrices[productId.toUpperCase()];
      if (decimal !== undefined) updateEntry(productId, { unit_price: decimal });
    }
  }

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);

    // Build line_items from entries map.
    // Per Aram's rule: discount_pct is ALWAYS 0 on individual lines.
    // The single overall discount is applied once on the whole order at the
    // payment / accounting level via overallDiscountPct (separate field on the operation).
    const validItems = Object.entries(entries)
      .filter(([_, e]) => e.pieces > 0 && e.unit_price >= 0)
      .map(([productId, e]) => ({
        product_id: productId,
        qty: e.pieces,
        unit_price: e.unit_price,
        discount_pct: 0,
      }));

    if (validItems.length === 0) {
      setError('Enter pieces for at least one product (with a price set)');
      setSubmitting(false);
      return;
    }

    // Build body per operation type:
    // SALE     — contract_id carries partner + company + currency (backend reads contract).
    // PURCHASE — manufacturer_id + our_company_id + currency provided directly.
    // TRANSFER — our_company_id + receiving_company_id + currency provided directly.
    const baseBody = {
      operation_type: opType,
      operation_date: Math.floor(new Date(opDate).getTime() / 1000),
      warehouse_from_id: warehouseFromId || undefined,
      warehouse_to_id: warehouseToId || undefined,
      notes: notes.trim() || undefined,
      line_items: validItems,
    };

    let body: import('@/lib/api').CreateOperationBody;
    if (opType === 'sale') {
      body = { ...baseBody, contract_id: contractId };
    } else if (opType === 'purchase') {
      body = {
        ...baseBody,
        manufacturer_id: manufacturerId,
        our_company_id: ourCompanyId,
        currency,
        dei_layer: viaDei ? 1 : 0,
      };
    } else {
      // transfer
      body = {
        ...baseBody,
        our_company_id: ourCompanyId,
        receiving_company_id: receivingCompanyId,
        currency,
      };
    }

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

  // Submit-readiness: at least one entry with positive pieces.
  const canSubmit = isReadyForDetails && Object.values(entries).some((e) => e.pieces > 0);

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
          <div className="grid grid-cols-3 gap-6">
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
            <div>
              <Label>Currency *</Label>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={selectStyle}>
                <option value="CNY">CNY — Chinese Yuan</option>
                <option value="USD">USD — US Dollar</option>
                <option value="EUR">EUR — Euro</option>
                <option value="RUB">RUB — Russian Ruble</option>
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
          <div className="grid grid-cols-3 gap-6">
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
            <div>
              <Label>Currency *</Label>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={selectStyle}>
                <option value="USD">USD — US Dollar</option>
                <option value="EUR">EUR — Euro</option>
                <option value="CNY">CNY — Chinese Yuan</option>
                <option value="RUB">RUB — Russian Ruble</option>
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
        <div className={`grid ${opType === 'sale' ? 'grid-cols-1' : 'grid-cols-2'} gap-4 mt-4`}>
          <div>
            <Label>Warehouse From *</Label>
            <select value={warehouseFromId} onChange={(e) => setWarehouseFromId(e.target.value)} disabled={!isReadyForDetails}
              style={selectStyle}>
              <option value="">— Choose warehouse —</option>
              {warehousesFrom.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}{w.country ? ` (${w.country})` : ''}
                </option>
              ))}
            </select>
            {warehousesFrom.length === 0 && isReadyForDetails && (
              <p className="mt-1" style={{ fontSize: '12px', color: 'var(--fg-3)' }}>
                No warehouses found for this counterparty.
              </p>
            )}
          </div>
          {/* Warehouse To — hidden for Sale (B decision: deliver per incoterms) */}
          {opType !== 'sale' && (
            <div>
              <Label>Warehouse To *</Label>
              <select value={warehouseToId} onChange={(e) => setWarehouseToId(e.target.value)} disabled={!isReadyForDetails}
                style={selectStyle}>
                <option value="">— Choose warehouse —</option>
                {warehousesTo.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} — {w.name}{w.country ? ` (${w.country})` : ''}
                  </option>
                ))}
              </select>
              {warehousesTo.length === 0 && isReadyForDetails && (
                <p className="mt-1" style={{ fontSize: '12px', color: 'var(--fg-3)' }}>
                  No warehouses found.
                </p>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* Section 3: Line items — full grid grouped by category */}
      <Section label="Line Items" disabled={!isReadyForDetails}>
        {(() => {
          // Group available products by category. Empty categories are hidden.
          const order = ['Toothpaste', 'Toothbrush', 'Floss', 'Other'] as const;
          const labelMap: Record<string, string> = {
            Toothpaste: 'Toothpastes',
            Toothbrush: 'Toothbrushes',
            Floss: 'Floss',
            Other: 'Other',
          };
          // Show "In stock" column only for sale/transfer (where outgoing
          // warehouse stock matters) AND when a warehouse is selected.
          const showStockColumn = Boolean(warehouseFromId) && opType !== 'purchase';
          const groups = order
            .map((cat) => ({
              cat,
              label: labelMap[cat] ?? cat,
              items: availableProducts.filter((p) => p.category === cat),
            }))
            .filter((g) => g.items.length > 0);

          return (
            <div className="space-y-2">
              {groups.map((g) => {
                const filledInGroup = g.items.filter((p) => (entries[p.id]?.pieces ?? 0) > 0).length;
                const groupSubtotal = g.items.reduce((s, p) => {
                  const e = entries[p.id];
                  if (!e || e.pieces <= 0) return s;
                  return s + e.pieces * e.unit_price;
                }, 0);
                // Auto-expand if any item in this group has pieces filled
                const isOpen = openCategories[g.cat] ?? (filledInGroup > 0);

                return (
                  <div key={g.cat} style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)' }}>
                    <button
                      type="button"
                      onClick={() => setOpenCategories((prev) => ({ ...prev, [g.cat]: !isOpen }))}
                      disabled={!isReadyForDetails}
                      className="w-full px-4 py-3 flex items-center justify-between text-left"
                      style={{
                        backgroundColor: 'var(--paper-sunk)',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '14px',
                        fontWeight: 600,
                        color: 'var(--fg-1)',
                        opacity: !isReadyForDetails ? 0.5 : 1,
                      }}
                    >
                      <span className="inline-flex items-center gap-2">
                        <span style={{ width: '10px', display: 'inline-block', color: 'var(--fg-3)' }}>{isOpen ? '▼' : '▶'}</span>
                        {g.label}
                        <span style={{ color: 'var(--fg-3)', fontWeight: 400, marginLeft: '8px' }}>
                          ({filledInGroup} of {g.items.length})
                        </span>
                      </span>
                      <span style={{ color: 'var(--fg-3)', fontWeight: 400, fontVariantNumeric: 'tabular-nums' }}>
                        {groupSubtotal > 0
                          ? `${formatMoney(groupSubtotal, effectiveCurrency)} ${effectiveCurrency}`
                          : '—'}
                      </span>
                    </button>

                    {isOpen && (
                      <table className="w-full text-sm" style={{ borderCollapse: 'collapse', borderTop: '1px solid var(--border-hairline)' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
                            <Th>SKU</Th>
                            <Th>Name</Th>
                            {showStockColumn && <Th>In stock</Th>}
                            <Th>Pieces</Th>
                            <Th>Cartons</Th>
                            <Th>Price ({effectiveCurrency || '—'})</Th>
                            <Th>Total</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.items.map((p) => {
                            const e = entries[p.id] ?? { pieces: 0, unit_price: 0 };
                            const ctnQty = p.ctn_qty ?? 0;
                            const cartonsDisplay = ctnQty > 0 && e.pieces > 0
                              ? Math.round((e.pieces / ctnQty) * 100) / 100
                              : 0;
                            const lineTotal = e.pieces > 0 && e.unit_price > 0
                              ? Math.round(e.pieces * e.unit_price * 100) / 100
                              : 0;
                            const noPrice = e.unit_price <= 0;

                            return (
                              <tr key={p.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                                <td className="px-3 py-2" style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>
                                  {p.id.toUpperCase()}
                                </td>
                                <td className="px-3 py-2" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
                                  {p.product_name}
                                </td>
                                {showStockColumn && (() => {
                                  const onHand = stockMap[p.id] ?? 0;
                                  const isLow = onHand <= 0;
                                  return (
                                    <td className="px-3 py-2" style={{
                                      fontSize: '14px',
                                      fontWeight: 700,
                                      fontStyle: 'italic',
                                      fontVariantNumeric: 'tabular-nums',
                                      color: isLow ? 'var(--brand-rot)' : 'var(--fg-1)',
                                    }}>
                                      {onHand.toLocaleString('en-US')}
                                    </td>
                                  );
                                })()}
                                <td className="px-3 py-2">
                                  <input
                                    type="number"
                                    value={e.pieces || ''}
                                    onChange={(ev) => {
                                      const v = parseInt(ev.target.value) || 0;
                                      updateEntry(p.id, { pieces: v });
                                      if (v > 0) ensurePriceFor(p.id);
                                    }}
                                    disabled={!isReadyForDetails}
                                    min={0}
                                    placeholder="0"
                                    className="w-24 px-2 py-1 text-sm focus:outline-none text-right"
                                    style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)', fontWeight: 700 }}
                                  />
                                </td>
                                <td className="px-3 py-2">
                                  {ctnQty > 0 ? (
                                    <input
                                      type="text"
                                      inputMode="decimal"
                                      value={cartonsDisplay || ''}
                                      onChange={(ev) => {
                                        const raw = ev.target.value.replace(',', '.').trim();
                                        if (raw === '') { updateEntry(p.id, { pieces: 0 }); return; }
                                        const c = parseFloat(raw);
                                        if (isNaN(c) || c < 0) return;
                                        const newPieces = Math.round(c * ctnQty);
                                        updateEntry(p.id, { pieces: newPieces });
                                        if (newPieces > 0) ensurePriceFor(p.id);
                                      }}
                                      disabled={!isReadyForDetails}
                                      placeholder="0"
                                      className="w-24 px-2 py-1 text-sm focus:outline-none text-right"
                                      style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)', fontWeight: 700 }}
                                    />
                                  ) : (
                                    <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2">
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={e.unit_price || ''}
                                    onChange={(ev) => {
                                      const raw = ev.target.value.replace(',', '.').trim();
                                      if (raw === '') { updateEntry(p.id, { unit_price: 0 }); return; }
                                      const v = parseFloat(raw);
                                      if (isNaN(v) || v < 0) return;
                                      updateEntry(p.id, { unit_price: v });
                                    }}
                                    disabled={!isReadyForDetails}
                                    placeholder={noPrice ? 'no price set' : '0.00'}
                                    className="w-28 px-2 py-1 text-sm focus:outline-none text-right"
                                    style={{
                                      backgroundColor: 'var(--paper-sunk)',
                                      border: '1px solid var(--border-hairline)',
                                      borderRadius: 'var(--radius-xs)',
                                      color: noPrice ? 'var(--fg-3)' : 'var(--fg-1)',
                                      fontWeight: 700,
                                    }}
                                  />
                                </td>
                                <td className="px-3 py-2 text-right" style={{ fontSize: '14px', color: lineTotal > 0 ? 'var(--fg-1)' : 'var(--fg-3)', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                                  {lineTotal > 0
                                    ? `${formatMoney(lineTotal, effectiveCurrency)} ${effectiveCurrency}`
                                    : '0.00'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Discount + Total */}
        <div className="mt-6 pt-4" style={{ borderTop: '1px solid var(--border-hairline)' }}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>Overall discount %</Label>
              <input type="number" value={overallDiscountPct || ''} onChange={(e) => setOverallDiscountPct(parseFloat(e.target.value) || 0)} disabled={!isReadyForDetails} min={0} max={100} step={0.1}
                className="w-24 px-2 py-1 text-sm focus:outline-none text-right"
                style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)' }} />
            </div>
            <div className="text-right">
              <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-3)' }}>Subtotal: {formatMoney(subtotal, effectiveCurrency)} {effectiveCurrency}</div>
              <div className="mt-1" style={{ fontSize: '24px', fontWeight: 700, color: 'var(--fg-1)' }}>
                {formatMoney(grandTotal, effectiveCurrency)} {effectiveCurrency}
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section label="Notes" disabled={!isReadyForDetails}>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={!isReadyForDetails}
          rows={3}
          placeholder="Optional"
          className="w-full px-3 py-2 text-sm focus:outline-none"
          style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}
        />
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
