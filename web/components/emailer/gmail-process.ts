/** Gmail process helpers for Emailer. Visual design stays in mail-app CSS. */

export function stripSubjectPrefix(subject: string): string {
  return String(subject || '')
    .replace(/^\s*((re|fw|fwd|sv|aw)\s*:\s*)+/ig, '')
    .trim()
    .toLowerCase();
}

export function threadKey(e: {
  threadId?: string;
  messageId?: string;
  subject?: string;
  from?: string;
  to?: string | string[];
}): string {
  if (e.threadId) return `tid:${String(e.threadId).trim().toLowerCase()}`;
  const sub = stripSubjectPrefix(e.subject || '');
  const people = [
    emailOnly(e.from),
    ...(Array.isArray(e.to) ? e.to : e.to ? [e.to] : []).map(emailOnly),
  ].filter(Boolean).sort();
  if (sub && people.length) return `sub:${sub}|${people.join(',')}`;
  if (e.messageId) return `mid:${String(e.messageId).trim().toLowerCase()}`;
  return `lone:${sub || 'none'}`;
}

export function emailOnly(raw?: string): string {
  if (!raw) return '';
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim().toLowerCase();
}

export function withRe(subject: string): string {
  const s = String(subject || '').trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

export function withFwd(subject: string): string {
  const s = String(subject || '').trim();
  return /^(fw|fwd)\s*:/i.test(s) ? s : `Fwd: ${s}`;
}

const CACHE_KEY = 'dx_mail_feed_v3';

export function readFeedCache<T>(): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw || raw.length > 400_000) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries) || parsed.entries.length > 250) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

export function writeFeedCache(payload: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch { /* quota */ }
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}
