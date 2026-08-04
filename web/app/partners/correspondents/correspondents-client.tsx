'use client';

// =============================================================================
// Correspondents — the worklist for filling the directory from real mail.
//
// Owner 2026-08-03, after a dry run of the historical linker: 287 letters in
// the archive, zero matched a partner. The directory held 19 addresses nobody
// writes to, and none of the people we actually correspond with. Backfilling
// links in that state would have created 287 empty rows that look like work.
//
// So this screen inverts the order. It lists who really writes, loudest first,
// and puts the Add button on the row. Ten companies by hand beats a hundred
// guesses by machine, and once they exist the linker has something to link to.
//
// Robots and our own domain are hidden by default — a worklist of 86 rows where
// 70 are mailer-daemons is not a worklist. The toggle brings them back.
// =============================================================================

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Loader2, Check } from 'lucide-react';
import { getCorrespondents, createPartnerQuick, type Correspondent } from '@/lib/api';
import Breadcrumb from '@/components/layout/breadcrumb';

function guessName(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0) return '';
  const core = (address.slice(at + 1).split('.')[0] || '').trim();
  return core.toUpperCase();
}

export default function CorrespondentsClient() {
  const [rows, setRows] = useState<Correspondent[]>([]);
  const [unknownCount, setUnknownCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const r = await getCorrespondents(showAll);
        if (!alive || !r.success) return;
        const list = r.result?.rows || [];
        setRows(list);
        setUnknownCount(r.result?.unknownCount || 0);
        setNames((prev) => {
          const next = { ...prev };
          for (const row of list) if (!next[row.address]) next[row.address] = guessName(row.address);
          return next;
        });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [showAll]);

  async function add(row: Correspondent) {
    const name = (names[row.address] || '').trim();
    if (!name || busy) return;
    setBusy(row.address);
    try {
      const created = await createPartnerQuick({
        trade_name: name,
        email: row.address,
        created_by_agent: 'owner',
      });
      const slug = created?.result?.id;
      if (slug) setDone((d) => ({ ...d, [row.address]: slug }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-6 py-6" style={{ maxWidth: '1200px' }}>
      <Breadcrumb items={[{ label: 'Partners', href: '/partners' }, { label: 'Correspondents' }]} />

      <div className="flex items-end justify-between mt-4 mb-2 flex-wrap gap-3">
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)' }}>
            Correspondents
          </h1>
          <p style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-3)', marginTop: '4px' }}>
            Кто нам пишет и кого нет в справочнике · без контрагента: {unknownCount}
          </p>
        </div>
        <label className="inline-flex items-center gap-2" style={{ fontSize: '14px', color: 'var(--fg-2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Показать роботов и внутренние адреса
        </label>
      </div>

      <div className="dx-ribbon-rule" />

      <div style={{
        border: '1px solid var(--border-hairline)', borderRadius: '8px',
        backgroundColor: 'var(--paper)', overflow: 'hidden', marginTop: '16px',
      }}>
        {loading ? (
          <div className="flex items-center gap-2 justify-center py-12" style={{ color: 'var(--fg-3)' }}>
            <Loader2 className="h-4 w-4 animate-spin" /> Читаю архив…
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12" style={{ color: 'var(--fg-3)' }}>Переписки не найдено</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <Th>Писем</Th><Th>Адрес</Th><Th>Ящик</Th><Th>Последняя тема</Th><Th>Контрагент</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const createdSlug = done[row.address];
                const slug = row.partnerSlug || createdSlug;
                return (
                  <tr key={row.address} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                    <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-1)', fontWeight: 600 }}>{row.letters}</td>
                    <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-1)' }}>{row.address}</td>
                    <td className="px-4 py-3" style={{ fontSize: '13px', color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>{row.mailboxes[0]}</td>
                    <td className="px-4 py-3" style={{ fontSize: '13px', color: 'var(--fg-2)', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.lastSubject}
                    </td>
                    <td className="px-4 py-3">
                      {slug ? (
                        <Link href={`/partners/${slug}`} className="inline-flex items-center gap-1" style={{ fontSize: '14px', color: 'var(--status-success)' }}>
                          <Check className="h-4 w-4" /> {row.partnerName || names[row.address]}
                        </Link>
                      ) : (
                        <div className="flex items-center gap-2">
                          <input
                            value={names[row.address] || ''}
                            onChange={(e) => setNames((n) => ({ ...n, [row.address]: e.target.value }))}
                            placeholder="Название"
                            style={{
                              border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
                              padding: '5px 8px', fontSize: '13px', width: '150px', backgroundColor: 'var(--paper-sunk)',
                              color: 'var(--fg-1)',
                            }}
                          />
                          <button
                            onClick={() => add(row)}
                            disabled={busy === row.address || !(names[row.address] || '').trim()}
                            className="inline-flex items-center gap-1 px-3 py-1.5"
                            style={{
                              backgroundColor: 'var(--brand-rot)', color: 'var(--paper)',
                              borderRadius: 'var(--radius-sm)', fontSize: '13px', fontWeight: 600,
                              opacity: busy === row.address || !(names[row.address] || '').trim() ? 0.5 : 1,
                            }}
                          >
                            {busy === row.address ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                            Завести
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p style={{ fontSize: '13px', color: 'var(--fg-3)', marginTop: '12px' }}>
        Заводится лидом с этим адресом. Тип, страну и реквизиты дописывает закреплённый агент по мере переписки.
      </p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)' }}>
      {children}
    </th>
  );
}
