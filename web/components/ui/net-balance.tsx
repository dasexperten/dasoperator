'use client';

interface NetBalanceProps {
  usd: number;
  currencies?: Record<string, number>;
  fxDate?: string | null;
  size?: 'compact' | 'large';
}

function formatAmount(amount: number, currency: string): string {
  const isZeroDecimal = ['VND', 'JPY', 'KRW'].includes(currency);
  return Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: isZeroDecimal ? 0 : 2,
    maximumFractionDigits: isZeroDecimal ? 0 : 2,
  });
}

function semanticColor(usd: number): { dot: string; fg: string } {
  // Q1=A: positive (they owe us) = RED, negative (we owe them) = GREEN, zero = NEUTRAL
  if (usd > 0) return { dot: '#E5202C', fg: 'var(--brand-rot)' };
  if (usd < 0) return { dot: '#2E7D4F', fg: 'var(--status-success)' };
  return { dot: 'var(--fg-muted)', fg: 'var(--fg-3)' };
}

function signPrefix(usd: number): string {
  if (usd > 0) return '+';
  if (usd < 0) return '−';
  return '';
}

function pickHintCurrency(currencies: Record<string, number>): string | null {
  const entries = Object.entries(currencies).filter(([k]) => k !== 'USD');
  if (entries.length === 0) return null;
  entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return entries[0]?.[0] ?? null;
}

export default function NetBalance({ usd, currencies, fxDate, size = 'compact' }: NetBalanceProps) {
  const colors = semanticColor(usd);
  const sign = signPrefix(usd);
  const usdFmt = formatAmount(usd, 'USD');
  const hintCcy = currencies ? pickHintCurrency(currencies) : null;
  const hintAmount = hintCcy && currencies ? currencies[hintCcy] : null;

  if (size === 'compact') {
    return (
      <span className="inline-flex items-center gap-2">
        <span
          className="inline-block rounded-full"
          style={{
            width: '8px', height: '8px',
            backgroundColor: colors.dot,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: '14px', color: colors.fg, fontWeight: 600, whiteSpace: 'nowrap' }}>
          {sign}${usdFmt}
        </span>
        {hintCcy && hintAmount !== undefined && hintAmount !== null && (
          <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
            ({hintCcy})
          </span>
        )}
      </span>
    );
  }

  // Large widget — partner hub
  return (
    <div
      className="bg-card p-6"
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div className="flex items-start justify-between mb-4">
        <h2 style={{
          fontFamily: 'var(--font-accent-jakarta)',
          fontSize: '24px',
          fontWeight: 800,

          textTransform: 'uppercase',
          color: 'var(--fg-1)',
          lineHeight: 1,
        }}>
          Net Balance
        </h2>
        {fxDate && (
          <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
            FX @ {fxDate}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 mb-4">
        <span
          className="inline-block rounded-full"
          style={{
            width: '14px', height: '14px',
            backgroundColor: colors.dot,
          }}
        />
        <span className="dx-num" style={{ fontSize: 'clamp(26px, 7vw, 40px)', color: colors.fg, fontWeight: 700, lineHeight: 1.05 }}>
          {sign}${usdFmt}
        </span>
      </div>

      {currencies && Object.keys(currencies).length > 0 && (
        <div>
          <div className="mb-2" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>Currencies</div>
          <div className="flex flex-wrap gap-3">
            {Object.entries(currencies).map(([ccy, amount]) => {
              const ccySign = amount > 0 ? '+' : amount < 0 ? '−' : '';
              const ccyColor = amount > 0 ? 'var(--brand-rot)' : amount < 0 ? 'var(--status-success)' : 'var(--fg-3)';
              return (
                <span key={ccy} style={{ fontSize: '14px', color: ccyColor, whiteSpace: 'nowrap' }}>
                  {ccySign}{formatAmount(amount, ccy)} {ccy}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border-hairline)' }}>
        <p style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-3)' }}>
          {usd > 0 && '🔴 Partner owes us'}
          {usd < 0 && '🟢 We owe partner'}
          {usd === 0 && '⚪ Settled'}
          {' · USD pivot via today\'s CBR rates · only delivered/shipped operations counted'}
        </p>
      </div>
    </div>
  );
}

