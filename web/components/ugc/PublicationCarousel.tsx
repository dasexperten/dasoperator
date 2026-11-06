'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { deviceTargets } from '@/lib/browser-target.mjs';

export function PublicationCarousel({ children, count, label }: { children: ReactNode; count: number; label: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [sliding, setSliding] = useState(false);
  useEffect(() => {
    const targets = deviceTargets(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
    setSliding(targets.length === 1 && targets[0] === 'mac');
  }, []);

  return <div className="ugc-content-carousel" data-sliding={sliding} onClick={(event) => event.stopPropagation()}>
    <div ref={viewport} className="ugc-media" role="region" aria-label={`Публикации: ${label}, ${count}`} tabIndex={sliding ? 0 : -1} onKeyDown={(event) => {
      if (!sliding || event.target !== event.currentTarget) return;
      const view = viewport.current;
      if (!view) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        view.scrollBy({ left: (event.key === 'ArrowLeft' ? -1 : 1) * view.clientWidth * .85, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
      if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); view.scrollTo({ left: event.key === 'Home' ? 0 : view.scrollWidth }); }
    }}><div className="ugc-media-track">{children}</div></div>
  </div>;
}
