'use client';

import { createContext, useContext } from 'react';
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';

export const ArchiveHeaderContext = createContext<{
  collapsed: boolean;
  toggle: () => void;
} | null>(null);

// The ERP shell owns navigation; the mail toolbar supplies its single-row slot.
export function ArchiveHeaderControls() {
  const shell = useContext(ArchiveHeaderContext);
  if (!shell) return null;
  const Icon = shell.collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <div className="archive-header-controls">
      <button
        type="button"
        className="dx-emailer-nav-toggle"
        onClick={shell.toggle}
        aria-pressed={shell.collapsed}
        aria-label={shell.collapsed ? 'Показать меню ERP' : 'Скрыть меню ERP'}
        title={shell.collapsed ? 'Показать меню ERP' : 'Скрыть меню ERP'}
      >
        <Icon size={20} strokeWidth={2.2} />
        <span className="archive-menu-label">Меню</span>
      </button>
      <div className="archive-header-search">
        <Search size={16} aria-hidden="true" />
        <input type="text" aria-label="Поиск операций, товаров и партнёров" placeholder="Search operations, products, partners..." />
      </div>
    </div>
  );
}
