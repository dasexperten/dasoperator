'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, AlertCircle, Search, RefreshCw, ShoppingBag, AlertTriangle, CheckCheck } from 'lucide-react';
import {
  getMailboxes,
  getMailboxMessages,
  getAttention,
  getOrdersFeed,
  getUnreadCount,
  markMailRead,
  type AttentionEntry,
} from '@/lib/api';
import AttentionCard from './attention-card';
import {
  type MailEntry,
  type Period,
  type CorrespondentGroup,
  displayName,
  dotColor,
  correspondent,
  emailAddr,
  originOf,
  groupByCorrespondent,
  withinPeriod,
  fmtRelative,
} from './shared';

const PERIODS: Array<{ key: Period; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'Week' },
  { key: 'all', label: 'All' },
];

const MAX_CORRESPONDENT_CARDS = 8; // + hero + orders + system toggle = 11

export default function EmailerDashboard({
  onOpenMessage,
  onOpenOrders,
  onSwitchToList,
}: {
  onOpenMessage: (entry: MailEntry) => void;
  onOpenOrders: () => void;
  onSwitchToList: () => void;
}) {
  const [entries, setEntries] = useState<MailEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [viewGroup, setViewGroup] = useState<'people' | 'system'>('people');
  const [period, setPeriod] = useState<Period>('today');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);

  const [attention, setAttention] = useState<AttentionEntry[]>([]);
  const [ordersToday, setOrdersToday] = useState(0);
  const [unreadHuman, setUnreadHuman] = useState(0);
  const [unreadSystem, setUnreadSystem] = useState(0);
  const [markingAll, setMarkingAll] = useState(false);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const mb = await getMailboxes();
      if (!mb.success || !mb.result) {
        setError(mb.errors?.[0]?.message || 'Failed to load mail');
        setEntries([]);
        return;
      }
      const addrs = mb.result.mailboxes.map((m) => m.address);
      const lists = await Promise.all(
        addrs.map(async (a) => {
          try {
            const r = await getMailboxMessages(a);
            return r.success && r.result ? r.result.entries.map((e) => ({ ...e, mailbox: a })) : [];
          } catch {
            return [];
          }
        })
      );
      const merged = lists.flat().sort((x, y) => (y.timestamp || '').localeCompare(x.timestamp || ''));
      setEntries(merged);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadSignals() {
    try {
      const [att, orders, uh, us] = await Promise.all([
        getAttention(),
        getOrdersFeed('24h'),
        getUnreadCount('human'),
        getUnreadCount('system'),
      ]);
      if (att.success && att.result) setAttention(att.result.waiting);
      if (orders.success && orders.result) setOrdersToday(orders.result.count);
      if (uh.success && uh.result) setUnreadHuman(uh.result.count);
      if (us.success && us.result) setUnreadSystem(us.result.count);
    } catch {
      /* signals are best-effort — dashboard still works without them */
    }
  }

  useEffect(() => { loadAll(); loadSignals(); }, []);

  const filtered = useMemo(() => {
    const wantAuto = viewGroup === 'system';
    return entries.filter((e) => {
      if ((originOf(e) === 'auto') !== wantAuto) return false;
      if (!withinPeriod(e.timestamp, period)) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const who = correspondent(e).toLowerCase();
        const subj = (e.subject || '').toLowerCase();
        if (!who.includes(q) && !subj.includes(q)) return false;
      }
      return true;
    });
  }, [entries, viewGroup, period, search]);

  const correspondentGroups: CorrespondentGroup[] = useMemo(
    () => (viewGroup === 'people' ? groupByCorrespondent(filtered) : []),
    [filtered, viewGroup]
  );

  const visibleGroups = showAll ? correspondentGroups : correspondentGroups.slice(0, MAX_CORRESPONDENT_CARDS);
  const moreCount = correspondentGroups.length - visibleGroups.length;

  // System tab groups by trigger; entries whose subject looks like a failure
  // surface as anomalies at the top (delivery errors, bounces).
  const systemGroups = useMemo(() => {
    if (viewGroup !== 'system') return { anomalies: [] as MailEntry[], byTrigger: new Map<string, MailEntry[]>() };
    const anomalyRe = /(fail|error|bounce|undeliver|reject)/i;
    const anomalies: MailEntry[] = [];
    const byTrigger = new Map<string, MailEntry[]>();
    for (const e of filtered) {
      if (anomalyRe.test(e.subject || '')) { anomalies.push(e); continue; }
      const t = e.trigger || 'other';
      if (!byTrigger.has(t)) byTrigger.set(t, []);
      byTrigger.get(t)!.push(e);
    }
    return { anomalies, byTrigger };
  }, [filtered, viewGroup]);

  async function markAllSystemRead() {
    if (filtered.length === 0) return;
    setMarkingAll(true);
    try {
      const byMailbox = new Map<string, string[]>();
      for (const e of filtered) {
        if (!byMailbox.has(e.mailbox)) byMailbox.set(e.mailbox, []);
        byMailbox.get(e.mailbox)!.push(e.key);
      }
      await Promise.all(Array.from(byMailbox.entries()).map(([mailbox, keys]) => markMailRead(keys, mailbox)));
      await loadSignals();
    } finally {
      setMarkingAll(false);
    }
  }

  return (
    <div className="emailer-dark ed-screen rounded-[14px] p-5">
      {/* Toggle + search + refresh */}
      <div className="ed-toolbar mb-4">
        <div className="ed-toggle inline-flex rounded-lg p-0.5" style={{ background: 'var(--ed-card)' }}>
          {(['people', 'system'] as const).map((v) => (
            <button
              key={v}
              onClick={() => { setViewGroup(v); setShowAll(false); }}
              className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${viewGroup === v ? 'ed-tab-active' : ''}`}
              style={{ color: viewGroup === v ? 'var(--ed-text)' : 'var(--ed-system-text)' }}
            >
              {v === 'people' ? 'People' : 'System'}
              <span className="ml-2 text-xs font-normal tabular-nums">{v === 'people' ? unreadHuman : unreadSystem}</span>
            </button>
          ))}
        </div>
        <div className="ed-toolbar-right flex items-center gap-2 flex-1 justify-end">
          <div className="ed-search relative">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--ed-meta)' }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              className="pl-8 pr-3 py-1.5 text-sm rounded-md bg-transparent"
              style={{ background: 'var(--ed-card)', color: 'var(--ed-text)', border: '1px solid var(--ed-border)' }}
            />
          </div>
          <button
            onClick={() => { loadAll(); loadSignals(); }}
            aria-label="Refresh"
            className="ed-icon-btn p-2 rounded-md"
            style={{ background: 'var(--ed-card)', color: 'var(--ed-text-2)' }}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Header */}
      <div className="mb-4">
        <div className="ed-display ed-h1 leading-none">
          {viewGroup === 'people' ? `${unreadHuman} unread` : `${filtered.length} system messages today`}
        </div>
        <div className="text-sm mt-1" style={{ color: 'var(--ed-text-2)' }}>
          {viewGroup === 'people'
            ? 'People · all mailboxes'
            : systemGroups.anomalies.length > 0
              ? `all clear · ${systemGroups.anomalies.length} need attention`
              : 'all clear'}
        </div>
      </div>

      {/* Period tabs */}
      <div className="ed-tabs mb-5 text-sm">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            className={period === p.key ? 'ed-tab-active pb-1' : 'pb-1'}
            style={{ color: period === p.key ? 'var(--ed-text)' : 'var(--ed-meta)' }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="p-10 text-center"><Loader2 className="h-7 w-7 animate-spin mx-auto" style={{ color: 'var(--ed-meta)' }} /></div>
      ) : error ? (
        <div className="p-4 flex items-center gap-2 rounded-md" style={{ background: 'var(--ed-card)' }}>
          <AlertCircle className="h-5 w-5" style={{ color: 'var(--ed-out)' }} /> <span className="text-sm">{error}</span>
        </div>
      ) : viewGroup === 'people' ? (
        <>
          <div className="ed-grid">
            <AttentionCard waiting={attention} onOpen={(who) => {
              const e = entries.find((x) => emailAddr(correspondent(x)) === emailAddr(who));
              if (e) onOpenMessage(e);
            }} />

            {visibleGroups.map((g) => (
              <button
                key={g.address}
                onClick={() => onOpenMessage(g.latest)}
                className="ed-card text-left p-4 flex flex-col justify-between min-h-[140px] dx-hoverable"
              >
                <div>
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold mb-2" style={{ background: dotColor(g.address), color: '#fff' }}>
                    {(g.name[0] || '?').toUpperCase()}
                  </div>
                  <div className="font-bold text-sm leading-tight line-clamp-2">{g.name}</div>
                </div>
                <div className="mt-2">
                  <div className="text-xs truncate" style={{ color: g.latest.direction === 'received' ? 'var(--ed-in)' : 'var(--ed-out)' }}>
                    {g.latest.direction === 'received' ? '← ' : '→ '}{g.latest.mailbox}
                  </div>
                  <div className="text-xs truncate mt-0.5" style={{ color: 'var(--ed-text-2)' }}>{g.latest.subject || '(no subject)'}</div>
                  <div className="text-[10px] mt-1" style={{ color: 'var(--ed-meta)' }}>{fmtRelative(g.latest.timestamp)}</div>
                </div>
              </button>
            ))}

            <button onClick={onOpenOrders} className="ed-card text-left p-4 flex flex-col justify-between min-h-[140px] dx-hoverable">
              <ShoppingBag className="h-5 w-5" style={{ color: 'var(--ed-gold)' }} />
              <div>
                <div className="ed-display text-2xl" style={{ color: 'var(--ed-gold)' }}>{ordersToday}</div>
                <div className="text-xs mt-1" style={{ color: 'var(--ed-text-2)' }}>Orders · Forms (24h)</div>
              </div>
            </button>

            <button onClick={() => { setViewGroup('system'); setShowAll(false); }} className="ed-system text-left p-4 flex flex-col justify-between min-h-[140px] dx-hoverable">
              <div className="text-xs font-bold" style={{ color: 'var(--ed-system-text-2)' }}>SYSTEM</div>
              <div>
                <div className="ed-display text-2xl" style={{ color: 'var(--ed-system-text-2)' }}>{unreadSystem}</div>
                <div className="text-xs mt-1">unread</div>
              </div>
            </button>
          </div>

          {moreCount > 0 && !showAll && (
            <button onClick={() => setShowAll(true)} className="ed-action mt-3 text-sm font-semibold" style={{ color: 'var(--ed-gold)' }}>
              {moreCount} more →
            </button>
          )}

          {correspondentGroups.length === 0 && (
            <div className="p-10 text-center text-sm" style={{ color: 'var(--ed-meta)' }}>
              No mail for this period.
            </div>
          )}
        </>
      ) : (
        <div className="space-y-5">
          {filtered.length > 0 && (
            <button
              onClick={markAllSystemRead}
              disabled={markingAll}
              className="ed-btn-primary text-sm px-3 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-60"
            >
              {markingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
              Mark all read
            </button>
          )}

          {systemGroups.anomalies.length > 0 && (
            <div>
              <div className="text-xs font-bold mb-2" style={{ color: 'var(--ed-out)' }}>NEEDS ATTENTION</div>
              <div className="space-y-2">
                {systemGroups.anomalies.map((e) => (
                  <button
                    key={e.key}
                    onClick={() => onOpenMessage(e)}
                    className="w-full text-left ed-card p-3 flex items-center gap-3"
                    style={{ borderLeft: '3px solid var(--ed-out)' }}
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: 'var(--ed-out)' }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{e.subject || '(no subject)'}</div>
                      <div className="text-xs truncate" style={{ color: 'var(--ed-meta)' }}>{e.mailbox} · {fmtRelative(e.timestamp)}</div>
                    </div>
                    <span className="text-xs font-semibold shrink-0" style={{ color: 'var(--ed-out)' }}>Investigate</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {Array.from(systemGroups.byTrigger.entries()).map(([trigger, list]: [string, MailEntry[]]) => (
            <div key={trigger}>
              <div className="text-xs font-bold mb-2 flex items-center gap-2" style={{ color: 'var(--ed-system-text-2)' }}>
                {trigger.replace(/-/g, ' ').toUpperCase()}
                <span className="tabular-nums font-normal" style={{ color: 'var(--ed-system-text)' }}>{list.length}</span>
              </div>
              <div className="space-y-1.5">
                {list.slice(0, 20).map((e) => (
                  <button key={e.key} onClick={() => onOpenMessage(e)} className="w-full text-left ed-system p-3 flex items-center justify-between gap-3 dx-hoverable">
                    <span className="text-sm truncate" style={{ color: 'var(--ed-system-text-2)' }}>{e.subject || '(no subject)'}</span>
                    <span className="text-xs shrink-0" style={{ color: 'var(--ed-system-text)' }}>{fmtRelative(e.timestamp)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="p-10 text-center text-sm" style={{ color: 'var(--ed-meta)' }}>
              No system mail for this period.
            </div>
          )}
        </div>
      )}

      <div className="mt-6 pt-4" style={{ borderTop: '1px solid var(--ed-border)' }}>
        <button onClick={onSwitchToList} className="ed-action text-sm font-semibold" style={{ color: 'var(--ed-text-2)' }}>
          List view (legacy)
        </button>
      </div>
    </div>
  );
}
