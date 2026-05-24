'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Users as UsersIcon, ShieldCheck } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { ROLE_LABEL, type Role } from '@/lib/auth';

interface UserRow {
  id: string;
  name: string;
  role: Role;
  active: number;
  created_at: number;
  last_login_at: number | null;
}

// Module rows — must match the sidebar. Order matters.
const MODULES: { key: string; label: string }[] = [
  { key: '/',             label: 'Home' },
  { key: '/partners',     label: 'Partners' },
  { key: '/operations',   label: 'Operations' },
  { key: '/planner',      label: 'Planner' },
  { key: '/products',     label: 'Products' },
  { key: '/warehouses',   label: 'Warehouses' },
  { key: '/marketplaces', label: 'Marketplaces' },
  { key: '/reviews',      label: 'Reviews' },
  { key: '/crm',          label: 'CRM' },
  { key: '/finance',      label: 'Finance' },
  { key: '/analytics',    label: 'Analytics' },
  { key: '/settings',     label: 'Settings' },
];

// Access level shown in each cell of the matrix.
type Access = 'full' | 'rw' | 'read' | 'none';

// Per-role per-module access — same logic that drives the sidebar +
// future server-side enforcement. Keep in sync with api/src/lib/auth.ts.
const ACCESS: Record<Role, Record<string, Access>> = {
  admin: {
    '/': 'full', '/partners': 'full', '/operations': 'full', '/planner': 'full',
    '/products': 'full', '/warehouses': 'full', '/marketplaces': 'full',
    '/reviews': 'full', '/crm': 'full', '/finance': 'full', '/analytics': 'full',
    '/settings': 'full',
  },
  manager: {
    '/': 'rw', '/partners': 'rw', '/operations': 'rw', '/planner': 'rw',
    '/products': 'rw', '/warehouses': 'rw', '/marketplaces': 'read',
    '/reviews': 'read', '/crm': 'rw', '/finance': 'none', '/analytics': 'read',
    '/settings': 'none',
  },
  support: {
    '/': 'read', '/partners': 'read', '/operations': 'none', '/planner': 'none',
    '/products': 'read', '/warehouses': 'read', '/marketplaces': 'rw',
    '/reviews': 'rw', '/crm': 'none', '/finance': 'none', '/analytics': 'none',
    '/settings': 'none',
  },
};

function formatDate(ms: number | null): string {
  if (!ms) return 'Never';
  const d = new Date(ms);
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function AccessPill({ level }: { level: Access }) {
  const styles: Record<Access, { bg: string; fg: string; label: string }> = {
    full: { bg: '#EAF3DE', fg: '#27500A', label: 'full' },
    rw:   { bg: '#E6F1FB', fg: '#0C447C', label: 'read/write' },
    read: { bg: 'var(--paper-sunk)', fg: 'var(--fg-2)', label: 'read' },
    none: { bg: 'transparent', fg: 'var(--fg-muted)', label: '—' },
  };
  const s = styles[level];
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: '13px',
        fontWeight: 700,
        padding: level === 'none' ? '3px 6px' : '3px 10px',
        borderRadius: 'var(--radius-sm)',
        backgroundColor: s.bg,
        color: s.fg,
        letterSpacing: 0,
      }}
    >
      {s.label}
    </span>
  );
}

function RoleBadge({ role }: { role: Role }) {
  const colors: Record<Role, { bg: string; fg: string }> = {
    admin:   { bg: '#FCEBEB', fg: '#791F1F' },
    manager: { bg: '#E6F1FB', fg: '#0C447C' },
    support: { bg: '#F1EFE8', fg: '#444441' },
  };
  const c = colors[role];
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: '12px',
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: 'var(--radius-sm)',
        backgroundColor: c.bg,
        color: c.fg,
        letterSpacing: 0,
      }}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}

export default function UsersSettingsPage() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ users: UserRow[] }>('/api/auth/users').then((res) => {
      if (res.success && res.result) {
        setUsers(res.result.users);
      } else {
        const err = res.errors?.[0];
        setError(err?.code === 'forbidden' ? 'Admin role required to view this page' : (err?.message ?? 'Failed to load users'));
      }
    });
  }, []);

  return (
    <div className="px-8 py-6 max-w-screen-2xl">
      {/* Breadcrumb */}
      <div className="mb-4">
        <Link
          href="/settings"
          style={{ fontSize: '14px', color: 'var(--fg-2)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Settings
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <UsersIcon className="h-7 w-7" style={{ color: 'var(--fg-1)' }} />
        <h1 style={{
          fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '28px',
          fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase', letterSpacing: 0,
        }}>
          Users & Access
        </h1>
      </div>
      <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '24px', maxWidth: '780px' }}>
        Each user signs in with a 4-digit PIN. Their role determines which modules they see in the sidebar.
        Sessions last 12 hours. Roles can be changed by editing the seed (migration 0045) — UI-based role editing is planned.
      </p>

      {error && (
        <div
          style={{
            padding: '14px 18px',
            backgroundColor: '#FCEBEB',
            color: '#791F1F',
            borderRadius: 'var(--radius-md)',
            border: '1px solid #F09595',
            fontSize: '14px',
            fontWeight: 700,
            marginBottom: '24px',
          }}
        >
          {error}
        </div>
      )}

      {!users && !error && (
        <div style={{ fontSize: '14px', color: 'var(--fg-muted)' }}>Loading…</div>
      )}

      {users && users.length > 0 && (
        <>
          {/* User cards row */}
          <div
            className="grid gap-4 mb-8"
            style={{ gridTemplateColumns: `repeat(${users.length}, minmax(220px, 1fr))`, maxWidth: '1100px' }}
          >
            {users.map((u) => (
              <div
                key={u.id}
                style={{
                  padding: '18px',
                  border: '1px solid var(--line-1)',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'var(--paper)',
                }}
              >
                <div className="flex items-start justify-between mb-2">
                  <h2 style={{ fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '20px', fontWeight: 700, color: 'var(--fg-1)' }}>
                    {u.name}
                  </h2>
                  <RoleBadge role={u.role} />
                </div>
                <div style={{ fontSize: '13px', color: 'var(--fg-muted)', marginTop: '6px' }}>
                  PIN <span style={{ fontWeight: 700, color: 'var(--fg-2)', letterSpacing: '2px' }}>● ● ● ●</span>
                </div>
                <div style={{ fontSize: '13px', color: 'var(--fg-muted)', marginTop: '4px' }}>
                  Last login: <span style={{ fontWeight: 700, color: 'var(--fg-2)' }}>{formatDate(u.last_login_at)}</span>
                </div>
                <div style={{ fontSize: '13px', color: u.active ? '#27500A' : '#791F1F', marginTop: '4px', fontWeight: 700 }}>
                  {u.active ? 'Active' : 'Inactive'}
                </div>
              </div>
            ))}
          </div>

          {/* Access matrix */}
          <div
            style={{
              padding: '20px',
              border: '1px solid var(--line-1)',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'var(--paper)',
              maxWidth: '1100px',
            }}
          >
            <div className="flex items-center gap-2 mb-4">
              <ShieldCheck className="h-5 w-5" style={{ color: 'var(--fg-1)' }} />
              <h2 style={{
                fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '16px',
                fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase', letterSpacing: 0,
              }}>
                Access matrix
              </h2>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line-1)' }}>
                  <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: '13px', color: 'var(--fg-muted)', fontWeight: 700, width: '30%' }}>Module</th>
                  {users.map((u) => (
                    <th key={u.id} style={{ textAlign: 'center', padding: '8px 12px', fontSize: '13px', color: 'var(--fg-muted)', fontWeight: 700 }}>
                      {u.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MODULES.map((m) => (
                  <tr key={m.key} style={{ borderBottom: '1px solid var(--line-1)' }}>
                    <td style={{ padding: '10px 12px', fontWeight: 700, color: 'var(--fg-1)' }}>
                      {m.label}
                    </td>
                    {users.map((u) => (
                      <td key={u.id} style={{ textAlign: 'center', padding: '10px 12px' }}>
                        <AccessPill level={ACCESS[u.role][m.key] ?? 'none'} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Legend */}
            <div className="flex flex-wrap gap-x-5 gap-y-2 mt-4 pt-4" style={{ borderTop: '1px solid var(--line-1)', fontSize: '13px', color: 'var(--fg-2)' }}>
              <span className="inline-flex items-center gap-2">
                <AccessPill level="full" /> admin, can manage users
              </span>
              <span className="inline-flex items-center gap-2">
                <AccessPill level="rw" /> can create / edit
              </span>
              <span className="inline-flex items-center gap-2">
                <AccessPill level="read" /> view only
              </span>
              <span className="inline-flex items-center gap-2">
                <AccessPill level="none" /> hidden in sidebar
              </span>
            </div>

            <p style={{ fontSize: '13px', color: 'var(--fg-muted)', marginTop: '16px', maxWidth: '720px' }}>
              <strong style={{ fontWeight: 700 }}>Today:</strong> sidebar items are filtered by role; API requires a valid session
              but does not yet enforce read-only per module. <strong style={{ fontWeight: 700 }}>Planned:</strong> server-side gating
              per endpoint + Settings UI to add users, change PINs, and toggle roles.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
