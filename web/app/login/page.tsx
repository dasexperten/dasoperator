'use client';

import { Suspense, useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { login, getToken, getUser } from '@/lib/auth';

export const runtime = 'edge';

/** Safe in-app redirect after login (blocks open redirects). */
function safeNextPath(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  // Allow mail standalone app + normal ERP routes
  if (raw === '/mail' || raw.startsWith('/mail?') || raw.startsWith('/mail/')) return raw.split('#')[0];
  if (raw.length > 200) return '/';
  return raw.split('#')[0];
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div
          className="min-h-screen flex items-center justify-center"
          style={{ backgroundColor: 'var(--brand-schwarz)', color: 'var(--paper)', fontSize: 14 }}
        >
          Loading…
        </div>
      }
    >
      <LoginPageInner />
    </Suspense>
  );
}

/**
 * Login — PIN entry screen.
 *
 * 4-digit PIN via on-screen pad (tap or type). On success → push to `/`
 * or `?next=` (e.g. Android mail PWA → /mail).
 * On failure → shake, clear digits, show error.
 *
 * UI rules:
 *  - Fonts ≥ 14px (PIN dots are visual, not text)
 *  - Numerics bold (PIN digits → bold)
 *  - Schwarz/rot/gold palette via CSS vars from globals.css
 */
function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = useMemo(() => safeNextPath(searchParams.get('next')), [searchParams]);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);

  // If already authenticated, bounce to intended destination
  useEffect(() => {
    if (getToken() && getUser()) router.replace(nextPath);
  }, [router, nextPath]);

  const submit = useCallback(async (code: string) => {
    setBusy(true);
    setError(null);
    const res = await login(code);
    setBusy(false);
    if (res.ok) {
      router.replace(nextPath);
    } else {
      setError(res.error);
      setShake(true);
      setTimeout(() => setShake(false), 450);
      setPin('');
    }
  }, [router, nextPath]);

  const onKey = useCallback((key: string) => {
    if (busy) return;
    if (key === 'clear') {
      setPin('');
      setError(null);
      return;
    }
    if (key === 'back') {
      setPin((p) => p.slice(0, -1));
      setError(null);
      return;
    }
    if (/^\d$/.test(key) && pin.length < 4) {
      const next = pin + key;
      setPin(next);
      setError(null);
      if (next.length === 4) {
        // Auto-submit
        void submit(next);
      }
    }
  }, [busy, pin, submit]);

  // Physical keyboard support
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Backspace') { onKey('back'); e.preventDefault(); return; }
      if (e.key === 'Escape')    { onKey('clear'); e.preventDefault(); return; }
      if (/^[0-9]$/.test(e.key)) { onKey(e.key); e.preventDefault(); return; }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKey]);

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ backgroundColor: 'var(--brand-schwarz)' }}
    >
      <div
        className={shake ? 'dx-shake' : ''}
        style={{
          backgroundColor: 'var(--paper)',
          borderRadius: 'var(--radius-md)',
          padding: '40px 28px 32px',
          width: '100%',
          maxWidth: '340px',
          boxShadow: '0 1px 0 rgba(255,255,255,0.04), 0 24px 64px rgba(0,0,0,0.45)',
        }}
      >
        {/* Brand */}
        <div className="text-center mb-6">
          <div
            className="dx-product-name"
            style={{ fontSize: '24px', lineHeight: 1, color: 'var(--brand-schwarz)' }}
          >
            das experten
            <sup style={{ fontSize: '14px', marginLeft: '2px', color: 'var(--brand-gold)' }}>®</sup>
          </div>
          <div style={{ marginTop: '6px', fontSize: '14px', color: 'var(--fg-muted)' }}>
            DAS OPERATOR
          </div>
        </div>

        <div
          style={{
            textAlign: 'center',
            fontSize: '15px',
            color: 'var(--fg-2)',
            marginBottom: '20px',
            fontWeight: 700,
          }}
        >
          Enter your PIN
        </div>

        {/* Dots */}
        <div className="flex justify-center gap-3 mb-6" aria-live="polite" aria-label="PIN entry progress">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              style={{
                width: '14px',
                height: '14px',
                borderRadius: '50%',
                border: '1px solid var(--border-hairline)',
                backgroundColor: i < pin.length ? 'var(--brand-schwarz)' : 'transparent',
                borderColor: i < pin.length ? 'var(--brand-schwarz)' : 'var(--border-hairline)',
                transition: 'all 120ms ease-out',
              }}
            />
          ))}
        </div>

        {/* Error / status */}
        <div
          style={{
            minHeight: '20px',
            textAlign: 'center',
            fontSize: '14px',
            color: error ? 'var(--brand-rot)' : 'var(--fg-muted)',
            marginBottom: '12px',
            fontWeight: error ? 700 : 400,
          }}
        >
          {busy ? 'Checking…' : error ?? '\u00a0'}
        </div>

        {/* Keypad — dx-keep-grid prevents mobile CSS from collapsing to 1-col */}
        <div
          className="dx-keep-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '10px',
          }}
        >
          {['1','2','3','4','5','6','7','8','9'].map((d) => (
            <PadButton key={d} onClick={() => onKey(d)} disabled={busy} label={d} />
          ))}
          <PadButton onClick={() => onKey('clear')} disabled={busy} label="clear" small />
          <PadButton onClick={() => onKey('0')} disabled={busy} label="0" />
          <PadButton onClick={() => onKey('back')} disabled={busy} label="⌫" />
        </div>

        <div
          style={{
            marginTop: '20px',
            textAlign: 'center',
            fontSize: '13px',
            color: 'var(--fg-muted)',
            letterSpacing: 0,
          }}
        >
          4-digit code · session 12 hours
        </div>
      </div>

      {/* Shake animation */}
      <style jsx>{`
        :global(.dx-shake) {
          animation: dx-shake 0.45s cubic-bezier(.36,.07,.19,.97) both;
        }
        @keyframes dx-shake {
          10%, 90% { transform: translateX(-2px); }
          20%, 80% { transform: translateX(4px); }
          30%, 50%, 70% { transform: translateX(-8px); }
          40%, 60% { transform: translateX(8px); }
        }
      `}</style>
    </div>
  );
}

interface PadProps {
  onClick: () => void;
  disabled: boolean;
  label: string;
  small?: boolean;
}

function PadButton({ onClick, disabled, label, small }: PadProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: '56px',
        backgroundColor: 'var(--paper)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-sm)',
        fontSize: small ? '15px' : '22px',
        fontWeight: 700,
        color: small ? 'var(--fg-muted)' : 'var(--fg-1)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background-color 80ms ease-out',
        userSelect: 'none',
      }}
      onMouseDown={(e) => {
        (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--paper-sunk)';
      }}
      onMouseUp={(e) => {
        (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--paper)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--paper)';
      }}
    >
      {label}
    </button>
  );
}
