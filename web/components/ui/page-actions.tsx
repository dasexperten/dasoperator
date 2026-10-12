'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export default function MobilePageActions({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <div className="erp-page-actions" data-expanded={expanded}>
    <button type="button" className="erp-page-actions-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>Actions<ChevronDown size={16} /></button>
    <div id={id} className="erp-page-actions-content">{children}</div>
  </div>;
}
