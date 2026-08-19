'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Users as UsersIcon, ShieldCheck, Loader2, Check } from 'lucide-react';
import { apiGet, apiPatch } from '@/lib/api';
import { ROLE_LABEL, getUser, setAuth, type Role, type Access } from '@/lib/auth';

interface UserRow {
  id: string;
  name: string;
  role: Role;
  active: number;
  permissions: Record<string, Access>;
  created_at: number;
  last_login_at: number | null;
}

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

// Click cycle for non-admin users: none -> read -> rw -> none
// 'full' is admin-only, not in the cycle.
const CYCLE: Record<Access, Access> = {
  none: 'read',
  read: 'rw',
  rw:   'none',
  full: 'full',
};

function formatDate(ms: number | null): string {
  if (!ms) return 'Never';
  const d = new Date(ms);
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function AccessPill({
  level,
  clickable = false,
  onClick,
  busy = false,
  justSaved = false,
}: {
  level: Access;
  clickable?: boolean;
  onClick?: () => void;
  busy?: boolean;
  justSaved?: boolean;
}) {
  const styles: Record<Access, { bg: string; fg: string; label: string }> = {
    full: { bg: '#EAF3DE', fg: '#27500A', label: 'full' },
    rw:   { bg: '#E6F1FB', fg: '#0C447C', label: 'read/write' },
    read: { bg: 'var(--paper-sunk)', fg: 'var(--fg-2)', label: 'read' },
    none: { bg: 'transparent', fg: 'var(--fg-muted)', label: '—' },
  };
  const s = styles[level];

  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '13px',
    fontWeight: 700,
    padding: level === 'none' ? '4px 10px' : '4px 12px',
    borderRadius: 'var(--radius-sm)',
    backgroundColor: s.bg,
    color: s.fg,
    letterSpacing: 0,
    border: level === 'none' ? '1px dashed var(--border-hairline)' : '1px solid transparent',
    transition: 'transform 80ms ease-out, box-shadow 120ms ease-out',
    minWidth: '102px',
    justifyContent: 'center',
  } as const;

  if (!clickable) {
    return <span style={{ ...base, opacity: 0.85 }}>{s.label}</span>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title="Click to cycle: none -> read -> read/write -> none"
      style={{
        ...base,
        cursor: busy ? 'progress' : 'pointer',
        boxShadow: justSaved ? '0 0 0 2px rgba(39,80,10,0.4)' : 'none',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)';
      }}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : justSaved ? <Check className="h-3 w-3" /> : null}
      {s.label}
    </button>
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
  const [busyCells, setBusyCells] = useState<Set<string>>(new Set());
  const [justSavedCells, setJustSavedCells] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

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

  async function cycleCell(userId: string, role: Role, moduleKey: string, current: Access) {
    if (role === 'admin') return;
    const cellKey = `${userId}:${moduleKey}`;
    const next = CYCLE[current];

    setUsers((prev) => prev?.map((u) => u.id === userId
      ? { ...u, permissions: { ...u.permissions, [moduleKey]: next } }
      : u
    ) ?? null);

    setBusyCells((s) => new Set(s).add(cellKey));

    const res = await apiPatch<{ id: string; permissions: Record<string, Access> }>(
      `/api/auth/users/${userId}/permissions`,
      { module: moduleKey, access: next }
    );

    setBusyCells((s) => {
      const n = new Set(s);
      n.delete(cellKey);
      return n;
    });

    if (!res.success || !res.result) {
      const err = res.errors?.[0];
      setToast(err?.message ?? 'Failed to update -- reverted');
      setTimeout(() => setToast(null), 3000);
      setUsers((prev) => prev?.map((u) => u.id === userId
        ? { ...u, permissions: { ...u.permissions, [moduleKey]: current } }
        : u
      ) ?? null);
      return;
    }

    setUsers((prev) => prev?.map((u) => u.id === userId
      ? { ...u, permissions: res.result!.permissions }
      : u
    ) ?? null);

    const me = getUser();
    if (me && me.id === userId) {
      const updated = { ...me, permissions: res.result.permissions };
      const expiresStr = (typeof window !== 'undefined') ? window.localStorage.getItem('dx_auth_expires') : null;
      const token = (typeof window !== 'undefined') ? window.localStorage.getItem('dx_auth_token') : null;
      const expires = expiresStr ? parseInt(expiresStr, 10) : Date.now() + 12 * 60 * 60 * 1000;
      if (token) setAuth(token, updated, expires);
    }

    setJustSavedCells((s) => new Set(s).add(cellKey));
    setTimeout(() => {
      setJustSavedCells((s) => {
        const n = new Set(s);
        n.delete(cellKey);
        return n;
      });
    }, 1200);
  }

  return (
    <div className="px-8 py-6 max-w-screen-2xl">
      <div className="mb-4">
        <Link
          href="/settings"
          style={{ fontSize: '14px', color: 'var(--fg-2)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Settings
        </Link>
      </div>

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
        Each user signs in with a 4-digit PIN. Click any cell in the matrix to cycle
        access: <strong style={{ fontWeight: 700 }}>none -&gt; read -&gt; read/write -&gt; none</strong>.
        Changes save instantly. Admin users are locked at <strong style={{ fontWeight: 700 }}>full</strong> across all modules.
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
        <div style={{ fontSize: '14px', color: 'var(--fg-muted)' }}>Loading...</div>
      )}

      {users && users.length > 0 && (
        <>
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
                  PIN <span style={{ fontWeight: 700, color: 'var(--fg-2)', letterSpacing: '0' }}>● ● ● ●</span>
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
                  <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: '13px', color: 'var(--fg-muted)', fontWeight: 700, width: '28%' }}>Module</th>
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
                    {users.map((u) => {
                      const cellKey = `${u.id}:${m.key}`;
                      const level = u.permissions[m.key] ?? 'none';
                      return (
                        <td key={u.id} style={{ textAlign: 'center', padding: '10px 12px' }}>
                          <AccessPill
                            level={level}
                            clickable={u.role !== 'admin'}
                            busy={busyCells.has(cellKey)}
                            justSaved={justSavedCells.has(cellKey)}
                            onClick={() => cycleCell(u.id, u.role, m.key, level)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex flex-wrap gap-x-5 gap-y-2 mt-4 pt-4" style={{ borderTop: '1px solid var(--line-1)', fontSize: '13px', color: 'var(--fg-2)' }}>
              <span className="inline-flex items-center gap-2">
                <AccessPill level="full" /> admin, locked
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
              Click cycles <strong style={{ fontWeight: 700 }}>none -&gt; read -&gt; read/write -&gt; none</strong>.
              Sidebar visibility updates immediately for the affected user;
              server-side per-endpoint enforcement is planned next.
            </p>
          </div>
        </>
      )}

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            padding: '14px 20px',
            backgroundColor: '#791F1F',
            color: 'var(--paper)',
            borderRadius: 'var(--radius-md)',
            fontSize: '14px',
            fontWeight: 700,
            boxShadow: '0 12px 32px rgba(0,0,0,0.25)',
            zIndex: 50,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
