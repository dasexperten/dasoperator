'use client';

// =============================================================================
// DASOPERATOR MAIL — the two owner-approved mockups implemented verbatim over
// the live R2 mail archive:
//   docs/design/references/dasoperator-inbox-mpstats.jsx  (desktop, 3-pane)
//   docs/design/references/dasoperator-mail-swipe.jsx     (mobile, swipe rows)
// Colors, spacing, copy and interactions come from those files. Only the data
// layer is new: real mailboxes instead of the demo EMAILS array.
//
// Server truth is append-only (R2 archive), so star/archive/delete are
// client-side curation stored in localStorage; read-state also syncs to the
// /api/email/read endpoint.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Search, Star, Archive, Trash2, Send, Inbox as InboxIcon,
  FileText, Paperclip, Plus, Reply, Forward, ChevronLeft, ArrowLeft,
  MoreHorizontal, MoreVertical, Mail, AlertCircle, X, Undo2, Loader2,
  ChevronDown, Users, Building2, Menu,
} from 'lucide-react';
import {
  getMailboxes,
  getMailboxMessages,
  getMailboxMessage,
  getAttention,
  markMailRead,
  sendReply,
} from '@/lib/api';
import { correspondent, displayName, emailAddr } from './shared';
import {
  AGENT_MAILBOXES,
  DEPARTMENT_MAILBOXES,
  COMPOSE_FROM_ADDRESSES,
  OWNER_PERSONAL,
  agentAvatarUrl,
  addressesForMailbox,
  findUiMailbox,
  type UiMailbox,
} from './mailbox-registry';

/* ---------- Das Experten logo mark (three-ribbon app icon) ---------- */
function LogoMark({ size = 38 }: { size?: number }) {
  return (
    <img
      src="/brand/app-icon-squircle-512.png"
      width={size}
      height={size}
      alt="das experten"
      style={{ display: 'block', flexShrink: 0 }}
    />
  );
}

const FOLDERS = [
  { id: 'inbox', label: 'Входящие', icon: InboxIcon },
  { id: 'starred', label: 'Важные', icon: Star },
  { id: 'sent', label: 'Отправленные', icon: Send },
  { id: 'drafts', label: 'Черновики', icon: FileText },
  { id: 'archive', label: 'Архив', icon: Archive },
] as const;

// Mobile bottom nav: the four folders in the mockup's order; Отправленные
// stays desktop-sidebar-only.
const MOBILE_FOLDERS = (['inbox', 'starred', 'archive', 'drafts'] as const).map(
  (id) => FOLDERS.find((f) => f.id === id)!
);

type FolderId = (typeof FOLDERS)[number]['id'];

// Tag pill palette from the mockups. Real letters are tagged by the mailbox
// they live in (business language), system/auto mail gets a muted gray.
const TAG_STYLES: Array<{ bg: string; fg: string; dot: string }> = [
  { bg: 'rgba(229, 32, 44, 0.10)', fg: '#B81A24', dot: '#E5202C' },
  { bg: 'rgba(40, 34, 41, 0.08)', fg: '#282229', dot: '#282229' },
  { bg: '#E8F4FF', fg: '#1B84FF', dot: '#1B84FF' },
  { bg: '#FFF4E5', fg: '#F5920A', dot: '#F5920A' },
  { bg: '#FFEDF3', fg: '#F0447C', dot: '#F0447C' },
];
const TAG_SYSTEM = { bg: '#F1F3F5', fg: '#5B6B7A', dot: '#93A1AE' };
/* CRM brand + product-line accents (no mock green) */
const AVA_COLORS = ['#E5202C', '#282229', '#0D199E', '#0E7C66', '#FE7F2D'];

// Compose From = departments + agents. Owner personal (dr.badalyan@) is
// excluded — personal mail is Gmail-only, not an ERP agent folder.
const APEX_SENDERS = COMPOSE_FROM_ADDRESSES;

const LS_LIST_WIDTH = 'dx_mail_list_width_v1';
const LIST_WIDTH_DEFAULT = 372;
const LIST_WIDTH_MIN = 280;
const LIST_WIDTH_MAX = 720;

function loadListWidth(): number {
  if (typeof window === 'undefined') return LIST_WIDTH_DEFAULT;
  try {
    const n = Number(window.localStorage.getItem(LS_LIST_WIDTH));
    if (Number.isFinite(n) && n >= LIST_WIDTH_MIN && n <= LIST_WIDTH_MAX) return n;
  } catch { /* ignore */ }
  return LIST_WIDTH_DEFAULT;
}

/** Desktop: drag handle between list and detail (left/right). */
function useListPaneResize() {
  const [listWidth, setListWidth] = useState(LIST_WIDTH_DEFAULT);
  useEffect(() => { setListWidth(loadListWidth()); }, []);

  const onSplitterDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = listWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, startW + (ev.clientX - startX)));
      setListWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setListWidth((w) => {
        try { window.localStorage.setItem(LS_LIST_WIDTH, String(w)); } catch { /* ignore */ }
        return w;
      });
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [listWidth]);

  return { listWidth, onSplitterDown };
}

type MailboxScope = null | { kind: 'agent' | 'department'; address: string };

function AgentAvatar({ slug, label, size = 28 }: { slug?: string; label: string; size?: number }) {
  // Prefer same-origin /agents/{slug}.png; if missing, one CDN retry then initials.
  const [src, setSrc] = useState<string | null>(slug ? agentAvatarUrl(slug) : null);
  const [triedCdn, setTriedCdn] = useState(false);

  if (!slug || !src) {
    return (
      <span
        className="nav-ava nav-ava-fallback"
        style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36) }}
        aria-hidden
      >
        {initialsOf(label)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="nav-ava"
      src={src}
      width={size}
      height={size}
      alt=""
      style={{ width: size, height: size }}
      onError={() => {
        if (!triedCdn) {
          setTriedCdn(true);
          setSrc(`https://www.dasexperten.com/assets/agents/${slug}.png`);
          return;
        }
        setSrc(null);
      }}
    />
  );
}

function hashIdx(seed: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % mod;
}

function fmtTime(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 24 * 60 * 60 * 1000;
  if (t.getTime() >= startToday) {
    return t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  if (t.getTime() >= startToday - DAY) return 'Вчера';
  return t.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? parts[1]?.[0] ?? '' : parts[0]?.[1] ?? '';
  return (first + second).toUpperCase();
}

interface MailItem {
  id: string;            // `${mailbox}:${key}` — stable across reloads
  key: string;
  mailbox: string;
  direction: 'sent' | 'received';
  timestamp: string;
  from: string;          // counterparty display name
  org: string;           // counterparty bare address
  initial: string;
  color: string;
  subject: string;
  preview: string;       // mailbox the letter lives in (no body in the index)
  time: string;
  unread: boolean;
  starred: boolean;
  tag: string;
  tagStyle: { bg: string; fg: string; dot: string };
  priority: 'high' | 'normal';
  folder: FolderId;      // resolved folder after local curation
}

// ---- localStorage curation sets -------------------------------------------
const LS = {
  read: 'dx_mail_read_v2',
  star: 'dx_mail_star',
  arch: 'dx_mail_arch',
  del: 'dx_mail_del',
};

function loadSet(k: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    return new Set(JSON.parse(window.localStorage.getItem(k) || '[]'));
  } catch {
    return new Set();
  }
}
function saveSet(k: string, s: Set<string>) {
  try {
    window.localStorage.setItem(k, JSON.stringify(Array.from(s)));
  } catch { /* quota/private mode — curation just won't persist */ }
}

function tagFor(mailbox: string, origin: 'human' | 'auto'): { tag: string; style: { bg: string; fg: string; dot: string } } {
  if (origin === 'auto') return { tag: 'Система', style: TAG_SYSTEM };
  const local = mailbox.split('@')[0] || mailbox;
  return { tag: local, style: TAG_STYLES[hashIdx(local, TAG_STYLES.length)]! };
}

// =============================================================================
// Data hook — one merged, curated mail model shared by both layouts.
// =============================================================================
function useMailData() {
  const [raw, setRaw] = useState<Array<{
    key: string; mailbox: string; direction: 'sent' | 'received'; timestamp: string;
    subject: string; from?: string; to?: string | string[]; origin?: 'human' | 'auto'; trigger?: string;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attentionAddrs, setAttentionAddrs] = useState<Set<string>>(new Set());
  const [readSet, setReadSet] = useState<Set<string>>(new Set());
  const [starSet, setStarSet] = useState<Set<string>>(new Set());
  const [archSet, setArchSet] = useState<Set<string>>(new Set());
  const [delSet, setDelSet] = useState<Set<string>>(new Set());

  useEffect(() => {
    setReadSet(loadSet(LS.read));
    setStarSet(loadSet(LS.star));
    setArchSet(loadSet(LS.arch));
    setDelSet(loadSet(LS.del));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const mb = await getMailboxes();
      if (!mb.success || !mb.result) {
        setError(mb.errors?.[0]?.message || 'Не удалось загрузить почту');
        setRaw([]);
        return;
      }
      // Skip Owner personal if any legacy R2 index still exists.
      const addresses = mb.result.mailboxes
        .map((m) => m.address)
        .filter((a) => a.toLowerCase() !== OWNER_PERSONAL);
      const lists = await Promise.all(
        addresses.map(async (address) => {
          try {
            const r = await getMailboxMessages(address);
            return r.success && r.result ? r.result.entries.map((e) => ({ ...e, mailbox: address })) : [];
          } catch {
            return [];
          }
        })
      );
      setRaw(lists.flat().sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || '')));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки');
      setRaw([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    getAttention()
      .then((r) => {
        if (r.success && r.result) setAttentionAddrs(new Set(r.result.waiting.map((w) => emailAddr(w.correspondent))));
      })
      .catch(() => { /* best-effort priority signal */ });
  }, [load]);

  const items: MailItem[] = useMemo(() => {
    return raw
      .map((e) => {
        const id = `${e.mailbox}:${e.key}`;
        if (delSet.has(id)) return null;
        const who = correspondent(e) || e.mailbox;
        const bare = emailAddr(who);
        const name = displayName(who);
        const origin: 'human' | 'auto' = e.origin ?? (e.mailbox.includes('@my.') || e.mailbox.includes('@notify.') ? 'auto' : 'human');
        const { tag, style } = tagFor(e.mailbox, origin);
        const folder: FolderId = archSet.has(id) ? 'archive' : e.direction === 'sent' ? 'sent' : 'inbox';
        return {
          id,
          key: e.key,
          mailbox: e.mailbox,
          direction: e.direction,
          timestamp: e.timestamp,
          from: name,
          org: bare,
          initial: initialsOf(name),
          color: AVA_COLORS[hashIdx(bare, AVA_COLORS.length)]!,
          subject: e.subject || '(без темы)',
          preview: e.mailbox,
          time: fmtTime(e.timestamp),
          unread: e.direction === 'received' && !readSet.has(id),
          starred: starSet.has(id),
          tag,
          tagStyle: style,
          priority: (e.direction === 'received' && attentionAddrs.has(bare) ? 'high' : 'normal') as 'high' | 'normal',
          folder,
        };
      })
      .filter(Boolean) as MailItem[];
  }, [raw, readSet, starSet, archSet, delSet, attentionAddrs]);

  const markRead = useCallback((it: MailItem) => {
    setReadSet((prev) => {
      if (prev.has(it.id)) return prev;
      const next = new Set(prev);
      next.add(it.id);
      saveSet(LS.read, next);
      return next;
    });
    if (it.direction === 'received') markMailRead([it.key], it.mailbox).catch(() => { /* best-effort */ });
  }, []);

  const toggleStar = useCallback((id: string) => {
    setStarSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveSet(LS.star, next);
      return next;
    });
  }, []);

  const archive = useCallback((id: string) => {
    setArchSet((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveSet(LS.arch, next);
      return next;
    });
  }, []);

  const unarchive = useCallback((id: string) => {
    setArchSet((prev) => {
      const next = new Set(prev);
      next.delete(id);
      saveSet(LS.arch, next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setDelSet((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveSet(LS.del, next);
      return next;
    });
  }, []);

  const restore = useCallback((id: string) => {
    setDelSet((prev) => {
      const next = new Set(prev);
      next.delete(id);
      saveSet(LS.del, next);
      return next;
    });
  }, []);

  // Bulk operations for the selection checkboxes ("клетка") — one state pass
  // per set, one read-sync call per mailbox.
  const bulkRead = useCallback((list: MailItem[]) => {
    setReadSet((prev) => {
      const next = new Set(prev);
      for (const it of list) next.add(it.id);
      saveSet(LS.read, next);
      return next;
    });
    const byMailbox = new Map<string, string[]>();
    for (const it of list) {
      if (it.direction !== 'received') continue;
      if (!byMailbox.has(it.mailbox)) byMailbox.set(it.mailbox, []);
      byMailbox.get(it.mailbox)!.push(it.key);
    }
    for (const [mailbox, keys] of Array.from(byMailbox.entries())) {
      markMailRead(keys, mailbox).catch(() => { /* best-effort */ });
    }
  }, []);

  const bulkArchive = useCallback((ids: string[]) => {
    setArchSet((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      saveSet(LS.arch, next);
      return next;
    });
  }, []);

  const bulkUnarchive = useCallback((ids: string[]) => {
    setArchSet((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      saveSet(LS.arch, next);
      return next;
    });
  }, []);

  const bulkRemove = useCallback((ids: string[]) => {
    setDelSet((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      saveSet(LS.del, next);
      return next;
    });
  }, []);

  const bulkRestore = useCallback((ids: string[]) => {
    setDelSet((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      saveSet(LS.del, next);
      return next;
    });
  }, []);

  return {
    items, loading, error, reload: load, markRead, toggleStar, archive, unarchive, remove, restore,
    bulkRead, bulkArchive, bulkUnarchive, bulkRemove, bulkRestore,
  };
}

// Selection state shared by both layouts: id set + handy derived bits.
function useSelection(visible: MailItem[]) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const clear = useCallback(() => setChecked(new Set()), []);
  const allVisible = visible.length > 0 && visible.every((e) => checked.has(e.id));
  const toggleAll = useCallback(() => {
    setChecked((prev) => {
      if (visible.length > 0 && visible.every((e) => prev.has(e.id))) return new Set();
      return new Set(visible.map((e) => e.id));
    });
  }, [visible]);
  const selectedItems = visible.filter((e) => checked.has(e.id));
  return { checked, toggle, clear, allVisible, toggleAll, selectedItems };
}

// Small selection checkbox — the mockup's green on the same 10px radius family.
function RowCheck({ on, onToggle, label }: { on: boolean; onToggle: () => void; label?: string }) {
  return (
    <button
      className={`rowcheck ${on ? 'on' : ''}`}
      role="checkbox"
      aria-checked={on}
      aria-label={label || 'Выбрать письмо'}
      onClick={(ev) => { ev.stopPropagation(); onToggle(); }}
    >
      {on && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M1.5 5.2L4 7.6L8.5 2.4" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

// Full body of an opened letter (index has no bodies).
function useMailBody(item: MailItem | null) {
  const [body, setBody] = useState<{ text?: string; html?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!item) { setBody(null); return; }
    let cancelled = false;
    setLoading(true);
    setBody(null);
    getMailboxMessage(item.mailbox, item.key)
      .then((r) => {
        if (!cancelled && r.success && r.result) setBody({ text: r.result.record.text, html: r.result.record.html });
      })
      .catch(() => { /* body stays empty, header still useful */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return { body, loading };
}

// Long subjects shrink instead of wrapping into 3-4 lines (owner's acceptance
// condition): size tier by length, CSS caps the block at two lines + ellipsis.
function subjSizeClass(subject: string): string {
  const n = subject.length;
  if (n > 140) return 'sz4';
  if (n > 90) return 'sz3';
  if (n > 50) return 'sz2';
  return '';
}

function replyFromFor(item: MailItem): string {
  const mb = item.mailbox.toLowerCase();
  if (mb === OWNER_PERSONAL) return 'sales@dasexperten.com';
  return APEX_SENDERS.includes(mb) ? mb : 'sales@dasexperten.com';
}

function mailboxUnread(items: MailItem[], m: UiMailbox): number {
  const set = new Set(addressesForMailbox(m));
  return items.filter((i) => i.folder === 'inbox' && i.unread && set.has(i.mailbox.toLowerCase())).length;
}

function matchesScope(item: MailItem, scope: MailboxScope): boolean {
  if (!scope) return true;
  const def = findUiMailbox(scope.address);
  if (!def) return item.mailbox.toLowerCase() === scope.address.toLowerCase();
  return addressesForMailbox(def).includes(item.mailbox.toLowerCase());
}

// Owner 2026-07-26: a link inside a letter must open in the browser on click.
// Two cases, two fixes — see below. Security stays narrow: an incoming letter
// never gets scripts, forms, or our origin (no allow-same-origin => no access
// to ERP cookies/storage). Only navigation-to-a-new-tab is unlocked.
const HTML_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

// Force every link in an HTML letter into a new tab, whether or not the sender
// set a target. <base> goes right after <head> (or in front, when the letter
// has no head at all — browsers hoist it).
function withBlankTarget(html: string): string {
  const base = '<base target="_blank">';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + base);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${base}</head>`);
  return base + html;
}

// Plain-text letters arrive as a raw string, so URLs are dead characters.
// Split on urls / bare www. / e-mail addresses and wrap the matches.
const LINK_RE = /((?:https?:\/\/|www\.)[^\s<>()[\]{}"']+[^\s<>()[\]{}"'.,;:!?]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function linkifyText(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text)) !== null) {
    const raw = m[0];
    if (m.index > last) out.push(text.slice(last, m.index));
    const isMail = raw.includes('@') && !/^https?:\/\//i.test(raw);
    const href = isMail ? `mailto:${raw}` : raw.startsWith('www.') ? `https://${raw}` : raw;
    out.push(
      <a
        key={`${m.index}-${raw}`}
        href={href}
        target={isMail ? undefined : '_blank'}
        rel="noopener noreferrer nofollow"
      >
        {raw}
      </a>
    );
    last = m.index + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function BodyView({ item, body, loading }: { item: MailItem; body: { text?: string; html?: string } | null; loading: boolean }) {
  if (loading) return <Loader2 className="dxmail-spin" size={20} />;
  if (body?.html) {
    return (
      <iframe
        srcDoc={withBlankTarget(body.html)}
        sandbox={HTML_SANDBOX}
        referrerPolicy="no-referrer"
        title={item.subject}
        style={{ width: '100%', minHeight: 320, height: '100%', border: 'none', borderRadius: 0, background: '#fff' }}
      />
    );
  }
  return <>{body?.text ? linkifyText(body.text) : '(пустое письмо)'}</>;
}

function folderCounts(items: MailItem[]) {
  const inboxUnread = items.filter((i) => i.folder === 'inbox' && i.unread).length;
  return { inboxUnread };
}

// =============================================================================
// Shared compose modal (Написать письмо / FAB) — dcard styling from mockups.
// =============================================================================
function ComposeModal({
  initial,
  onClose,
  onSent,
}: {
  initial?: { to?: string; subject?: string; text?: string };
  onClose: () => void;
  onSent: (msg: string) => void;
}) {
  const [from, setFrom] = useState(APEX_SENDERS[0]!);
  const [to, setTo] = useState(initial?.to || '');
  const [subject, setSubject] = useState(initial?.subject || '');
  const [text, setText] = useState(initial?.text || '');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!to || !subject || !text) { setErr('Заполните кому, тему и текст.'); return; }
    setSending(true);
    setErr(null);
    try {
      const r = await sendReply({ to, subject, text, from });
      if (r.success) { onSent('Письмо отправлено'); onClose(); }
      else setErr(r.error || 'Не удалось отправить');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось отправить');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="cmodal-backdrop" onClick={onClose}>
      <div className="cmodal" onClick={(e) => e.stopPropagation()}>
        <div className="cmodal-head">
          <div className="cmodal-title">Новое письмо</div>
          <button className="abtn" onClick={onClose} aria-label="Закрыть"><X size={18} /></button>
        </div>
        <label className="cmodal-label">От кого
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {APEX_SENDERS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="cmodal-label">Кому
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="partner@company.com" />
        </label>
        <label className="cmodal-label">Тема
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Тема письма" />
        </label>
        <label className="cmodal-label">Текст
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} placeholder="Текст письма…" />
        </label>
        {err && <div className="cmodal-err"><AlertCircle size={14} /> {err}</div>}
        <div className="cmodal-actions">
          <button className="sendb" onClick={submit} disabled={sending}>
            {sending ? <Loader2 size={14} className="dxmail-spin" /> : <Send size={13} />} Отправить
          </button>
          <button className="cmodal-cancel" onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// DESKTOP — dasoperator-inbox-mpstats.jsx over live data
// =============================================================================
function DesktopMail({ data, toast }: { data: ReturnType<typeof useMailData>; toast: (t: string, undo?: () => void) => void }) {
  const { items, loading, error, markRead, toggleStar, archive, unarchive, remove, restore } = data;
  const [activeFolder, setActiveFolder] = useState<FolderId>('inbox');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compose, setCompose] = useState<{ to?: string; subject?: string; text?: string } | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);
  const replyRef = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<MailboxScope>(null);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [deptsOpen, setDeptsOpen] = useState(true);
  const { listWidth, onSplitterDown } = useListPaneResize();

  const visible = useMemo(() => {
    let list = items.filter((e) => (activeFolder === 'starred' ? e.starred && e.folder !== 'archive' : e.folder === activeFolder));
    list = list.filter((e) => matchesScope(e, scope));
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (e) => e.subject.toLowerCase().includes(q) || e.from.toLowerCase().includes(q) || e.org.toLowerCase().includes(q)
      );
    }
    return list;
  }, [items, activeFolder, query, scope]);

  const selected = items.find((e) => e.id === selectedId) || null;
  const { body, loading: bodyLoading } = useMailBody(selected);
  const sel = useSelection(visible);

  // Bulk actions over the checked letters (Gmail-style checkboxes).
  const bulkBar = {
    read: () => { data.bulkRead(sel.selectedItems); sel.clear(); },
    archive: () => {
      const ids = sel.selectedItems.map((e) => e.id);
      data.bulkArchive(ids);
      sel.clear();
      toast(`В архиве: ${ids.length}`, () => data.bulkUnarchive(ids));
    },
    remove: () => {
      const ids = sel.selectedItems.map((e) => e.id);
      data.bulkRemove(ids);
      sel.clear();
      toast(`Удалено: ${ids.length}`, () => data.bulkRestore(ids));
    },
  };

  const { inboxUnread } = folderCounts(items);
  const urgentCount = items.filter((e) => e.folder === 'inbox' && e.priority === 'high').length;
  const repliesToday = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return items.filter((e) => e.direction === 'sent' && Date.parse(e.timestamp) >= start.getTime() && e.tag !== 'Система').length;
  }, [items]);
  const urgentNote = items.filter((e) => e.folder === 'inbox' && e.priority === 'high').slice(0, 2);

  const openEmail = (it: MailItem) => {
    setSelectedId(it.id);
    setReplyText('');
    markRead(it);
  };

  async function submitReply() {
    if (!selected || !replyText.trim() || replySending) return;
    setReplySending(true);
    try {
      const r = await sendReply({
        to: selected.org,
        subject: selected.subject.toLowerCase().startsWith('re:') ? selected.subject : `Re: ${selected.subject}`,
        text: replyText,
        from: replyFromFor(selected),
      });
      if (r.success) { setReplyText(''); toast('Ответ отправлен'); }
      else toast(r.error || 'Не удалось отправить');
    } catch {
      toast('Не удалось отправить');
    } finally {
      setReplySending(false);
    }
  }

  return (
    <div className="shell">
      {/* Top bar */}
      <div className="topbar">
        <LogoMark size={34} />
        <div>
          <div className="brand-name">DASOPERATOR</div>
          <div className="brand-tag">Почта</div>
        </div>
        <div className="stats-strip">
          <div className="stat-chip"><span className="stat-num hot">{inboxUnread}</span><span className="stat-lab">Непрочитанных</span></div>
          <div className="stat-chip"><span className="stat-num">{urgentCount}</span><span className="stat-lab">Ждут ответа</span></div>
          <div className="stat-chip"><span className="stat-num">{repliesToday}</span><span className="stat-lab">Ответов сегодня</span></div>
        </div>
      </div>

      <div className="mainrow">
        {/* Sidebar */}
        <div className="sidebar">
          <button className="compose" onClick={() => setCompose({})}>
            <Plus size={16} strokeWidth={3} /> Написать письмо
          </button>

          {FOLDERS.map((f) => {
            const Icon = f.icon;
            const active = activeFolder === f.id && !scope;
            const count = f.id === 'inbox' ? inboxUnread : 0;
            return (
              <div
                key={f.id}
                className={`folder ${active ? 'active' : ''}`}
                onClick={() => { setActiveFolder(f.id); setScope(null); setSelectedId(null); sel.clear(); }}
              >
                <Icon size={16} strokeWidth={2.4} />
                {f.label}
                {count > 0 && <span className="fcount">{count}</span>}
              </div>
            );
          })}

          {/* Agents accordion — no dr.badalyan (Owner reads Gmail) */}
          <button type="button" className={`nav-section-h ${agentsOpen ? 'open' : ''}`} onClick={() => setAgentsOpen((v) => !v)}>
            <Users size={14} strokeWidth={2.4} />
            <span>Agents</span>
            <ChevronDown size={14} className="nav-chevron" />
          </button>
          {agentsOpen && (
            <div className="nav-section-body">
              {AGENT_MAILBOXES.map((m) => {
                const active = scope?.kind === 'agent' && scope.address === m.address;
                const u = mailboxUnread(items, m);
                return (
                  <div
                    key={m.address}
                    className={`folder nav-person ${active ? 'active' : ''}`}
                    title={m.address}
                    onClick={() => {
                      setScope({ kind: 'agent', address: m.address });
                      setActiveFolder('inbox');
                      setSelectedId(null);
                      sel.clear();
                    }}
                  >
                    <AgentAvatar slug={m.slug} label={m.label} size={26} />
                    <span className="nav-person-label">{m.label.split(' ')[0]}</span>
                    {u > 0 && <span className="fcount">{u}</span>}
                  </div>
                );
              })}
            </div>
          )}

          {/* Departments (not "pipes") */}
          <button type="button" className={`nav-section-h ${deptsOpen ? 'open' : ''}`} onClick={() => setDeptsOpen((v) => !v)}>
            <Building2 size={14} strokeWidth={2.4} />
            <span>Departments</span>
            <ChevronDown size={14} className="nav-chevron" />
          </button>
          {deptsOpen && (
            <div className="nav-section-body">
              {DEPARTMENT_MAILBOXES.map((m) => {
                const active = scope?.kind === 'department' && scope.address === m.address;
                const u = mailboxUnread(items, m);
                return (
                  <div
                    key={m.address}
                    className={`folder nav-person ${active ? 'active' : ''}`}
                    title={m.address}
                    onClick={() => {
                      setScope({ kind: 'department', address: m.address });
                      setActiveFolder('inbox');
                      setSelectedId(null);
                      sel.clear();
                    }}
                  >
                    <span className="nav-dept-dot" aria-hidden />
                    <span className="nav-person-label">{m.label}</span>
                    {u > 0 && <span className="fcount">{u}</span>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="sidebar-note">
            {urgentNote.length > 0 ? (
              <><b>{urgentNote.length === 1 ? '1 срочный тред ждёт' : `${urgentCount} срочных треда ждут`} ответа:</b>{' '}
                {urgentNote.map((e) => e.from).join(' и ')}.</>
            ) : (
              <><b>Всё отвечено.</b> Срочных тредов, ждущих ответа 48+ часов, нет.</>
            )}
          </div>
        </div>

        {/* List — width resizable via splitter to the right */}
        <div className="list" style={{ width: listWidth }}>
          <div className="search-wrap">
            <div className="search">
              <Search size={14} color="#93A1AE" />
              <input placeholder="Поиск по письмам..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>

          {/* Select-all + bulk actions (Gmail-style) */}
          <div className="selbar">
            <RowCheck on={sel.allVisible} onToggle={sel.toggleAll} label="Выбрать все" />
            {sel.selectedItems.length > 0 ? (
              <>
                <span className="selcount">Выбрано: {sel.selectedItems.length}</span>
                <div className="selactions">
                  <button className="ibtn" onClick={bulkBar.read} aria-label="Отметить прочитанными" title="Прочитано"><Mail size={14} /></button>
                  <button className="ibtn" onClick={bulkBar.archive} aria-label="В архив" title="В архив"><Archive size={14} /></button>
                  <button className="ibtn" onClick={bulkBar.remove} aria-label="Удалить" title="Удалить"><Trash2 size={14} /></button>
                </div>
              </>
            ) : (
              <span className="selhint">Выбрать все</span>
            )}
          </div>

          <div className="rows">
            {loading && <div className="empty"><Loader2 className="dxmail-spin" size={18} /></div>}
            {!loading && error && <div className="empty">{error}</div>}
            {!loading && !error && visible.length === 0 && <div className="empty">Здесь пока пусто</div>}
            {visible.map((e) => (
              <div key={e.id} className={`row ${selectedId === e.id ? 'selected' : ''} ${sel.checked.has(e.id) ? 'checked' : ''} ${e.unread ? 'unread' : ''}`} onClick={() => openEmail(e)}>
                <RowCheck on={sel.checked.has(e.id)} onToggle={() => sel.toggle(e.id)} />
                <div className="ava" style={{ background: e.color }}>{e.initial}</div>
                <div className="rmain">
                  <div className="rtop">
                    <div className={`rfrom ${e.unread ? '' : 'read'}`}>{e.from}</div>
                    <div className="rtime">{e.time}</div>
                  </div>
                  <div className={`rsub ${e.unread ? '' : 'read'}`}>{e.subject}</div>
                  <div className="rprev">{e.direction === 'received' ? '→' : '←'} {e.preview}</div>
                  <div className="rtags">
                    <span className="pill" style={{ background: e.tagStyle.bg, color: e.tagStyle.fg }}>
                      <span className="pill-dot" style={{ background: e.tagStyle.dot }} />
                      {e.tag}
                    </span>
                    {e.priority === 'high' && <span className="prio">СРОЧНО</span>}
                    <button className={`starb ${e.starred ? 'on' : ''}`} onClick={(ev) => { ev.stopPropagation(); toggleStar(e.id); }} aria-label="Пометить важным">
                      <Star size={14} fill={e.starred ? '#FFB020' : 'none'} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Resizable boundary between list and email preview (drag left/right) */}
        <div
          className="pane-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Изменить ширину списка писем"
          aria-valuenow={listWidth}
          aria-valuemin={LIST_WIDTH_MIN}
          aria-valuemax={LIST_WIDTH_MAX}
          onMouseDown={onSplitterDown}
        />

        {/* Detail */}
        <div className="detail">
          {selected ? (
            <>
              <div className="dcard">
                <div className="dhead">
                  <button className="back-btn" onClick={() => setSelectedId(null)} aria-label="Закрыть письмо"><ChevronLeft size={16} /></button>
                  {(() => {
                    const mb = findUiMailbox(selected.mailbox);
                    if (mb?.kind === 'agent' && mb.slug) {
                      return <AgentAvatar slug={mb.slug} label={mb.label} size={44} />;
                    }
                    return <div className="ava" style={{ background: selected.color, width: 44, height: 44, fontSize: 14 }}>{selected.initial}</div>;
                  })()}
                  <div style={{ minWidth: 0 }}>
                    <div className={`dsub ${subjSizeClass(selected.subject)}`}>{selected.subject}</div>
                    <div className="dmeta">{selected.from} · {selected.org} · {selected.time}</div>
                  </div>
                  <div className="dactions">
                    <button className="ibtn" onClick={() => replyRef.current?.focus()} aria-label="Ответить"><Reply size={15} /></button>
                    <button
                      className="ibtn"
                      aria-label="Переслать"
                      onClick={() => setCompose({ subject: `Fwd: ${selected.subject}`, text: body?.text ? `\n\n--- Пересланное письмо ---\n${body.text}` : '' })}
                    ><Forward size={15} /></button>
                    <button
                      className="ibtn"
                      aria-label={selected.folder === 'archive' ? 'Вернуть из архива' : 'В архив'}
                      onClick={() => {
                        const id = selected.id;
                        if (selected.folder === 'archive') { unarchive(id); toast('Возвращено из архива'); }
                        else { archive(id); toast('Перемещено в архив', () => unarchive(id)); }
                        setSelectedId(null);
                      }}
                    ><Archive size={15} /></button>
                    <button
                      className="ibtn"
                      aria-label="Удалить"
                      onClick={() => {
                        const id = selected.id;
                        remove(id);
                        toast('Письмо удалено', () => restore(id));
                        setSelectedId(null);
                      }}
                    ><Trash2 size={15} /></button>
                    <button className="ibtn" aria-label="Ещё"><MoreHorizontal size={15} /></button>
                  </div>
                </div>

                <div className="dbody">
                  <BodyView item={selected} body={body} loading={bodyLoading} />
                </div>
              </div>

              <div className="replybar">
                <input
                  ref={replyRef}
                  placeholder={`Ответить: ${selected.from}...`}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitReply(); }}
                />
                <button className="sendb" onClick={submitReply} disabled={replySending}>
                  {replySending ? <Loader2 size={13} className="dxmail-spin" /> : <Send size={13} />} Отправить
                </button>
              </div>
            </>
          ) : (
            <div className="nosel">
              <LogoMark size={52} />
              <div className="nosel-t">Выберите письмо</div>
              <div className="nosel-s">Откройте тред слева, чтобы увидеть содержимое и ответить.</div>
            </div>
          )}
        </div>
      </div>

      {compose && <ComposeModal initial={compose} onClose={() => setCompose(null)} onSent={(m) => toast(m)} />}
    </div>
  );
}

// =============================================================================
// MOBILE — dasoperator-mail-swipe.jsx over live data (pure touch swipes)
// =============================================================================
function SwipeableRow({
  email, onOpen, onStar, onArchive, onDelete, checked, selectionActive, onToggleCheck,
}: {
  email: MailItem;
  onOpen: (id: string) => void;
  onStar: (id: string, ev: React.MouseEvent) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  checked: boolean;
  selectionActive: boolean;
  onToggleCheck: (id: string) => void;
}) {
  const [dx, setDx] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [leaving, setLeaving] = useState<null | 'left' | 'right'>(null);
  const touch = useRef({ startX: 0, startY: 0, active: false, locked: null as null | 'h' | 'v', width: 1 });

  const THRESHOLD = 0.35;

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.touches[0]!;
    touch.current = {
      startX: t.clientX,
      startY: t.clientY,
      active: true,
      locked: null,
      width: (e.currentTarget as HTMLDivElement).offsetWidth || 1,
    };
    setAnimating(false);
  };

  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!touch.current.active) return;
    const t = e.touches[0]!;
    const moveX = t.clientX - touch.current.startX;
    const moveY = t.clientY - touch.current.startY;
    if (touch.current.locked === null) {
      if (Math.abs(moveX) < 8 && Math.abs(moveY) < 8) return;
      touch.current.locked = Math.abs(moveX) > Math.abs(moveY) ? 'h' : 'v';
    }
    if (touch.current.locked === 'v') return;
    const w = touch.current.width;
    setDx(Math.max(-w, Math.min(w, moveX)));
  };

  const commit = (dir: 'left' | 'right') => {
    const w = touch.current.width;
    setAnimating(true);
    setDx(dir === 'right' ? w : -w);
    setTimeout(() => setLeaving(dir), 180);
    setTimeout(() => {
      if (dir === 'right') onArchive(email.id); else onDelete(email.id);
    }, 380);
  };

  const onTouchEnd = () => {
    if (!touch.current.active) return;
    touch.current.active = false;
    if (touch.current.locked !== 'h') { setDx(0); return; }
    const w = touch.current.width;
    if (dx > w * THRESHOLD) commit('right');
    else if (dx < -w * THRESHOLD) commit('left');
    else { setAnimating(true); setDx(0); }
  };

  const progress = Math.min(1, Math.abs(dx) / (touch.current.width * THRESHOLD || 1));
  const dir = dx > 0 ? 'right' : dx < 0 ? 'left' : null;

  return (
    <div className={`sw-outer ${leaving ? 'leaving' : ''}`}>
      <div
        className="sw-bg"
        style={{
          background: dir === 'right' ? '#E5202C' : dir === 'left' ? '#B81A24' : 'transparent',
          opacity: dir ? 0.15 + progress * 0.85 : 0,
        }}
      >
        <div className="sw-bg-icon left" style={{ opacity: dir === 'right' ? 1 : 0, transform: `scale(${0.7 + progress * 0.4})` }}>
          <Archive size={22} color="white" strokeWidth={2.5} />
          <span>В архив</span>
        </div>
        <div className="sw-bg-icon right" style={{ opacity: dir === 'left' ? 1 : 0, transform: `scale(${0.7 + progress * 0.4})` }}>
          <span>Удалить</span>
          <Trash2 size={22} color="white" strokeWidth={2.5} />
        </div>
      </div>

      <div
        className={`mb-row ${animating ? 'animating' : ''} ${checked ? 'checked' : ''}`}
        style={{ transform: `translateX(${dx}px)` }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onClick={() => {
          if (Math.abs(dx) >= 4 || leaving) return;
          // While a selection is active, tapping a row extends it (Gmail).
          if (selectionActive) onToggleCheck(email.id); else onOpen(email.id);
        }}
      >
        {email.unread && <div className="mb-unread-bar" />}
        <button
          className={`ava mb-ava-check ${checked ? 'checked' : ''}`}
          style={{ background: checked ? 'var(--green)' : email.color }}
          aria-label={checked ? 'Снять выделение' : 'Выбрать письмо'}
          onClick={(ev) => { ev.stopPropagation(); onToggleCheck(email.id); }}
        >
          {checked ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2.5 8.5L6.2 12L13.5 4" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : email.initial}
        </button>
        <div className="mb-rmain">
          <div className="mb-rtop">
            <div className={`mb-rfrom ${email.unread ? '' : 'read'}`}>{email.from}</div>
            <div className="mb-rtime">{email.time}</div>
          </div>
          <div className={`mb-rsub ${email.unread ? '' : 'read'}`}>{email.subject}</div>
          <div className="mb-rprev">{email.direction === 'received' ? '→' : '←'} {email.preview}</div>
          <div className="mb-rtags">
            <span className="pill" style={{ background: email.tagStyle.bg, color: email.tagStyle.fg }}>
              <span className="pill-dot" style={{ background: email.tagStyle.dot }} />
              {email.tag}
            </span>
            {email.priority === 'high' && <span className="prio">СРОЧНО</span>}
            <button className={`starb ${email.starred ? 'on' : ''}`} onClick={(ev) => onStar(email.id, ev)} aria-label="Пометить важным">
              <Star size={17} fill={email.starred ? '#FFB020' : 'none'} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MobileMail({ data, toast }: { data: ReturnType<typeof useMailData>; toast: (t: string, undo?: () => void) => void }) {
  const { items, loading, error, markRead, toggleStar, archive, unarchive, remove, restore } = data;
  const [activeFolder, setActiveFolder] = useState<FolderId>('inbox');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [compose, setCompose] = useState<{ to?: string; subject?: string; text?: string } | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);
  // Left drawer = desktop agents/folders sidebar (Owner: burger opens side box)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scope, setScope] = useState<MailboxScope>(null);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [deptsOpen, setDeptsOpen] = useState(true);

  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [drawerOpen]);

  const visible = useMemo(() => {
    let list = items.filter((e) => (activeFolder === 'starred' ? e.starred && e.folder !== 'archive' : e.folder === activeFolder));
    list = list.filter((e) => matchesScope(e, scope));
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (e) => e.subject.toLowerCase().includes(q) || e.from.toLowerCase().includes(q) || e.org.toLowerCase().includes(q)
      );
    }
    return list;
  }, [items, activeFolder, query, scope]);

  const { inboxUnread } = folderCounts(items);
  const urgentCount = items.filter((e) => e.folder === 'inbox' && e.priority === 'high').length;

  const opened = items.find((e) => e.id === openedId) || null;
  const { body, loading: bodyLoading } = useMailBody(opened);
  const scopeLabel = scope
    ? (findUiMailbox(scope.address)?.label || scope.address.split('@')[0])
    : null;
  const folderLabel = scopeLabel
    || (FOLDERS.find((f) => f.id === activeFolder)?.label || '');
  const sel = useSelection(visible);

  const bulkBar = {
    read: () => { data.bulkRead(sel.selectedItems); sel.clear(); },
    archive: () => {
      const ids = sel.selectedItems.map((e) => e.id);
      data.bulkArchive(ids);
      sel.clear();
      toast(`В архиве: ${ids.length}`, () => data.bulkUnarchive(ids));
    },
    remove: () => {
      const ids = sel.selectedItems.map((e) => e.id);
      data.bulkRemove(ids);
      sel.clear();
      toast(`Удалено: ${ids.length}`, () => data.bulkRestore(ids));
    },
  };

  const openEmail = (id: string) => {
    const it = items.find((e) => e.id === id);
    setOpenedId(id);
    setReplyText('');
    if (it) markRead(it);
  };
  const archiveEmail = (id: string) => { archive(id); toast('Перемещено в архив', () => unarchive(id)); };
  const deleteEmail = (id: string) => { remove(id); toast('Письмо удалено', () => restore(id)); };

  async function submitReply() {
    if (!opened || !replyText.trim() || replySending) return;
    setReplySending(true);
    try {
      const r = await sendReply({
        to: opened.org,
        subject: opened.subject.toLowerCase().startsWith('re:') ? opened.subject : `Re: ${opened.subject}`,
        text: replyText,
        from: replyFromFor(opened),
      });
      if (r.success) { setReplyText(''); toast('Ответ отправлен'); }
      else toast(r.error || 'Не удалось отправить');
    } catch {
      toast('Не удалось отправить');
    } finally {
      setReplySending(false);
    }
  }

  return (
    <div className="phone">
      {/* App bar — turns into the selection bar while letters are checked */}
      <div className="appbar">
        {sel.selectedItems.length > 0 ? (
          <>
            <button className="abtn" onClick={sel.clear} aria-label="Снять выделение"><X size={20} /></button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="title">{sel.selectedItems.length}</div>
              <div className="sub">выбрано</div>
            </div>
            <button className="abtn" onClick={bulkBar.read} aria-label="Отметить прочитанными"><Mail size={20} /></button>
            <button className="abtn" onClick={bulkBar.archive} aria-label="В архив"><Archive size={20} /></button>
            <button className="abtn" onClick={bulkBar.remove} aria-label="Удалить"><Trash2 size={20} /></button>
          </>
        ) : searchOpen ? (
          <>
            <div className="searchbar">
              <Search size={16} color="#93A1AE" />
              <input autoFocus placeholder="Поиск по письмам..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <button className="abtn" onClick={() => { setSearchOpen(false); setQuery(''); }} aria-label="Закрыть поиск"><X size={20} /></button>
          </>
        ) : (
          <>
            <button
              className="abtn"
              onClick={() => setDrawerOpen(true)}
              aria-label="Агенты и папки"
              aria-expanded={drawerOpen}
            >
              <Menu size={22} strokeWidth={2.4} />
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="title">Почта</div>
              <div className="sub">{folderLabel} · {visible.length}</div>
            </div>
            <button className="abtn" onClick={() => setSearchOpen(true)} aria-label="Поиск"><Search size={20} /></button>
          </>
        )}
      </div>

      {/* Left drawer — same agents/folders side box as desktop */}
      {drawerOpen && (
        <div className="mdrawer" role="dialog" aria-modal="true" aria-label="Агенты и папки">
          <button type="button" className="mdrawer-backdrop" aria-label="Закрыть" onClick={() => setDrawerOpen(false)} />
          <aside className="mdrawer-panel">
            <div className="mdrawer-head">
              <div className="mdrawer-title">Почта</div>
              <button type="button" className="abtn" onClick={() => setDrawerOpen(false)} aria-label="Закрыть"><X size={20} /></button>
            </div>
            <button
              type="button"
              className="compose"
              onClick={() => { setDrawerOpen(false); setCompose({}); }}
            >
              <Plus size={16} strokeWidth={3} /> Написать письмо
            </button>

            {FOLDERS.map((f) => {
              const Icon = f.icon;
              const active = activeFolder === f.id && !scope;
              const count = f.id === 'inbox' ? inboxUnread : 0;
              return (
                <div
                  key={f.id}
                  className={`folder ${active ? 'active' : ''}`}
                  onClick={() => {
                    setActiveFolder(f.id);
                    setScope(null);
                    setOpenedId(null);
                    sel.clear();
                    setDrawerOpen(false);
                  }}
                >
                  <Icon size={16} strokeWidth={2.4} />
                  {f.label}
                  {count > 0 && <span className="fcount">{count}</span>}
                </div>
              );
            })}

            <button type="button" className={`nav-section-h ${agentsOpen ? 'open' : ''}`} onClick={() => setAgentsOpen((v) => !v)}>
              <Users size={14} strokeWidth={2.4} />
              <span>Agents</span>
              <ChevronDown size={14} className="nav-chevron" />
            </button>
            {agentsOpen && (
              <div className="nav-section-body">
                {AGENT_MAILBOXES.map((m) => {
                  const active = scope?.kind === 'agent' && scope.address === m.address;
                  const u = mailboxUnread(items, m);
                  return (
                    <div
                      key={m.address}
                      className={`folder nav-person ${active ? 'active' : ''}`}
                      title={m.address}
                      onClick={() => {
                        setScope({ kind: 'agent', address: m.address });
                        setActiveFolder('inbox');
                        setOpenedId(null);
                        sel.clear();
                        setDrawerOpen(false);
                      }}
                    >
                      <AgentAvatar slug={m.slug} label={m.label} size={26} />
                      <span className="nav-person-label">{m.label.split(' ')[0]}</span>
                      {u > 0 && <span className="fcount">{u}</span>}
                    </div>
                  );
                })}
              </div>
            )}

            <button type="button" className={`nav-section-h ${deptsOpen ? 'open' : ''}`} onClick={() => setDeptsOpen((v) => !v)}>
              <Building2 size={14} strokeWidth={2.4} />
              <span>Departments</span>
              <ChevronDown size={14} className="nav-chevron" />
            </button>
            {deptsOpen && (
              <div className="nav-section-body">
                {DEPARTMENT_MAILBOXES.map((m) => {
                  const active = scope?.kind === 'department' && scope.address === m.address;
                  const u = mailboxUnread(items, m);
                  return (
                    <div
                      key={m.address}
                      className={`folder nav-person ${active ? 'active' : ''}`}
                      title={m.address}
                      onClick={() => {
                        setScope({ kind: 'department', address: m.address });
                        setActiveFolder('inbox');
                        setOpenedId(null);
                        sel.clear();
                        setDrawerOpen(false);
                      }}
                    >
                      <span className="nav-dept-dot" aria-hidden />
                      <span className="nav-person-label">{m.label}</span>
                      {u > 0 && <span className="fcount">{u}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </aside>
        </div>
      )}

      {/* Stats */}
      <div className="stats">
        <div className="chip"><Mail size={13} color="#E5202C" /> Непрочитанных <b>{inboxUnread}</b></div>
        <div className="chip"><AlertCircle size={13} color="#B81A24" /> Срочные <b>{urgentCount}</b></div>
      </div>

      {/* Gesture hint */}
      <div className="hint">
        <Archive size={12} color="#E5202C" /> свайп вправо — архив
        <span style={{ margin: '0 2px' }}>·</span>
        <Trash2 size={12} color="#B81A24" /> свайп влево — удалить
      </div>

      {/* Rows */}
      <div className="mrows">
        {loading && <div className="empty"><Loader2 className="dxmail-spin" size={18} /></div>}
        {!loading && error && <div className="empty">{error}</div>}
        {!loading && !error && visible.length === 0 && <div className="empty">Здесь пока пусто</div>}
        {visible.map((e) => (
          <SwipeableRow
            key={e.id}
            email={e}
            onOpen={openEmail}
            onStar={(id, ev) => { ev.stopPropagation(); toggleStar(id); }}
            onArchive={archiveEmail}
            onDelete={deleteEmail}
            checked={sel.checked.has(e.id)}
            selectionActive={sel.selectedItems.length > 0}
            onToggleCheck={sel.toggle}
          />
        ))}
      </div>

      {/* FAB */}
      <button className="fab" onClick={() => setCompose({})}><Plus size={19} strokeWidth={3} /> Написать</button>

      {/* Bottom nav (mail folders — sits above the app's section nav) */}
      <div className="mnav">
        {MOBILE_FOLDERS.map((f) => {
          const Icon = f.icon;
          const active = activeFolder === f.id;
          const badge = f.id === 'inbox' ? inboxUnread : 0;
          return (
            <button key={f.id} className={`navitem ${active ? 'active' : ''}`} onClick={() => { setActiveFolder(f.id); setOpenedId(null); sel.clear(); }}>
              <span className="iconwrap">
                <Icon size={20} strokeWidth={2.4} />
                {badge > 0 && <span className="navbadge">{badge}</span>}
              </span>
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Detail overlay */}
      {opened && (
        <div className="mdetail">
          <div className="appbar">
            <button className="abtn" onClick={() => setOpenedId(null)} aria-label="Назад"><ArrowLeft size={21} /></button>
            <div style={{ flex: 1 }} />
            <button className="abtn" onClick={() => { archiveEmail(opened.id); setOpenedId(null); }} aria-label="В архив"><Archive size={19} /></button>
            <button className="abtn" onClick={() => { deleteEmail(opened.id); setOpenedId(null); }} aria-label="Удалить"><Trash2 size={19} /></button>
            <button className="abtn" aria-label="Ещё"><MoreVertical size={19} /></button>
          </div>

          <div className="dwrap">
            <div className="mdcard">
              <div className={`dsub ${subjSizeClass(opened.subject)}`}>{opened.subject}</div>
              <div className="dfrom">
                <div className="ava" style={{ width: 42, height: 42, background: opened.color, fontSize: 13 }}>{opened.initial}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="dname">{opened.from}</div>
                  <div className="dorg">{opened.org} · {opened.time}</div>
                </div>
                <button className={`starb ${opened.starred ? 'on' : ''}`} onClick={(ev) => { ev.stopPropagation(); toggleStar(opened.id); }} aria-label="Пометить важным">
                  <Star size={19} fill={opened.starred ? '#FFB020' : 'none'} />
                </button>
              </div>
              <div className="dtext">
                <BodyView item={opened} body={body} loading={bodyLoading} />
              </div>
              <div className="actions">
                <button className="action" onClick={() => { const el = document.querySelector<HTMLInputElement>('.dxmail .mreplybar input'); el?.focus(); }}>
                  <Reply size={15} /> Ответить
                </button>
                <button
                  className="action"
                  onClick={() => setCompose({ subject: `Fwd: ${opened.subject}`, text: body?.text ? `\n\n--- Пересланное письмо ---\n${body.text}` : '' })}
                >
                  <Forward size={15} /> Переслать
                </button>
              </div>
            </div>
          </div>

          <div className="mreplybar">
            <input
              placeholder={`Ответить: ${opened.from}...`}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitReply(); }}
            />
            <button className="msendb" onClick={submitReply} disabled={replySending} aria-label="Отправить">
              {replySending ? <Loader2 size={17} className="dxmail-spin" /> : <Send size={17} />}
            </button>
          </div>
        </div>
      )}

      {compose && <ComposeModal initial={compose} onClose={() => setCompose(null)} onSent={(m) => toast(m)} />}
    </div>
  );
}

// =============================================================================
// Root: media-switch between the two approved layouts + shared undo snackbar.
// =============================================================================
export default function MailApp() {
  const data = useMailData();
  const [isMobile, setIsMobile] = useState(false);
  const [ready, setReady] = useState(false);
  const [snackbar, setSnackbar] = useState<{ text: string; undo?: () => void } | null>(null);
  const snackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Narrow screen (incl. tablets) + standalone /mail Android app → phone UI with burger drawer.
    // 960px so half-laptop / split view gets agents side-box via burger, not missing chrome.
    const mq = window.matchMedia('(max-width: 960px)');
    const apply = () => {
      const standaloneMail =
        window.location.pathname === '/mail' || window.location.pathname.startsWith('/mail/');
      setIsMobile(standaloneMail || mq.matches);
    };
    apply();
    setReady(true);
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const toast = useCallback((text: string, undo?: () => void) => {
    if (snackTimer.current) clearTimeout(snackTimer.current);
    setSnackbar({ text, undo });
    snackTimer.current = setTimeout(() => setSnackbar(null), 4000);
  }, []);

  return (
    <div className="dxmail">
      {ready && (isMobile ? <MobileMail data={data} toast={toast} /> : <DesktopMail data={data} toast={toast} />)}

      {snackbar && (
        <div className="snackbar">
          {snackbar.text}
          {snackbar.undo && (
            <button
              className="undo-btn"
              onClick={() => {
                snackbar.undo?.();
                if (snackTimer.current) clearTimeout(snackTimer.current);
                setSnackbar(null);
              }}
            >
              <Undo2 size={15} /> ОТМЕНИТЬ
            </button>
          )}
        </div>
      )}
    </div>
  );
}
