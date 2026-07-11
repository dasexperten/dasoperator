'use client';

import { displayName } from './shared';
import type { AttentionEntry } from '@/lib/api';

// Gold hero card — "AWAITING REPLY" (48h+). Spans 2 grid rows in the
// dashboard grid. Clicking opens the oldest-waiting correspondent's thread.
export default function AttentionCard({
  waiting,
  onOpen,
}: {
  waiting: AttentionEntry[];
  onOpen: (correspondent: string) => void;
}) {
  const top = waiting.slice(0, 5);

  return (
    <button
      onClick={() => waiting[0] && onOpen(waiting[0].correspondent)}
      disabled={waiting.length === 0}
      className="ed-hero row-span-2 text-left p-5 flex flex-col justify-between min-h-[220px] disabled:opacity-50"
    >
      <div>
        <div className="text-xs font-bold tracking-wide" style={{ color: 'var(--ed-gold-text-2)' }}>AWAITING REPLY</div>
        <div className="ed-display text-[40px] leading-none mt-2">{waiting.length}</div>
      </div>
      <div className="space-y-1 mt-4">
        {top.length === 0 ? (
          <div className="text-sm" style={{ color: 'var(--ed-gold-text-2)' }}>Nobody waiting 48h+</div>
        ) : (
          top.map((w) => (
            <div key={w.correspondent} className="text-sm font-semibold truncate">
              {displayName(w.correspondent)} <span className="font-normal" style={{ color: 'var(--ed-gold-text-2)' }}>· {w.hours_waiting}h</span>
            </div>
          ))
        )}
      </div>
    </button>
  );
}
