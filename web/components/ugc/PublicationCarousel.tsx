'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export function PublicationCarousel({ children, count, label }: { children: ReactNode; count: number; label: string }) {
  const container = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });

  useEffect(() => {
    const outer = container.current, view = viewport.current, content = track.current;
    if (!outer || !view || !content) return;
    const update = () => {
      const overflow = content.scrollWidth > outer.clientWidth + 1;
      const next = { overflow, left: overflow && view.scrollLeft > 1, right: overflow && view.scrollLeft + view.clientWidth < view.scrollWidth - 1 };
      setEdges((previous) => previous.overflow === next.overflow && previous.left === next.left && previous.right === next.right ? previous : next);
    };
    const observer = new ResizeObserver(update);
    observer.observe(outer); observer.observe(view); observer.observe(content);
    view.addEventListener('scroll', update, { passive: true });
    update();
    return () => { observer.disconnect(); view.removeEventListener('scroll', update); };
  }, [count]);

  const scroll = (direction: number) => {
    const view = viewport.current;
    if (view) view.scrollBy({ left: direction * view.clientWidth * 0.85, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  return <div ref={container} className="ugc-content-carousel" data-scrollable={edges.overflow} onClick={(event) => event.stopPropagation()}>
    <button type="button" className="ugc-content-scroll" aria-label={`Предыдущие публикации: ${label}`} disabled={!edges.left} onClick={() => scroll(-1)}><ChevronLeft aria-hidden="true" /></button>
    <div ref={viewport} className="ugc-media" role="region" aria-label={`Публикации: ${label}, ${count}`} tabIndex={edges.overflow ? 0 : -1} onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); scroll(event.key === 'ArrowLeft' ? -1 : 1); }
      if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); viewport.current?.scrollTo({ left: event.key === 'Home' ? 0 : viewport.current.scrollWidth }); }
    }}><div ref={track} className="ugc-media-track">{children}</div></div>
    <button type="button" className="ugc-content-scroll" aria-label={`Следующие публикации: ${label}`} disabled={!edges.right} onClick={() => scroll(1)}><ChevronRight aria-hidden="true" /></button>
  </div>;
}
