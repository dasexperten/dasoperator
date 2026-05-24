'use client';

export const runtime = 'edge';

import Link from 'next/link';
import { Tag, FileSliders, Settings as SettingsIcon, ArrowRight, Users } from 'lucide-react';

const SECTIONS = [
  {
    href: '/settings/users',
    title: 'Users & Access',
    description: '4-digit PIN sign-in, per-role module visibility. Admins manage who sees what.',
    icon: Users,
  },
  {
    href: '/settings/finance-categories',
    title: 'Finance Categories',
    description: 'Manage transaction categories used by the classifier (bookkeeping, logistics, marketplace payout, etc.)',
    icon: Tag,
  },
  {
    href: '/settings/finance-rules',
    title: 'Finance Rules',
    description: 'Auto-classify rules: counterparty INN/IBAN + purpose pattern → category. Drives the Inbox.',
    icon: FileSliders,
  },
];

export default function SettingsPage() {
  return (
    <div className="px-8 py-6 max-w-screen-2xl">
      <div className="flex items-center gap-3 mb-6">
        <SettingsIcon className="h-7 w-7" style={{ color: 'var(--fg-1)' }} />
        <h1 style={{
          fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '28px',
          fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase', letterSpacing: 0,
        }}>
          Settings
        </h1>
      </div>

      <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '24px', maxWidth: '720px' }}>
        Operator-level configuration. Categories and rules feed the transaction classifier and Inbox — edit them as your business evolves.
      </p>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', maxWidth: '1200px' }}>
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            style={{
              display: 'block', padding: '20px',
              border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)',
              backgroundColor: 'var(--paper)', textDecoration: 'none',
              transition: 'all 0.15s',
            }}
            className="hover:shadow-sm"
          >
            <div className="flex items-start gap-3">
              <div style={{
                width: '40px', height: '40px', borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--paper-sunk)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <s.icon className="h-5 w-5" style={{ color: 'var(--fg-1)' }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <h2 style={{
                    fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '16px',
                    fontWeight: 700, color: 'var(--fg-1)',
                  }}>
                    {s.title}
                  </h2>
                  <ArrowRight className="h-4 w-4" style={{ color: 'var(--fg-3)' }} />
                </div>
                <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>{s.description}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
