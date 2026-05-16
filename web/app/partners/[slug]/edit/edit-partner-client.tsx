'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Save, X, Plus } from 'lucide-react';
import { getPartner, updatePartner, type Partner, type UpdatePartnerBody } from '@/lib/api';
import { COUNTRIES } from '@/lib/countries';
import Breadcrumb from '@/components/layout/breadcrumb';

// =============================================================================
// /partners/[slug]/edit — edit partner form (Phase 7.3)
// Covers the most-used fields. Trade name is read-only (changing it would
// detach the slug from history). Abbreviation is the new addition for
// contract filenames in R2.
// =============================================================================

const PARTNER_KINDS = [
  { value: 'buyer',            label: 'Buyer (клиент)' },
  { value: 'manufacturer',     label: 'Manufacturer (фабрика)' },
  { value: 'service_provider', label: 'Service Provider (услуги: банк, ФНС, ИП, etc)' },
  { value: '3pl',              label: '3PL (склад / fulfillment)' },
  { value: 'shipper',          label: 'Shipper (логистика)' },
  { value: 'other',            label: 'Other' },
] as const;
const LANGS = ['EN', 'RU', 'EN-RU', 'EN-AR', 'EN-VI', 'EN-ZH'] as const;

// Document render mode — three options aligned with the issuer-first model:
//   EN        → render in issuer's primary language only (default for international)
//   LOCAL     → render in partner's local language only (rare; partner explicitly asks)
//   BILINGUAL → render in issuer's language + partner's local language
// Three render-mode options. Database CHECK constraint accepts only these four
// values: NULL (issuer default), 'EN', 'RU', 'BILINGUAL'. We surface three
// semantic options to the user; 'RU' is a legacy override no longer offered.
// Stored values in DB CHECK: 'EN' | 'RU' | 'BILINGUAL' | NULL.
// We reuse legacy 'RU' as a generic "partner's national language only" value —
// renderer reads partner.partner_local_language to know which language that is.
const INVOICE_MODES = [
  { value: 'RU',        label: 'Partner national language only' },
  { value: 'BILINGUAL', label: 'English + national language (bilingual)' },
  { value: 'EN',        label: 'English only' },
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
  kind: typeof PARTNER_KINDS[number]['value'];
  partner_language: typeof LANGS[number];
  preferred_invoice_language: 'EN' | 'RU' | 'BILINGUAL' | '';
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
  acceptance_required: boolean;
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
    kind: (p.kind as FormState['kind']) ?? 'other',
    partner_language: (p.partner_language as FormState['partner_language']) ?? 'EN',
    // For service_provider / 3pl / shipper / other partners, default to 'RU' (partner's national
    // language) since service documents are usually in the partner's language (банковские, ФНС, etc).
    // For manufacturer/buyer partners, leave default empty ('use issuer default').
    preferred_invoice_language: (
      (p.preferred_invoice_language as FormState['preferred_invoice_language'])
      ?? (['service_provider', '3pl', 'shipper', 'other'].includes(p.kind ?? '')
          ? 'RU'
          : '')
    ),
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
    acceptance_required: (p as { acceptance_required?: 0 | 1 | null }).acceptance_required === 0 ? false : true,
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
          <select
            value={form.country}
            onChange={(e) => update('country', e.target.value)}
            style={inputStyle}
          >
            <option value="">— Select country —</option>
            {COUNTRIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Email">
          <EmailListEditor
            value={form.email}
            onChange={(v) => update('email', v)}
          />
        </Field>
        <Field label="Partner Type">
          <select
            value={form.kind}
            onChange={(e) => update('kind', e.target.value as FormState['kind'])}
            style={inputStyle}
          >
            {PARTNER_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
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
{!['service_provider', '3pl', 'shipper', 'other'].includes(partner.kind ?? '') && (
                <Field label="Preferred Incoterms">
          <input
            type="text"
            value={form.preferred_incoterms}
            onChange={(e) => update('preferred_incoterms', e.target.value)}
            placeholder="DAP, FCA, EXW…"
            style={inputStyle}
          />
        </Field>
        )}
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

      {/* Service-Track Settings — only for service-provider partners */}
      {partner?.kind === 'service_provider' && (
        <FormSection title="Service-Track Settings">
          <Field
            label="Acceptance required"
            hint={
              form.acceptance_required
                ? 'A separate acceptance certificate (ACP, акт выполненных работ) is needed for each service operation. The Service provided chip on the operation page lights up only when the acceptance document is attached.'
                : 'This partner runs on a subscription model — the invoice itself serves as the acceptance. Both the Service provided and Documents issued chips light up the moment the invoice is attached. Use this for rent, accounting, banking, hosting, telecom, and similar recurring services.'
            }
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                backgroundColor: form.acceptance_required ? 'var(--paper)' : 'rgba(229,32,44,0.04)',
              }}
            >
              <input
                type="checkbox"
                checked={!form.acceptance_required}
                onChange={(e) => update('acceptance_required', !e.target.checked)}
                style={{ width: 18, height: 18, cursor: 'pointer' }}
              />
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                Invoice serves as acceptance (no separate ACP needed)
              </span>
            </label>
          </Field>
        </FormSection>
      )}

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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

// =============================================================================
// EmailListEditor — multi-email input
// Stores as plain string when one email, JSON array string when 2+.
// First email = primary (shown in /partners list).
// =============================================================================

function parseEmailsToList(raw: string): string[] {
  if (!raw || !raw.trim()) return [''];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((x) => (typeof x === 'string' ? x : (x && typeof x === 'object' && typeof x.email === 'string' ? x.email : '')))
          .filter((s) => s.length > 0);
      }
    } catch {
      // fall through
    }
  }
  // Comma/semicolon-separated or plain
  const parts = trimmed.split(/[,;]/).map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [''];
}

function serializeEmails(list: string[]): string {
  const cleaned = list.map((s) => s.trim()).filter((s) => s.length > 0);
  if (cleaned.length === 0) return '';
  if (cleaned.length === 1) return cleaned[0]!;
  return JSON.stringify(cleaned);
}

function EmailListEditor({
  value, onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [emails, setEmails] = useState<string[]>(() => parseEmailsToList(value));

  // Re-sync if external value changes (e.g. discard form)
  useEffect(() => {
    setEmails(parseEmailsToList(value));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (next: string[]) => {
    setEmails(next);
    onChange(serializeEmails(next));
  };

  const updateAt = (idx: number, v: string) => {
    const next = emails.slice();
    next[idx] = v;
    commit(next);
  };

  const removeAt = (idx: number) => {
    if (emails.length === 1) {
      commit(['']);
      return;
    }
    const next = emails.slice();
    next.splice(idx, 1);
    commit(next);
  };

  const addEmpty = () => {
    commit([...emails, '']);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {emails.map((email, idx) => (
        <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="email"
            value={email}
            onChange={(e) => updateAt(idx, e.target.value)}
            placeholder={idx === 0 ? 'Primary email' : 'Additional email'}
            style={{ ...inputStyle, flex: 1 }}
          />
          {emails.length > 1 || email ? (
            <button
              type="button"
              onClick={() => removeAt(idx)}
              aria-label="Remove email"
              style={{
                padding: 6,
                color: 'var(--fg-3)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--paper-raised)',
              }}
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        onClick={addEmpty}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          alignSelf: 'flex-start',
          padding: '4px 8px',
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--fg-3)',
          border: '1px dashed var(--border-hairline)',
          borderRadius: 'var(--radius-sm)',
          background: 'transparent',
        }}
      >
        <Plus size={12} /> Add email
      </button>
      {emails.filter((e) => e.trim().length > 0).length > 1 && (
        <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2 }}>
          First email is primary — shown in the partner list.
        </div>
      )}
    </div>
  );
}

