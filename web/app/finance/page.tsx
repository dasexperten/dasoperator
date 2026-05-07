'use client';

export const runtime = 'edge';

import Link from 'next/link';
import { Wallet, ArrowDownToLine } from 'lucide-react';

export default function FinanceIndexPage() {
  return (
    <div className="px-8 py-6 max-w-6xl">
      <div className="mb-6">
        <h1 style={{
          fontFamily: 'Plus Jakarta Sans, sans-serif',
          fontSize: '24px',
          fontWeight: 700,
          color: 'var(--fg-1)',
          textTransform: 'uppercase',
          letterSpacing: 0,
          marginBottom: '8px',
        }}>
          Finance
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
          Bank accounts, transactions, and reconciliation across all entities.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link
          href="/finance/accounts"
          className="block p-6 transition-colors"
          style={{
            border: '1px solid var(--line-1)',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--paper)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--brand-rot)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--line-1)'; }}
        >
          <div className="flex items-start gap-4">
            <Wallet className="h-8 w-8" style={{ color: 'var(--brand-schwarz)' }} />
            <div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--fg-1)' }}>
                Bank Accounts
              </div>
              <div style={{ fontSize: '14px', color: 'var(--fg-2)', marginTop: '4px' }}>
                Our bank accounts across DEE, DEI, DEASEAN, DEC. API integration status, currencies, balances.
              </div>
            </div>
          </div>
        </Link>

        <Link
          href="/finance/transactions"
          className="block p-6 transition-colors"
          style={{
            border: '1px solid var(--line-1)',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--paper)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--brand-rot)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--line-1)'; }}
        >
          <div className="flex items-start gap-4">
            <ArrowDownToLine className="h-8 w-8" style={{ color: 'var(--brand-schwarz)' }} />
            <div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--fg-1)' }}>
                Transactions
              </div>
              <div style={{ fontSize: '14px', color: 'var(--fg-2)', marginTop: '4px' }}>
                All bank movements from connected accounts. Filter by direction, account, match status.
              </div>
            </div>
          </div>
        </Link>
      </div>
    </div>
  );
}
