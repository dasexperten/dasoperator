'use client';

import { useState, useEffect } from 'react';
import { Search } from 'lucide-react';

export default function Header() {
  const [now, setNow] = useState<string>('');

  useEffect(() => {
    const update = () => {
      const d = new Date();
      const time = d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
      setNow(time);
    };
    update();
    const interval = setInterval(update, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      {/* Top ribbon — 32px schwarz strip with tagline */}
      <div
        className="flex items-center justify-between px-8"
        style={{
          height: '32px',
          backgroundColor: 'var(--brand-schwarz)',
          color: 'var(--paper)',
          fontSize: 'var(--fs-micro)',
        }}
      >
        <div className="flex items-center gap-3">
          <span
           
            style={{ color: 'var(--stone-300)', fontSize: '14px' }}
          >
            ERP Portal
          </span>
          <span style={{ color: 'var(--stone-400)' }}>·</span>
          <span style={{ color: 'var(--stone-300)', fontSize: '14px' }}>
            Internal use only
          </span>
        </div>
        <div style={{ color: 'var(--stone-300)', fontSize: '14px' }}>
          {now} UTC
        </div>
      </div>

      {/* Primary header — paper canvas with search */}
      <header
        className="flex items-center justify-between px-8 bg-card"
        style={{
          height: '64px',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        <div className="flex items-center gap-4 flex-1 max-w-md">
          <div className="relative flex-1">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4"
              style={{ color: 'var(--fg-muted)' }}
            />
            <input
              type="text"
              placeholder="Search operations, products, partners..."
              className="w-full pl-10 pr-3 py-2 text-sm focus:outline-none"
              style={{
                backgroundColor: 'var(--paper-sunk)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--fg-1)',
              }}
            />
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div
           
            style={{ fontSize: '14px', color: 'var(--fg-3)' }}
          >
            DEE / DEI / DASEAN / DEC
          </div>
        </div>
      </header>
    </>
  );
}
