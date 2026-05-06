'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ChevronRight, Check } from 'lucide-react';
import { createProduct, updateProduct, getManufacturers, type Manufacturer } from '@/lib/api';
import Breadcrumb from '@/components/layout/breadcrumb';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: '14px',
  backgroundColor: 'var(--paper-sunk)',
  border: '1px solid var(--border-hairline)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--fg-1)',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '14px',
  fontWeight: 600,
  color: 'var(--fg-2)',
  marginBottom: '6px',
};

const helperStyle: React.CSSProperties = {
  fontSize: '14px',
  color: 'var(--fg-3)',
  marginTop: '4px',
};

type Category = 'Toothpaste' | 'Toothbrush' | 'Floss' | 'Other';

export default function NewProductPage() {
  const router = useRouter();

  const [step, setStep] = useState<1 | 2>(1);
  const [createdId, setCreatedId] = useState<string>('');

  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [mfrLoading, setMfrLoading] = useState(true);

  // Step 1
  const [id, setId] = useState('');
  const [productName, setProductName] = useState('');
  const [invoiceLabel, setInvoiceLabel] = useState('');
  const [category, setCategory] = useState<Category>('Toothbrush');
  const [manufacturerId, setManufacturerId] = useState('');
  const [barcode, setBarcode] = useState('');
  const [countryOfOrigin, setCountryOfOrigin] = useState('China');

  // Step 2
  const [piecesPerCase, setPiecesPerCase] = useState('12');
  const [ctnQty, setCtnQty] = useState('');
  const [ctnWeight, setCtnWeight] = useState('');
  const [dimL, setDimL] = useState('');
  const [dimW, setDimW] = useState('');
  const [dimH, setDimH] = useState('');
  const [unitNetWeight, setUnitNetWeight] = useState('');
  const [hsCode, setHsCode] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getManufacturers().then((res) => {
      if (res.success && res.result) {
        setManufacturers(res.result.manufacturers);
        if (res.result.manufacturers.length > 0) {
          // Sensible defaults: jinxia for brushes, wdaa for paste, honghui for floss/other
          const jinxia = res.result.manufacturers.find((m) => m.id === 'mfr_jinxia');
          if (jinxia) setManufacturerId(jinxia.id);
        }
      }
      setMfrLoading(false);
    });
  }, []);

  // Auto-suggest manufacturer when category changes
  useEffect(() => {
    if (manufacturers.length === 0) return;
    let preferred: string | undefined;
    if (category === 'Toothpaste') preferred = 'mfr_wdaa';
    else if (category === 'Toothbrush') preferred = 'mfr_jinxia';
    else preferred = 'mfr_honghui';
    if (preferred && manufacturers.some((m) => m.id === preferred)) {
      setManufacturerId(preferred);
    }
  }, [category, manufacturers]);

  async function handleStep1Submit() {
    setError(null);
    if (!id.trim()) { setError('SKU id is required'); return; }
    if (!/^[a-z0-9_-]+$/i.test(id.trim())) { setError('SKU id must be alphanumeric (e.g. de212)'); return; }
    if (!productName.trim()) { setError('Product name is required'); return; }
    if (!invoiceLabel.trim()) { setError('Invoice label is required'); return; }
    if (!manufacturerId) { setError('Manufacturer is required'); return; }

    setSubmitting(true);
    try {
      const res = await createProduct({
        id: id.trim().toLowerCase(),
        product_name: productName.trim(),
        invoice_label: invoiceLabel.trim(),
        category,
        manufacturer_id: manufacturerId,
        barcode: barcode.trim() || null,
        country_of_origin: countryOfOrigin.trim() || null,
      });
      if (res.success && res.result) {
        setCreatedId(res.result.id);
        setStep(2);
      } else {
        setError(res.errors?.[0]?.message ?? 'Failed to create product');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStep2Submit(skipDetails = false) {
    setError(null);
    setSubmitting(true);
    try {
      if (!skipDetails) {
        const numOrNull = (s: string) => {
          const t = s.trim();
          if (!t) return null;
          const n = parseFloat(t);
          return isNaN(n) ? null : n;
        };
        const intOrNull = (s: string) => {
          const t = s.trim();
          if (!t) return null;
          const n = parseInt(t, 10);
          return isNaN(n) ? null : n;
        };

        const res = await updateProduct(createdId, {
          pieces_per_case: parseInt(piecesPerCase, 10) || 1,
          ctn_qty: intOrNull(ctnQty),
          ctn_weight_gross_kg: numOrNull(ctnWeight),
          ctn_dim_l_cm: numOrNull(dimL),
          ctn_dim_w_cm: numOrNull(dimW),
          ctn_dim_h_cm: numOrNull(dimH),
          unit_net_weight_g: numOrNull(unitNetWeight),
          hs_code: hsCode.trim() || null,
        });
        if (!res.success) {
          setError(res.errors?.[0]?.message ?? 'Failed to save details');
          setSubmitting(false);
          return;
        }
      }
      router.push(`/products/${createdId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <Breadcrumb
        items={[
          { label: 'Products', href: '/products' },
          { label: 'New product' },
        ]}
      />

      <div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--fs-display-md)',
            fontWeight: 900,
            color: 'var(--fg-1)',
            marginBottom: '8px',
          }}
        >
          Add Product
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
          {step === 1
            ? 'Step 1 of 2 — identity and manufacturing'
            : 'Step 2 of 2 — carton and specifications (optional)'}
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-3" style={{ fontSize: '14px' }}>
        <StepBadge active={step === 1} done={step > 1} number={1} label="Identity" />
        <ChevronRight className="h-4 w-4" style={{ color: 'var(--fg-3)' }} />
        <StepBadge active={step === 2} done={false} number={2} label="Carton" />
      </div>

      {error && (
        <div
          style={{
            padding: '12px 16px',
            backgroundColor: '#FBE9E9',
            border: '1px solid #E5B3B3',
            borderRadius: 'var(--radius-sm)',
            color: '#A32D2D',
            fontSize: '14px',
          }}
        >
          {error}
        </div>
      )}

      {/* === Step 1 === */}
      {step === 1 && (
        <div
          className="p-6 space-y-5"
          style={{
            backgroundColor: 'var(--paper)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <div>
            <label style={labelStyle}>SKU id *</label>
            <input
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="e.g. de212"
              style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
              disabled={submitting}
            />
            <div style={helperStyle}>Unique identifier. Lowercase, alphanumeric. Example: de212.</div>
          </div>

          <div>
            <label style={labelStyle}>Product name *</label>
            <input
              type="text"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder="e.g. SCHWARZ Brush"
              style={inputStyle}
              disabled={submitting}
            />
            <div style={helperStyle}>Short marketing name shown in catalog and tables.</div>
          </div>

          <div>
            <label style={labelStyle}>Invoice label *</label>
            <input
              type="text"
              value={invoiceLabel}
              onChange={(e) => setInvoiceLabel(e.target.value)}
              placeholder="e.g. toothbrush Das Experten SCHWARZ 1pc."
              style={inputStyle}
              disabled={submitting}
            />
            <div style={helperStyle}>Long descriptive name used on invoices and customs documents.</div>
          </div>

          <div className="grid grid-cols-2 gap-5">
            <div>
              <label style={labelStyle}>Category *</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
                style={inputStyle}
                disabled={submitting}
              >
                <option value="Toothbrush">Toothbrush</option>
                <option value="Toothpaste">Toothpaste</option>
                <option value="Floss">Floss</option>
                <option value="Other">Other</option>
              </select>
            </div>

            <div>
              <label style={labelStyle}>Manufacturer *</label>
              <select
                value={manufacturerId}
                onChange={(e) => setManufacturerId(e.target.value)}
                style={inputStyle}
                disabled={submitting || mfrLoading}
              >
                {mfrLoading && <option>Loading…</option>}
                {!mfrLoading && manufacturers.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-5">
            <div>
              <label style={labelStyle}>Barcode</label>
              <input
                type="text"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                placeholder="e.g. 6913362820022"
                style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
                disabled={submitting}
              />
            </div>

            <div>
              <label style={labelStyle}>Country of origin</label>
              <input
                type="text"
                value={countryOfOrigin}
                onChange={(e) => setCountryOfOrigin(e.target.value)}
                placeholder="China"
                style={inputStyle}
                disabled={submitting}
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => router.push('/products')}
              disabled={submitting}
              style={{
                padding: '10px 20px',
                fontSize: '14px',
                backgroundColor: 'transparent',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--fg-2)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleStep1Submit}
              disabled={submitting}
              style={{
                padding: '10px 24px',
                fontSize: '14px',
                fontWeight: 600,
                backgroundColor: 'var(--brand-rot)',
                color: 'var(--paper)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Continue to carton details
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* === Step 2 === */}
      {step === 2 && (
        <div
          className="p-6 space-y-5"
          style={{
            backgroundColor: 'var(--paper)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <div
            style={{
              padding: '12px 16px',
              backgroundColor: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '14px',
              color: 'var(--fg-2)',
            }}
          >
            <span style={{ fontWeight: 600 }}>SKU {createdId.toUpperCase()} created.</span> Add carton and packaging details below, or skip and fill in later.
          </div>

          <div className="grid grid-cols-2 gap-5">
            <div>
              <label style={labelStyle}>Pieces per inner box</label>
              <input
                type="number"
                value={piecesPerCase}
                onChange={(e) => setPiecesPerCase(e.target.value)}
                placeholder="12"
                style={inputStyle}
                disabled={submitting}
              />
            </div>

            <div>
              <label style={labelStyle}>Carton qty (CTN)</label>
              <input
                type="number"
                value={ctnQty}
                onChange={(e) => setCtnQty(e.target.value)}
                placeholder="288"
                style={inputStyle}
                disabled={submitting}
              />
              <div style={helperStyle}>Total units per carton.</div>
            </div>
          </div>

          <div>
            <label style={labelStyle}>Carton dimensions (L × W × H, cm)</label>
            <div className="grid grid-cols-3 gap-3">
              <input
                type="number"
                step="0.1"
                value={dimL}
                onChange={(e) => setDimL(e.target.value)}
                placeholder="L (e.g. 41)"
                style={inputStyle}
                disabled={submitting}
              />
              <input
                type="number"
                step="0.1"
                value={dimW}
                onChange={(e) => setDimW(e.target.value)}
                placeholder="W (e.g. 38)"
                style={inputStyle}
                disabled={submitting}
              />
              <input
                type="number"
                step="0.1"
                value={dimH}
                onChange={(e) => setDimH(e.target.value)}
                placeholder="H (e.g. 25)"
                style={inputStyle}
                disabled={submitting}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-5">
            <div>
              <label style={labelStyle}>Carton weight gross (kg)</label>
              <input
                type="number"
                step="0.01"
                value={ctnWeight}
                onChange={(e) => setCtnWeight(e.target.value)}
                placeholder="9.0"
                style={inputStyle}
                disabled={submitting}
              />
            </div>

            <div>
              <label style={labelStyle}>Unit net weight (g)</label>
              <input
                type="number"
                step="0.1"
                value={unitNetWeight}
                onChange={(e) => setUnitNetWeight(e.target.value)}
                placeholder="25.0"
                style={inputStyle}
                disabled={submitting}
              />
            </div>
          </div>

          <div>
            <label style={labelStyle}>HS code</label>
            <input
              type="text"
              value={hsCode}
              onChange={(e) => setHsCode(e.target.value)}
              placeholder="e.g. 9603210000"
              style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
              disabled={submitting}
            />
            <div style={helperStyle}>Customs harmonized system code.</div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => handleStep2Submit(true)}
              disabled={submitting}
              style={{
                padding: '10px 20px',
                fontSize: '14px',
                backgroundColor: 'transparent',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--fg-2)',
                cursor: 'pointer',
              }}
            >
              Skip and finish
            </button>
            <button
              onClick={() => handleStep2Submit(false)}
              disabled={submitting}
              style={{
                padding: '10px 24px',
                fontSize: '14px',
                fontWeight: 600,
                backgroundColor: 'var(--brand-rot)',
                color: 'var(--paper)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              <Check className="h-4 w-4" />
              Save and finish
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StepBadge({ active, done, number, label }: { active: boolean; done: boolean; number: number; label: string }) {
  const bg = done ? 'var(--brand-rot)' : active ? 'var(--fg-1)' : 'var(--paper-sunk)';
  const fg = done || active ? 'var(--paper)' : 'var(--fg-3)';
  return (
    <div className="inline-flex items-center gap-2">
      <div
        style={{
          width: '24px',
          height: '24px',
          borderRadius: '50%',
          backgroundColor: bg,
          color: fg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '14px',
          fontWeight: 700,
        }}
      >
        {done ? <Check className="h-3 w-3" /> : number}
      </div>
      <span style={{ fontWeight: active || done ? 600 : 400, color: active || done ? 'var(--fg-1)' : 'var(--fg-3)' }}>
        {label}
      </span>
    </div>
  );
}
