'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

// =============================================================================
// CopyableValue — клик копирует значение в clipboard, показывает confirmation
// =============================================================================
interface CopyableValueProps {
  value: string;
  mono?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function CopyableValue({ value, mono = false, className = '', style }: CopyableValueProps) {
  const [copied, setCopied] = useState(false);

  const handleClick = async () => {
    if (!value || value === '—') return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      // clipboard может быть недоступен
    }
  };

  const baseColor = (style?.color ?? 'var(--fg-1)') as string;

  return (
    <span
      onClick={handleClick}
      title={value && value !== '—' ? `Click to copy: ${value}` : undefined}
      className={`${className}`}
      style={{
        cursor: value && value !== '—' ? 'pointer' : 'default',
        position: 'relative',
        display: 'inline-block',
        maxWidth: '100%',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        transition: 'color 120ms',
        color: copied ? 'var(--status-success)' : baseColor,
        ...style,
      }}
      onMouseEnter={(e) => {
        if (value && value !== '—' && !copied) {
          e.currentTarget.style.color = 'var(--brand-rot)';
        }
      }}
      onMouseLeave={(e) => {
        if (!copied) {
          e.currentTarget.style.color = baseColor;
        }
      }}
    >
      {copied ? `✓ ${value}` : value}
    </span>
  );
}

// =============================================================================
// CopyAllButton — копирует все поля секции в "Label: value\n..." формате
// =============================================================================
interface CopyAllButtonProps {
  fields: { label: string; value?: string | null }[];
}

export function CopyAllButton({ fields }: CopyAllButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleClick = async () => {
    const text = fields
      .filter((f) => f.value && f.value !== '—' && f.value !== 'MISSING')
      .map((f) => `${f.label}: ${f.value}`)
      .join('\n');

    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      // ignore
    }
  };

  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-1.5 transition-colors"
      style={{
        fontFamily: 'var(--font-narrow)',
        fontSize: '14px',
        fontWeight: 700,
        textTransform: 'uppercase',
        
        color: copied ? 'var(--status-success)' : 'var(--fg-3)',
        backgroundColor: 'transparent',
        padding: '4px 8px',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-xs)',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        if (!copied) {
          e.currentTarget.style.color = 'var(--brand-rot)';
          e.currentTarget.style.borderColor = 'var(--brand-rot)';
        }
      }}
      onMouseLeave={(e) => {
        if (!copied) {
          e.currentTarget.style.color = 'var(--fg-3)';
          e.currentTarget.style.borderColor = 'var(--border-hairline)';
        }
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy all'}
    </button>
  );
}

// =============================================================================
// SectionCard — карточка с заголовком (Plus Jakarta Sans 24px) + Copy all button
// =============================================================================
interface SectionCardProps {
  label: string;
  fields?: { label: string; value?: string | null }[];
  children: React.ReactNode;
}

export function SectionCard({ label, fields, children }: SectionCardProps) {
  return (
    <div
      className="p-5 bg-card"
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div className="flex items-center justify-between mb-5">
        <h3
          style={{
            fontFamily: 'var(--font-accent-jakarta)',
            fontSize: '24px',
            fontWeight: 800,
            
            textTransform: 'uppercase',
            color: 'var(--fg-1)',
            lineHeight: 1,
          }}
        >
          {label}
        </h3>
        {fields && <CopyAllButton fields={fields} />}
      </div>
      <dl className="space-y-3">{children}</dl>
    </div>
  );
}
