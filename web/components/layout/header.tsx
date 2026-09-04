'use client';

import { useState, useEffect } from 'react';
import { Search, Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

/**
 * Header — top of the main content area.
 *
 * Desktop:
 *  - 32px schwarz ribbon row with "ERP Portal · Internal use only · clock"
 *  - 64px main row with search input + entity list "DEE / DEI / DASEAN / DEC"
 *  - On /emailer: toggle to collapse/expand the ERP left sidebar (more mail space)
 *
 * Mobile:
 *  - Ribbon hidden via dx-header-ribbon → display:none
 *  - Main row collapses to 56px with: hamburger + brand mark + clock
 *  - Search input hidden (room reclaimed)
 *  - Entity list hidden
 *
 * Props:
 *   onHamburgerClick — fires when the mobile hamburger is tapped.
 *                      Opens the sidebar drawer.
 *   showEmailerNavToggle / emailerNavCollapsed / onEmailerNavToggle —
 *                      desktop ERP sidebar collapse on /emailer only.
 */
export default function Header({
  onHamburgerClick,
  showEmailerNavToggle = false,
  emailerNavCollapsed = false,
  onEmailerNavToggle,
}: {
  onHamburgerClick?: () => void;
  showEmailerNavToggle?: boolean;
  emailerNavCollapsed?: boolean;
  onEmailerNavToggle?: () => void;
}) {
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
      {/* Top ribbon — desktop only; class hooks CSS to hide on mobile */}
      <div
        className="dx-header-ribbon flex items-center justify-between px-8"
        style={{
          height: '32px',
          backgroundColor: 'var(--brand-schwarz)',
          color: 'var(--paper)',
          fontSize: 'var(--fs-micro)',
        }}
      >
        <div className="flex items-center gap-3">
          <span style={{ color: 'var(--stone-300)', fontSize: '14px' }}>
            ERP Portal
          </span>
          <span style={{ color: 'var(--fg-on-dark-2)' }}>·</span>
          <span style={{ color: 'var(--stone-300)', fontSize: '14px' }}>
            Internal use only
          </span>
        </div>
        <div style={{ color: 'var(--stone-300)', fontSize: '14px' }}>
          {now} UTC
        </div>
      </div>

      {/* Primary header */}
      <header
        className="dx-header-main flex items-center justify-between px-8 bg-card"
        style={{
          height: '64px',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        {/* Left cluster */}
        <div className="flex items-center gap-3 flex-1 max-w-md">
          {/* Hamburger — mobile only; opens drawer */}
          <button
            type="button"
            className="dx-hamburger"
            onClick={onHamburgerClick}
            aria-label="Open navigation"
          >
            <Menu className="h-6 w-6" />
          </button>

          {/* Desktop: collapse ERP left nav on /emailer for more reading width */}
          {showEmailerNavToggle && (
            <button
              type="button"
              className="dx-emailer-nav-toggle"
              onClick={onEmailerNavToggle}
              aria-pressed={emailerNavCollapsed}
              aria-label={emailerNavCollapsed ? 'Show ERP navigation' : 'Hide ERP navigation'}
              title={emailerNavCollapsed ? 'Показать меню ERP' : 'Скрыть меню ERP — больше места для почты'}
            >
              {emailerNavCollapsed ? (
                <PanelLeftOpen className="h-5 w-5" strokeWidth={2.2} />
              ) : (
                <PanelLeftClose className="h-5 w-5" strokeWidth={2.2} />
              )}
              <span className="dx-emailer-nav-toggle-label">
                {emailerNavCollapsed ? 'Меню' : 'Скрыть меню'}
              </span>
            </button>
          )}

          {/* Mobile-only brand mark — replaces the search bar visually */}
          <div
            className="dx-show-mobile dx-product-name"
            style={{ fontSize: '16px', color: 'var(--fg-1)', whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            das experten
            <sup style={{ fontSize: '10px', marginLeft: '2px', color: 'var(--brand-gold)' }}>®</sup>
          </div>

          {/* Desktop search — hidden on mobile via dx-header-search class */}
          <div className="dx-header-search relative flex-1">
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

        {/* Right cluster */}
        <div className="flex items-center gap-4">
          {/* Entity list — desktop only; class hides on mobile */}
          <div
            className="dx-header-entities"
            style={{ fontSize: '14px', color: 'var(--fg-3)' }}
          >
            DEE / DEI / DASEAN / DEC
          </div>
          {/* Mobile-only clock */}
          <div
            className="dx-show-mobile"
            style={{ fontSize: '13px', color: 'var(--fg-3)', fontWeight: 700 }}
          >
            {now}
          </div>
        </div>
      </header>
    </>
  );
}
