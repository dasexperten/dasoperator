'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Upload, Loader2, ArrowLeft, FileCheck } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'https://dasoperator-api.dasexperten.workers.dev';

type Parsed = {
  trade_name: string | null;
  legal_name: string | null;
  country: string | null;
  inn: string | null;
  contact_person: string | null;
  contact_phone: string | null;
  email: string | null;
  address: string | null;
  bank_name: string | null;
  bank_account: string | null;
  notes: string | null;
};

const EMPTY: Parsed = {
  trade_name: '', legal_name: '', country: '', inn: '',
  contact_person: '', contact_phone: '', email: '',
  address: '', bank_name: '', bank_account: '', notes: '',
};

export function AddShipperClient({ operationId }: { operationId: string }) {
  const router = useRouter();

  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileBase64, setFileBase64] = useState<string | null>(null);
  const [fileMime, setFileMime] = useState<string | null>(null);

  const [parsed, setParsed] = useState<Parsed>(EMPTY);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function handleFile(file: File) {
    setFileName(file.name);
    setFileMime(file.type || 'application/octet-stream');
    const buf = await file.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i += 1) bin += String.fromCharCode(bytes[i]);
    setFileBase64(btoa(bin));
  }

  async function onParse() {
    setError(null); setInfo(null); setParsing(true);
    try {
      const r = await fetch(`${API_URL}/api/partners/parse-and-create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'parse',
          text: text.trim() || null,
          file_base64: fileBase64,
          file_mime: fileMime,
          file_name: fileName,
        }),
      });
      const j = await r.json() as { success: boolean; result?: { parsed: Parsed }; errors?: { message: string }[] };
      if (!j.success || !j.result) {
        setError(j.errors?.[0]?.message ?? 'Parse failed');
      } else {
        // Merge with EMPTY so all keys are present strings
        const merged: Parsed = { ...EMPTY };
        for (const k of Object.keys(EMPTY) as (keyof Parsed)[]) {
          const v = j.result.parsed[k];
          merged[k] = v == null ? '' : String(v);
        }
        setParsed(merged);
        setInfo('Fields extracted — review and edit before saving');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'parse error');
    } finally {
      setParsing(false);
    }
  }

  async function onSave() {
    setError(null); setSaving(true);
    try {
      const r = await fetch(`${API_URL}/api/partners/parse-and-create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'create', parsed }),
      });
      const j = await r.json() as {
        success: boolean;
        result?: { partner: { id: string; slug: string; trade_name: string }; duplicate?: boolean; message?: string };
        errors?: { message: string }[];
      };
      if (!j.success || !j.result) {
        setError(j.errors?.[0]?.message ?? 'Save failed');
        return;
      }
      if (j.result.duplicate) {
        setInfo(j.result.message ?? 'Already exists — returning to RFQ');
      }
      const newId = j.result.partner.id;
      router.push(`/operations/${operationId}/freight-rfq?shipper=${encodeURIComponent(newId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ fontSize: 13, color: 'var(--fg-3)', marginBottom: 4 }}>
        <Link href={`/operations/${operationId}/freight-rfq`} style={{ color: 'var(--fg-3)' }}>
          Operations &middot; Freight RFQ
        </Link>
        {' \u00b7 '}<span style={{ color: 'var(--fg-1)' }}>Add shipper</span>
      </div>
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: '4px 0 6px', color: 'var(--fg-1)' }}>Add new shipper</h1>
      <p style={{ fontSize: 14, color: 'var(--fg-3)', margin: '0 0 20px' }}>
        Paste text or drop a file — fields below auto-fill, then you confirm
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>

        {/* Left — input */}
        <div>
          <label htmlFor="shipperFile" style={{
            display: 'block', border: '1.5px dashed var(--border-hairline, #d4d4d4)',
            borderRadius: 'var(--radius-md, 6px)', padding: '26px 18px', textAlign: 'center',
            background: 'var(--paper-sunk, #fafafa)', cursor: 'pointer', marginBottom: 10,
          }}>
            {fileName ? (
              <>
                <FileCheck size={24} style={{ color: '#3B6D11' }} />
                <div style={{ fontSize: 14, marginTop: 6, fontWeight: 600 }}>{fileName}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>Click to replace</div>
              </>
            ) : (
              <>
                <Upload size={24} style={{ color: 'var(--fg-3)' }} />
                <div style={{ fontSize: 14, marginTop: 6 }}>Drop or click to pick a file</div>
                <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>PDF, JPG, business card, screenshot</div>
              </>
            )}
            <input
              id="shipperFile" type="file"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
              accept=".pdf,.jpg,.jpeg,.png,.txt,.csv"
            />
          </label>

          <textarea
            placeholder={'...or paste contact text here\n\nООО Логистик-Восток\nИНН 7712345678\n+7 495 ...\nbank: Сбербанк, р/с 40702...'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{
              width: '100%', minHeight: 200, padding: '10px 12px', fontSize: 13,
              fontFamily: 'inherit', resize: 'vertical', border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-md, 6px)',
            }}
          />

          <button
            onClick={onParse}
            disabled={parsing || (!text.trim() && !fileBase64)}
            style={{
              marginTop: 10, width: '100%', padding: '10px 14px', fontSize: 14, fontWeight: 600,
              background: 'var(--fg-1, #1A1A1A)', color: '#fff', border: 'none',
              borderRadius: 'var(--radius-md, 6px)', cursor: parsing ? 'wait' : 'pointer',
              opacity: (parsing || (!text.trim() && !fileBase64)) ? 0.5 : 1,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {parsing ? <Loader2 size={16} className="animate-spin" /> : null}
            {parsing ? 'Parsing…' : 'Parse'}
          </button>

          {error ? (
            <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(229,32,44,0.08)', color: '#A82029', borderRadius: 6, fontSize: 13 }}>{error}</div>
          ) : null}
          {info ? (
            <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(46,125,79,0.08)', color: '#2E7D4F', borderRadius: 6, fontSize: 13 }}>{info}</div>
          ) : null}
        </div>

        {/* Right — editable fields */}
        <div style={{
          background: 'var(--paper-raised, #fff)', borderRadius: 'var(--radius-md, 6px)',
          padding: '16px 18px', border: '1px solid var(--border-hairline)',
        }}>
          <div style={{ fontSize: 12, color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: 12, letterSpacing: 0 }}>
            Parsed fields &middot; editable
          </div>

          {([
            ['trade_name', 'Company name *'],
            ['legal_name', 'Legal name'],
            ['country', 'Country'],
            ['inn', 'INN / Tax ID'],
            ['contact_person', 'Contact person'],
            ['contact_phone', 'Phone'],
            ['email', 'Email'],
            ['address', 'Address'],
            ['bank_name', 'Bank'],
            ['bank_account', 'Bank account'],
          ] as [keyof Parsed, string][]).map(([key, label]) => (
            <div key={key} style={{ marginBottom: 8 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-3)', marginBottom: 2 }}>{label}</label>
              <input
                type="text"
                value={(parsed[key] ?? '') as string}
                onChange={(e) => setParsed({ ...parsed, [key]: e.target.value })}
                style={{
                  width: '100%', fontSize: 14, fontWeight: 700,
                  padding: '6px 10px', border: '1px solid var(--border-hairline)',
                  borderRadius: 'var(--radius-sm, 4px)',
                }}
              />
            </div>
          ))}

          <div style={{ marginTop: 12 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-3)', marginBottom: 2 }}>Notes</label>
            <textarea
              value={parsed.notes ?? ''}
              onChange={(e) => setParsed({ ...parsed, notes: e.target.value })}
              style={{
                width: '100%', minHeight: 50, padding: '6px 10px', fontSize: 13,
                fontFamily: 'inherit', resize: 'vertical', border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm, 4px)',
              }}
            />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <Link
          href={`/operations/${operationId}/freight-rfq`}
          style={{
            padding: '9px 16px', fontSize: 14, color: 'var(--fg-1)',
            background: 'transparent', border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-md, 6px)', textDecoration: 'none',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          <ArrowLeft size={14} /> Cancel
        </Link>
        <button
          onClick={onSave}
          disabled={saving || !parsed.trade_name?.trim()}
          style={{
            padding: '9px 20px', fontSize: 14, fontWeight: 600,
            background: 'var(--fg-1, #1A1A1A)', color: '#fff', border: 'none',
            borderRadius: 'var(--radius-md, 6px)', cursor: saving ? 'wait' : 'pointer',
            opacity: (saving || !parsed.trade_name?.trim()) ? 0.5 : 1,
            display: 'inline-flex', alignItems: 'center', gap: 8,
          }}
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save \u0026 return to RFQ'}
        </button>
      </div>
    </div>
  );
}
