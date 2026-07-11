'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, AlertCircle, UserPlus, Reply } from 'lucide-react';
import { getOrdersFeed, type OrderFeedItem } from '@/lib/api';
import { type MailEntry, displayName, fmtDate } from './shared';

type Filter = 'all' | 'orders' | 'forms' | 'unprocessed';

function isOrderTrigger(trigger: string): boolean {
  return trigger === 'order-confirmation';
}

function toMailEntry(item: OrderFeedItem): MailEntry {
  return {
    key: item.key,
    mailbox: item.mailbox,
    direction: item.direction,
    timestamp: item.timestamp,
    subject: item.subject,
    from: item.direction === 'received' ? item.correspondent : item.mailbox,
    to: item.direction === 'sent' ? [item.correspondent] : [item.mailbox],
    origin: 'auto',
    trigger: item.trigger,
  };
}

export default function OrdersView({
  onBack,
  onOpenMessage,
}: {
  onBack: () => void;
  onOpenMessage: (entry: MailEntry) => void;
}) {
  const [period, setPeriod] = useState<'24h' | '7d'>('24h');
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<OrderFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getOrdersFeed(period)
      .then((r) => {
        if (cancelled) return;
        if (r.success && r.result) setItems(r.result.items);
        else setError(r.errors?.[0]?.message || 'Failed to load orders');
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  const filtered = useMemo(() => {
    return items.filter((i) => {
      if (filter === 'orders') return isOrderTrigger(i.trigger);
      if (filter === 'forms') return !isOrderTrigger(i.trigger);
      if (filter === 'unprocessed') return i.status === 'new';
      return true;
    });
  }, [items, filter]);

  const confirmedCount = items.filter((i) => isOrderTrigger(i.trigger)).length;

  return (
    <div className="emailer-dark ed-screen rounded-[14px] p-5">
      <button onClick={onBack} className="ed-action mb-4 flex items-center gap-1.5 text-sm" style={{ color: 'var(--ed-text-2)' }}>
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <div className="ed-display ed-h2 leading-none">Orders {items.length}</div>
          <div className="text-sm mt-1" style={{ color: 'var(--ed-gold)' }}>{confirmedCount} confirmed</div>
        </div>
        <div className="ed-toggle inline-flex rounded-lg p-0.5" style={{ background: 'var(--ed-card)' }}>
          {(['24h', '7d'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 text-sm font-bold rounded-md ${period === p ? 'ed-tab-active' : ''}`}
              style={{ color: period === p ? 'var(--ed-text)' : 'var(--ed-meta)' }}
            >
              {p === '24h' ? 'Last 24h' : 'Last 7d'}
            </button>
          ))}
        </div>
      </div>

      <div className="ed-tabs mb-5 text-sm">
        {([
          { key: 'all', label: 'All' },
          { key: 'orders', label: 'Orders' },
          { key: 'forms', label: 'Forms' },
          { key: 'unprocessed', label: 'Unprocessed' },
        ] as const).map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={filter === f.key ? 'ed-tab-active pb-1' : 'pb-1'}
            style={{ color: filter === f.key ? 'var(--ed-text)' : 'var(--ed-meta)' }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="p-10 text-center"><Loader2 className="h-7 w-7 animate-spin mx-auto" style={{ color: 'var(--ed-meta)' }} /></div>
      ) : error ? (
        <div className="p-4 flex items-center gap-2 rounded-md" style={{ background: 'var(--ed-card)' }}>
          <AlertCircle className="h-5 w-5" style={{ color: 'var(--ed-out)' }} /> <span className="text-sm">{error}</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-10 text-center text-sm" style={{ color: 'var(--ed-meta)' }}>Nothing here for this period.</div>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((item) => {
            const order = isOrderTrigger(item.trigger);
            return (
              <div
                key={item.key}
                className="ed-card p-4 ed-order-card"
                style={{ borderLeft: `3px solid ${order ? 'var(--ed-gold)' : 'var(--ed-in)'}` }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {!order && item.status === 'new' && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'var(--ed-new-bg)', color: 'var(--ed-in)' }}>NEW</span>
                    )}
                    <span className="text-sm font-semibold truncate" style={{ color: order ? 'var(--ed-gold)' : 'var(--ed-text)' }}>
                      {displayName(item.correspondent)}
                    </span>
                  </div>
                  <div className="text-xs truncate mt-0.5" style={{ color: 'var(--ed-text-2)' }}>{item.subject}</div>
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--ed-meta)' }}>
                    {item.trigger.replace(/-/g, ' ')} · {fmtDate(item.timestamp)} · {item.status}
                  </div>
                </div>
                <div className="ed-order-actions flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => onOpenMessage(toMailEntry(item))}
                    className="ed-action text-xs font-semibold px-2.5 py-1.5 rounded-md inline-flex items-center gap-1"
                    style={{ background: 'var(--ed-body)', color: 'var(--ed-text-2)' }}
                  >
                    <Reply className="h-3 w-3" /> Reply
                  </button>
                  <Link
                    href={`/partners/new?email=${encodeURIComponent(item.correspondent)}`}
                    className="ed-action text-xs font-semibold px-2.5 py-1.5 rounded-md inline-flex items-center gap-1"
                    style={{ background: 'var(--ed-body)', color: 'var(--ed-text-2)' }}
                  >
                    <UserPlus className="h-3 w-3" /> Create partner
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
