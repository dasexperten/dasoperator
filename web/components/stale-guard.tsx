'use client';
// Owner 2026-10-18: «То, что они не обновлялись со вчера, это есть проблема.» (Mina)
// An ERP tab left open overnight kept showing yesterday's data. Every screen loads once,
// so any screen could go stale. This guard reloads the page when the person comes back
// after a long absence: the computer slept (the clock jumped) or the tab was hidden 15+ min.
// It never reloads over unsaved typing. Rollback: remove <StaleGuard /> from app/layout.tsx.
import { useEffect } from 'react';

const AWAY_MS = 15 * 60_000;
const TICK_MS = 60_000;
const SLEEP_GAP_MS = 5 * 60_000;

function hasUnsavedInput(): boolean {
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  for (const el of Array.from(fields)) {
    if (el instanceof HTMLInputElement && ['hidden', 'checkbox', 'radio', 'button', 'submit', 'search'].includes(el.type)) continue;
    if (el.value !== el.defaultValue) return true;
  }
  const active = document.activeElement as HTMLElement | null;
  return Boolean(active && (active.isContentEditable || (active.tagName === 'TEXTAREA') || (active.tagName === 'INPUT' && (active as HTMLInputElement).value)));
}

export default function StaleGuard() {
  useEffect(() => {
    let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null;
    let lastTick = Date.now();
    let pending = false;
    const reloadIfSafe = () => {
      if (hasUnsavedInput()) { pending = true; return; }
      window.location.reload();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = null;
      if (away >= AWAY_MS || pending) reloadIfSafe();
    };
    const tick = window.setInterval(() => {
      const now = Date.now();
      const slept = now - lastTick > TICK_MS + SLEEP_GAP_MS;
      lastTick = now;
      if (slept && document.visibilityState === 'visible') reloadIfSafe();
    }, TICK_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.clearInterval(tick); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);
  return null;
}
