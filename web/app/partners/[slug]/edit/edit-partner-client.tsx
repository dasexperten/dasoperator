'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Save, X } from 'lucide-react';
import { getPartner, updatePartner, type Partner, type UpdatePartnerBody } from '@/lib/api';
import Breadcrumb from '@/components/layout/breadcrumb';

// =============================================================================
// /partners/[slug]/edit — edit partner form (Phase 7.3)
// Covers the most-used fields. Trade name is read-only (changing it would
// detach the slug from history). Abbreviation is the new addition for
// contract filenames in R2.
// =============================================================================

const PARTNER_TYPES = ['buyer', 'supplier', 'shipper', 'other'] as const;
const LANGS = ['EN', 'RU', 'EN-RU', 'EN-AR', 'EN-VI', 'EN-ZH'] as const;

// Document render mode — three options aligned with the issuer-first model:
//   EN        → render in issuer's primary language only (default for international)
//   LOCAL     → render in partner's local language only (rare; partner explicitly asks)
//   BILINGUAL → render in issuer's language + partner's local language
// Three render-mode options. Database CHECK constraint accepts only these four
// values: NULL (issuer default), 'EN', 'RU', 'BILINGUAL'. We surface three
// semantic options to the user; 'RU' is a legacy override no longer offered.
const INVOICE_MODES = [
  { value: 'EN',        label: 'English only' },
  { value: 'BILINGUAL', label: 'English + national language (bilingual)' },
] as const;

// ISO codes of national languages — used when render mode is LOCAL or BILINGUAL
const PARTNER_LOCAL_LANGUAGES = [
  { value: 'EN', label: 'English' },
  { value: 'RU', label: 'Russian (Русский)' },
  { value: 'KA', label: 'Georgian (ქართული)' },
  { value: 'ZH', label: 'Chinese (中文)' },
  { value: 'VI', label: 'Vietnamese (Tiếng Việt)' },
  { value: 'AM', label: 'Armenian (Հայերեն)' },
  { value: 'UK', label: 'Ukrainian (Українська)' },
  { value: 'DE', label: 'German (Deutsch)' },
  { value: 'TR', label: 'Turkish (Türkçe)' },
  { value: 'UZ', label: "Uzbek (O'zbek)" },
  { value: 'KK', label: 'Kazakh (Қазақша)' },
  { value: 'TH', label: 'Thai (ไทย)' },
  { value: 'ID', label: 'Indonesian (Bahasa Indonesia)' },
  { value: 'MS', label: 'Malay (Bahasa Melayu)' },
  { value: 'HI', label: 'Hindi (हिन्दी)' },
  { value: 'AR', label: 'Arabic (العربية)' },
  { value: 'FR', label: 'French (Français)' },
  { value: 'ES', label: 'Spanish (Español)' },
  { value: 'PT', label: 'Portuguese (Português)' },
] as const;

type FormState = {
  trade_name: string;
  abbreviation: string;
  legal_name: string;
  legal_name_local: string;
  registered_address_local: string;
  country: string;
  email: string;
  partner_type: typeof PARTNER_TYPES[number];
  partner_language: typeof LANGS[number];
  preferred_invoice_language: 'EN' | 'BILINGUAL' | '';
  partner_local_language: typeof PARTNER_LOCAL_LANGUAGES[number]['value'] | '';
  preferred_incoterms: string;
  payment_terms: string;
  iban: string;
  swift_bic: string;
  bank_name: string;
  tax_id: string;
  inn: string;
  kpp: string;
  ogrn: string;
  notes: string;
};

function partnerToForm(p: Partner): FormState {
  return {
    trade_name: p.trade_name ?? '',
    abbreviation: p.abbreviation ?? '',
    legal_name: p.legal_name ?? '',
    legal_name_local: p.legal_name_local ?? '',
    registered_address_local: p.registered_address_local ?? '',
    country: p.country ?? '',
    email: p.email ?? '',
    partner_type: p.partner_type ?? 'other',
    partner_language: (p.partner_language as FormState['partner_language']) ?? 'EN',
    preferred_invoice_language: (p.preferred_invoice_language as FormState['preferred_invoice_language']) ?? '',
    partner_local_language: ((p as { partner_local_language?: string }).partner_local_language as FormState['partner_local_language']) ?? '',
    preferred_incoterms: p.preferred_incoterms ?? '',
    payment_terms: p.payment_terms ?? '',
    iban: p.iban ?? '',
    swift_bic: p.swift_bic ?? '',
    bank_name: p.bank_name ?? '',
    tax_id: p.tax_id ?? '',
    inn: p.inn ?? '',
    kpp: p.kpp ?? '',
    ogrn: p.ogrn ?? '',
    notes: p.notes ?? '',
  };
}

function diffForUpdate(initial: FormState, current: FormState): UpdatePartnerBody {
  const body: UpdatePartnerBody = {};
  for (const key of Object.keys(current) as (keyof FormState)[]) {
    if (initial[key] !== current[key]) {
      const value = current[key];
      // Convert empty string to null for optional/nullable fields
      const normalized = value === '' ? null : value;
      // Type assertion: keys overlap between FormState and UpdatePartnerBody
      (body as Record<string, unknown>)[key] = normalized;
    }
  }
  return body;
}

export default function EditPartnerClient({ slug }: { slug: string }) {
  const router = useRouter();
  const [partner, setPartner] = useState<Partner | null>(null);
  const [initial, setInitial] = useState<FormState | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      try {
        const res = await getPartner(slug);
        if (!res.success || !res.result) {
          setError(res.errors[0]?.message ?? 'Partner not found');
          return;
        }
        setPartner(res.result);
        const formState = partnerToForm(res.result);
        setInitial(formState);
        setForm({ ...formState });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    })();
  }, [slug]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    if (fieldErrors[key]) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  function validateAbbreviation(v: string): string | null {
    if (v === '') return null;
    if (!/^[A-Z]{2,6}$/.test(v)) return 'Must be 2-6 uppercase letters A–Z';
    return null;
  }

  async function handleSave() {
    if (!form || !initial) return;
    setError(null);

    // Pre-validate abbreviation client-side
    const abbrErr = validateAbbreviation(form.abbreviation);
    if (abbrErr) {
      setFieldErrors({ abbreviation: abbrErr });
      return;
    }

    const diff = diffForUpdate(initial, form);
    if (Object.keys(diff).length === 0) {
      setError('No changes to save');
      return;
    }

    setSaving(true);
    try {
      const res = await updatePartner(slug, diff);
      if (!res.success) {
        setError(res.errors[0]?.message ?? 'Update failed');
        // Surface field-level issues if any
        const issues = res.errors[0]?.details as { issues?: { path: (string | number)[]; message: string }[] } | undefined;
        if (issues?.issues) {
          const fe: Record<string, string> = {};
          for (const i of issues.issues) {
            const k = String(i.path[0] ?? '');
            if (k) fe[k] = i.message;
          }
          setFieldErrors(fe);
        }
        return;
      }
      router.push(`/partners/${slug}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
      </div>
    );
  }

  if (!partner || !form) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Breadcrumb items={[
          { label: 'Partners', href: '/partners' },
          { label: 'Not found' },
        ]} />
        <div className="p-4" style={{ fontSize: '14px', backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          {error ?? 'Partner not found'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-3xl">
      <Breadcrumb items={[
        { label: 'Partners', href: '/partners' },
        { label: partner.trade_name, href: `/partners/${slug}` },
        { label: 'Edit' },
      ]} />

      <div>
        <h1 style={{ fontSize: '36px', color: 'var(--fg-1)', lineHeight: 1.1 }}>Edit Partner</h1>
        <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          {partner.trade_name} <span style={{ color: 'var(--fg-3)' }}>({slug})</span>
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      {/* Identity & Code */}
      <FormSection title="Identity">
        <Field label="Trade Name" hint="Friendly name used internally. URL slug stays unchanged.">
          <input
            type="text"
            value={form.trade_name}
            onChange={(e) => update('trade_name', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field
          label="Abbreviation (2-6 letters)"
          hint="Used in contract filenames: <ENTITY>-<ABBR>-<DATE>.pdf — e.g. DEE-LETU-2024-03-15.pdf"
          error={fieldErrors.abbreviation}
        >
          <input
            type="text"
            value={form.abbreviation}
            onChange={(e) => update('abbreviation', e.target.value.toUpperCase().slice(0, 6))}
            maxLength={6}
            placeholder="LETU"
            style={{ ...inputStyle, fontWeight: 700, letterSpacing: 0, textTransform: 'uppercase' }}
          />
        </Field>
        <Field
          label="Legal Name (English / Latin)"
          hint={partner.legal_name ? 'Locked — sourced from bank operation. Contact ops to change.' : 'Will lock once filled from a banking operation.'}
        >
          <input
            type="text"
            value={form.legal_name}
            onChange={(e) => update('legal_name', e.target.value)}
            readOnly={!!partner.legal_name}
            disabled={!!partner.legal_name}
            style={partner.legal_name ? inputDisabled : inputStyle}
          />
        </Field>
        <Field
          label="Legal Name (Local script)"
          hint={partner.legal_name_local ? 'Locked — sourced from bank operation. Contact ops to change.' : 'Will lock once filled from a banking operation.'}
        >
          <input
            type="text"
            value={form.legal_name_local}
            onChange={(e) => update('legal_name_local', e.target.value)}
            readOnly={!!partner.legal_name_local}
            disabled={!!partner.legal_name_local}
            style={partner.legal_name_local ? inputDisabled : inputStyle}
          />
        </Field>
        <Field label="Registered Address (Local)">
          <input
            type="text"
            value={form.registered_address_local}
            onChange={(e) => update('registered_address_local', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Country">
          <input
            type="text"
            value={form.country}
            onChange={(e) => update('country', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={form.email}
            onChange={(e) => update('email', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Partner Type">
          <select
            value={form.partner_type}
            onChange={(e) => update('partner_type', e.target.value as FormState['partner_type'])}
            style={inputStyle}
          >
            {PARTNER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Partner Language">
          <select
            value={form.partner_language}
            onChange={(e) => update('partner_language', e.target.value as FormState['partner_language'])}
            style={inputStyle}
          >
            {LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </Field>
      </FormSection>

      {/* Banking */}
      <FormSection title="Banking">
        <Field label="IBAN">
          <input
            type="text"
            value={form.iban}
            onChange={(e) => update('iban', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="SWIFT / BIC">
          <input
            type="text"
            value={form.swift_bic}
            onChange={(e) => update('swift_bic', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="Bank Name">
          <input
            type="text"
            value={form.bank_name}
            onChange={(e) => update('bank_name', e.target.value)}
            style={inputStyle}
          />
        </Field>
      </FormSection>

      {/* Tax / Registry IDs */}
      <FormSection title="Tax & Registry">
        <Field label="Tax ID (Generic)">
          <input
            type="text"
            value={form.tax_id}
            onChange={(e) => update('tax_id', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="ИНН (INN)">
          <input
            type="text"
            value={form.inn}
            onChange={(e) => update('inn', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="КПП (KPP)">
          <input
            type="text"
            value={form.kpp}
            onChange={(e) => update('kpp', e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="ОГРН (OGRN)">
          <input
            type="text"
            value={form.ogrn}
            onChange={(e) => update('ogrn', e.target.value)}
            style={inputStyle}
          />
        </Field>
      </FormSection>

      {/* Commercial */}
      <FormSection title="Commercial">
        <Field label="Preferred Incoterms">
          <input
            type="text"
            value={form.preferred_incoterms}
            onChange={(e) => update('preferred_incoterms', e.target.value)}
            placeholder="DAP, FCA, EXW…"
            style={inputStyle}
          />
        </Field>
        <Field label="Payment Terms">
          <input
            type="text"
            value={form.payment_terms}
            onChange={(e) => update('payment_terms', e.target.value)}
            placeholder="50% advance, 50% on delivery"
            style={inputStyle}
          />
        </Field>
        <Field label="Document language mode">
          <select
            value={form.preferred_invoice_language}
            onChange={(e) => update('preferred_invoice_language', e.target.value as FormState['preferred_invoice_language'])}
            style={inputStyle}
          >
            <option value="">— use issuer default —</option>
            {INVOICE_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Partner's national language">
          <select
            value={form.partner_local_language}
            onChange={(e) => update('partner_local_language', e.target.value as FormState['partner_local_language'])}
            style={inputStyle}
          >
            <option value="">— not set —</option>
            {PARTNER_LOCAL_LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </Field>
      </FormSection>

      {/* Notes */}
      <FormSection title="Notes">
        <Field label="Notes">
          <textarea
            value={form.notes}
            onChange={(e) => update('notes', e.target.value)}
            rows={4}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </Field>
      </FormSection>

      {/* Actions */}
      {error && (
        <div className="p-3" style={{
          fontSize: '14px',
          backgroundColor: 'rgba(229,32,44,0.05)',
          border: '1px solid rgba(229,32,44,0.2)',
          color: 'var(--brand-rot)',
          borderRadius: 'var(--radius-sm)',
        }}>{error}</div>
      )}

      <div className="flex items-center gap-3 pt-2 pb-12">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2"
          style={{
            fontSize: '14px',
            fontWeight: 700,
            backgroundColor: 'var(--brand-schwarz)',
            color: 'var(--fg-on-brand)',
            border: '1px solid var(--brand-schwarz)',
            borderRadius: 'var(--radius-sm)',
            cursor: saving ? 'wait' : 'pointer',
          }}
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          Save Changes
        </button>
        <button
          type="button"
          onClick={() => router.push(`/partners/${slug}`)}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2"
          style={{
            fontSize: '14px',
            backgroundColor: 'var(--paper-raised)',
            color: 'var(--fg-1)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
            cursor: saving ? 'wait' : 'pointer',
          }}
        >
          <X size={16} /> Cancel
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Subcomponents
// =============================================================================

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-4" style={{
        fontSize: '14px',
        textTransform: 'uppercase',
        letterSpacing: 0,
        color: 'var(--fg-3)',
        fontWeight: 700,
      }}>{title}</h2>
      <div className="grid grid-cols-2 gap-4">
        {children}
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span style={{ fontSize: '14px', color: 'var(--fg-2)', fontWeight: 600 }}>{label}</span>
      {children}
      {hint && !error && (
        <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{hint}</span>
      )}
      {error && (
        <span style={{ fontSize: '14px', color: 'var(--brand-rot)', fontWeight: 600 }}>{error}</span>
      )}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  fontSize: '14px',
  fontWeight: 700,
  padding: '8px 10px',
  border: '1px solid var(--border-hairline)',
  borderRadius: 'var(--radius-sm)',
  backgroundColor: 'var(--paper-raised)',
  color: 'var(--fg-1)',
};

const inputDisabled: React.CSSProperties = {
  ...inputStyle,
  backgroundColor: 'var(--paper-sunk)',
  color: 'var(--fg-3)',
  cursor: 'not-allowed',
};
