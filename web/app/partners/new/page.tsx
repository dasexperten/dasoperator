'use client';

export const runtime = 'edge';



import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ChevronRight, Check } from 'lucide-react';
import { createPartner, updatePartner } from '@/lib/api';
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

export default function NewPartnerPage() {
  const router = useRouter();

  const [step, setStep] = useState<1 | 2>(1);
  const [partnerSlug, setPartnerSlug] = useState<string>('');

  // Step 1 state
  const [tradeName, setTradeName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [country, setCountry] = useState('');
  const [partnerType, setPartnerType] = useState<'buyer' | 'supplier' | 'shipper' | 'other'>('buyer');
  const [partnerLanguage, setPartnerLanguage] = useState<'EN' | 'RU' | 'EN-RU' | 'EN-AR' | 'EN-VI' | 'EN-ZH'>('EN');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');

  // Step 2 state
  const [iban, setIban] = useState('');
  const [swiftBic, setSwiftBic] = useState('');
  const [bankName, setBankName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [inn, setInn] = useState('');
  const [kpp, setKpp] = useState('');
  const [ogrn, setOgrn] = useState('');
  const [legalNameLocal, setLegalNameLocal] = useState('');
  const [registeredAddressLocal, setRegisteredAddressLocal] = useState('');
  const [preferredIncoterms, setPreferredIncoterms] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 submit — creates Lead and advances to Step 2
  async function handleStep1Submit() {
    setError(null);
    if (!tradeName.trim()) {
      setError('Trade name is required');
      return;
    }
    setSubmitting(true);
    try {
      const res = await createPartner({
        trade_name: tradeName.trim(),
        partner_type: partnerType,
        partner_language: partnerLanguage,
        legal_name: legalName.trim() || null,
        country: country.trim() || null,
        email: email.trim() || null,
        notes: notes.trim() || null,
      });
      if (res.success && res.result) {
        setPartnerSlug(res.result.id);
        setStep(2);
      } else {
        setError(res.errors?.[0]?.message ?? 'Failed to create partner');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  // Step 2 submit — patches additional fields, then redirects
  async function handleStep2Submit() {
    setError(null);
    setSubmitting(true);
    try {
      const patch: Record<string, string | null> = {};
      if (iban.trim()) patch.iban = iban.trim();
      if (swiftBic.trim()) patch.swift_bic = swiftBic.trim();
      if (bankName.trim()) patch.bank_name = bankName.trim();
      if (taxId.trim()) patch.tax_id = taxId.trim();
      if (inn.trim()) patch.inn = inn.trim();
      if (kpp.trim()) patch.kpp = kpp.trim();
      if (ogrn.trim()) patch.ogrn = ogrn.trim();
      if (legalNameLocal.trim()) patch.legal_name_local = legalNameLocal.trim();
      if (registeredAddressLocal.trim()) patch.registered_address_local = registeredAddressLocal.trim();
      if (preferredIncoterms.trim()) patch.preferred_incoterms = preferredIncoterms.trim();
      if (paymentTerms.trim()) patch.payment_terms = paymentTerms.trim();

      if (Object.keys(patch).length > 0) {
        await updatePartner(partnerSlug, patch);
      }
      router.push(`/partners/${partnerSlug}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  function skipStep2() {
    router.push(`/partners/${partnerSlug}`);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <Breadcrumb items={[
        { label: 'Partners', href: '/partners' },
        { label: 'New Partner' },
      ]} />

      <div>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'var(--fs-display-md)',
          fontWeight: 900,
          color: 'var(--fg-1)',
        }}>
          {step === 1 ? 'New Partner' : 'Complete Profile'}
        </h1>
        <p className="mt-2" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
          {step === 1
            ? 'Step 1 of 2 — basic info. Partner will be created as Lead.'
            : 'Step 2 of 2 — banking and tax details. All optional, can be added later.'}
        </p>
      </div>

      {/* Step indicator */}
      <div className="dx-stepper flex items-center gap-3" style={{ flexWrap: 'nowrap', overflow: 'hidden' }}>
        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          <div style={{
            width: 28, height: 28,
            borderRadius: '50%',
            backgroundColor: step === 1 ? 'var(--brand-rot)' : 'var(--status-success)',
            color: 'var(--paper)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '14px', fontWeight: 700,
            flexShrink: 0,
          }}>
            {step > 1 ? <Check className="h-3.5 w-3.5" /> : '1'}
          </div>
          <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', whiteSpace: 'nowrap' }}>Basics</span>
        </div>
        <ChevronRight className="h-4 w-4" style={{ color: 'var(--fg-muted)', flexShrink: 0 }} />
        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          <div style={{
            width: 28, height: 28,
            borderRadius: '50%',
            backgroundColor: step === 2 ? 'var(--brand-rot)' : 'var(--paper-sunk)',
            color: step === 2 ? 'var(--paper)' : 'var(--fg-3)',
            border: step === 2 ? 'none' : '1px solid var(--border-hairline)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '14px', fontWeight: 700,
            flexShrink: 0,
          }}>
            2
          </div>
          <span style={{ fontSize: '14px', fontWeight: 700, color: step === 2 ? 'var(--fg-1)' : 'var(--fg-3)', whiteSpace: 'nowrap' }}>
            Banking & Tax
          </span>
        </div>
      </div>

      <div className="dx-ribbon-rule" />

      {step === 1 && (
        <Section label="Basic Info">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Trade name *</Label>
              <input type="text" value={tradeName} onChange={(e) => setTradeName(e.target.value)}
                placeholder="e.g. Acme Trading"
                style={inputStyle} />
            </div>
            <div>
              <Label>Legal name</Label>
              <input type="text" value={legalName} onChange={(e) => setLegalName(e.target.value)}
                placeholder="Full legal entity name"
                style={inputStyle} />
            </div>
            <div>
              <Label>Country</Label>
              <input type="text" value={country} onChange={(e) => setCountry(e.target.value)}
                placeholder="e.g. Germany"
                style={inputStyle} />
            </div>
            <div>
              <Label>Partner type *</Label>
              <select value={partnerType} onChange={(e) => setPartnerType(e.target.value as typeof partnerType)} style={inputStyle}>
                <option value="buyer">Buyer</option>
                <option value="supplier">Supplier</option>
                <option value="shipper">Shipper</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="col-span-2">
              <Label>Partner language *</Label>
              <select value={partnerLanguage} onChange={(e) => setPartnerLanguage(e.target.value as typeof partnerLanguage)} style={inputStyle}>
                <option value="EN">English</option>
                <option value="RU">Русский</option>
                <option value="EN-RU">English + Русский</option>
                <option value="EN-AR">English + العربية</option>
                <option value="EN-VI">English + Tiếng Việt</option>
                <option value="EN-ZH">English + 中文</option>
              </select>
              <p className="mt-1" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
                Applies to all outbound documents and communication: invoices, packing lists, contracts, NDAs, emails.
              </p>
            </div>
            <div className="col-span-2">
              <Label>Contact email</Label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="contact@partner.com"
                style={inputStyle} />
            </div>
            <div className="col-span-2">
              <Label>Notes</Label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
                placeholder="How we found them, first contact context, anything useful"
                style={inputStyle} />
            </div>
          </div>

          <div className="mt-6 p-4" style={{
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '14px',
            color: 'var(--fg-2)',
          }}>
            <strong style={{ color: 'var(--fg-1)' }}>Note:</strong> Partner will be created as <strong>Lead</strong>.
            They will not see prices in any export until at least one signed agreement (NDA, MOU, LOI, or Contract)
            is recorded against them.
          </div>
        </Section>
      )}

      {step === 2 && (
        <>
          <Section label="Banking">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>IBAN</Label>
                <input type="text" value={iban} onChange={(e) => setIban(e.target.value)}
                  placeholder="DE89 3704 0044 0532 0130 00" style={inputStyle} />
              </div>
              <div>
                <Label>SWIFT / BIC</Label>
                <input type="text" value={swiftBic} onChange={(e) => setSwiftBic(e.target.value)}
                  placeholder="COBADEFFXXX" style={inputStyle} />
              </div>
              <div className="col-span-2">
                <Label>Bank name</Label>
                <input type="text" value={bankName} onChange={(e) => setBankName(e.target.value)}
                  placeholder="Commerzbank AG" style={inputStyle} />
              </div>
            </div>
          </Section>

          <Section label="Tax & Registration">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Tax ID</Label>
                <input type="text" value={taxId} onChange={(e) => setTaxId(e.target.value)}
                  placeholder="VAT or local tax registration" style={inputStyle} />
              </div>
              <div>
                <Label>INN (RU only)</Label>
                <input type="text" value={inn} onChange={(e) => setInn(e.target.value)}
                  placeholder="10 or 12 digits" style={inputStyle} />
              </div>
              <div>
                <Label>KPP (RU only)</Label>
                <input type="text" value={kpp} onChange={(e) => setKpp(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <Label>OGRN (RU only)</Label>
                <input type="text" value={ogrn} onChange={(e) => setOgrn(e.target.value)} style={inputStyle} />
              </div>
              <div className="col-span-2">
                <Label>Legal name (local script)</Label>
                <input type="text" value={legalNameLocal} onChange={(e) => setLegalNameLocal(e.target.value)}
                  placeholder="Cyrillic / Chinese / Arabic legal name" style={inputStyle} />
              </div>
              <div className="col-span-2">
                <Label>Registered address (local script)</Label>
                <input type="text" value={registeredAddressLocal}
                  onChange={(e) => setRegisteredAddressLocal(e.target.value)}
                  placeholder="Full registered address" style={inputStyle} />
              </div>
            </div>
          </Section>

          <Section label="Trade Preferences">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="col-span-2">
                <Label>Preferred incoterms</Label>
                <input type="text" value={preferredIncoterms}
                  onChange={(e) => setPreferredIncoterms(e.target.value)}
                  placeholder="FCA Saransk / DAP Frankfurt" style={inputStyle} />
              </div>
              <div className="col-span-2">
                <Label>Payment terms</Label>
                <input type="text" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)}
                  placeholder="50% advance / 50% before shipment" style={inputStyle} />
              </div>
            </div>
          </Section>
        </>
      )}

      {error && (
        <div className="p-3" style={{
          backgroundColor: 'rgba(229,32,44,0.05)',
          border: '1px solid rgba(229,32,44,0.2)',
          color: 'var(--brand-rot)',
          borderRadius: 'var(--radius-sm)',
          fontSize: '14px',
        }}>
          {error}
        </div>
      )}

      <div className="flex gap-3">
        {step === 1 ? (
          <>
            <button onClick={() => router.back()}
              className="px-4 py-2"
              style={{
                border: '1px solid var(--border-hairline)',
                backgroundColor: 'transparent',
                borderRadius: 'var(--radius-sm)',
                fontSize: '14px',
                color: 'var(--fg-1)',
              }}>
              Cancel
            </button>
            <button onClick={handleStep1Submit} disabled={submitting || !tradeName.trim()}
              className="px-4 py-2 inline-flex items-center gap-2"
              style={{
                backgroundColor: 'var(--brand-rot)', color: 'var(--paper)',
                borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 600,
                opacity: (submitting || !tradeName.trim()) ? 0.5 : 1,
                cursor: (submitting || !tradeName.trim()) ? 'not-allowed' : 'pointer',
              }}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Continue to Banking <ChevronRight className="h-4 w-4" />
            </button>
          </>
        ) : (
          <>
            <button onClick={skipStep2}
              className="px-4 py-2"
              style={{
                border: '1px solid var(--border-hairline)',
                backgroundColor: 'transparent',
                borderRadius: 'var(--radius-sm)',
                fontSize: '14px',
                color: 'var(--fg-2)',
              }}>
              Skip — finish later
            </button>
            <button onClick={handleStep2Submit} disabled={submitting}
              className="px-4 py-2 inline-flex items-center gap-2"
              style={{
                backgroundColor: 'var(--brand-rot)', color: 'var(--paper)',
                borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 600,
                opacity: submitting ? 0.5 : 1,
                cursor: submitting ? 'not-allowed' : 'pointer',
              }}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Save & Open Partner
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-card p-5" style={{
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-md)',
    }}>
      <h2 style={{
        fontFamily: 'var(--font-display)',
        fontSize: '16px',
        fontWeight: 700,
        color: 'var(--fg-1)',
        marginBottom: '16px',
        textTransform: 'uppercase',
        letterSpacing: '0',
      }}>
        {label}
      </h2>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="block mb-1" style={{
      fontSize: '14px',
      color: 'var(--fg-3)',
    }}>
      {children}
    </label>
  );
}
