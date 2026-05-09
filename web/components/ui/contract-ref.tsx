// =============================================================================
// ContractRef — unified rendering of a contract_no value across the app.
// Real contracts: bold, optionally clickable.
// Placeholder contracts (contract_no LIKE 'NO-CONTRACT-%' or matching pattern):
// muted "Placeholder" pill so users can see at a glance which contracts are
// technical fillers and not yet a signed document.
// =============================================================================
import Link from 'next/link';

export function isPlaceholderContractNo(contractNo: string | null | undefined): boolean {
  if (!contractNo) return false;
  return /^NO[-\s]CONTRACT/i.test(contractNo);
}

interface ContractRefProps {
  contractNo: string | null | undefined;
  href?: string;
  /** When true the placeholder badge is not rendered, only "—" is shown.
   *  Useful in compact tables where width is at a premium. */
  compact?: boolean;
}

export function ContractRef({ contractNo, href, compact = false }: ContractRefProps) {
  if (!contractNo) {
    return <span style={{ color: 'var(--fg-3)' }}>—</span>;
  }

  if (isPlaceholderContractNo(contractNo)) {
    if (compact) return <span style={{ color: 'var(--fg-3)' }}>—</span>;
    return (
      <span
        className="inline-flex items-center gap-1.5"
        style={{
          padding: '2px 8px',
          fontSize: '12px',
          fontWeight: 600,
          color: 'var(--fg-3)',
          backgroundColor: 'var(--paper-sunk)',
          border: '1px dashed var(--border-hairline)',
          borderRadius: 'var(--radius-pill)',
          fontFamily: 'var(--font-sans)',
          letterSpacing: 0,
        }}
        title="Technical placeholder — replace when a real contract is signed"
      >
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: 'var(--fg-muted)',
            display: 'inline-block',
          }}
        />
        Placeholder
      </span>
    );
  }

  const inner = (
    <span
      style={{
        fontWeight: 700,
        color: 'var(--fg-1)',
        fontSize: '14px',
      }}
    >
      {contractNo}
    </span>
  );

  if (href) {
    return (
      <Link
        href={href}
        style={{
          color: 'var(--fg-1)',
          textDecoration: 'underline',
          textDecorationColor: 'var(--border-hairline)',
          textUnderlineOffset: '3px',
        }}
      >
        {inner}
      </Link>
    );
  }
  return inner;
}
