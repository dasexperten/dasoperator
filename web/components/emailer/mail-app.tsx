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
  ChevronDown, Users, Building2, Menu, Wand2,
  ArrowDownLeft, ArrowUpRight, Languages, GraduationCap,
} from 'lucide-react';
import {
  getMailboxes,
  getMailboxMessages,
  getMailboxMessage,
  getAttention,
  markMailRead,
  sendReply,
  draftAgentReply,
  translateEmail,
  learnFromLetter,
} from '@/lib/api';
import type { LearnReport } from '@/lib/api';
import { correspondent, displayName, emailAddr } from './shared';
import {
  AGENT_MAILBOXES,
  DEPARTMENT_MAILBOXES,
  COMPOSE_FROM_ADDRESSES,
  OWNER_PERSONAL,
  SUPPORT_ADDRESS,
  isTransactional,
  signatureFor,
  bodyWithoutSignature,
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
  agent?: string;        // author slug — a letter belongs to the person, not only the mailbox
  messageId?: string;    // this letter's own Message-ID
  parentId?: string;     // Message-ID of the letter this one replies to
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
    agent?: string;   // roster slug of the person who wrote it, e.g. 'julian-farah'
    // Both arrive from the archive index and were being dropped on the floor.
    // threadId is NOT a conversation id — archiveEmail stores In-Reply-To in it,
    // i.e. a pointer to the PARENT letter. See buildThreads().
    messageId?: string; threadId?: string;
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
          agent: e.agent,
          messageId: e.messageId,
          parentId: e.threadId,
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

// Owner 2026-08-03: orders@ and delivery@ are the brand's voice, not a person's.
// A customer who writes to them is answered by Tamara from support@, signed by
// her — never from the transactional address, which has no owner to sign it.

// -----------------------------------------------------------------------------
// Reply threading headers.
//
// Owner 2026-08-03: three call sites used to send a reply with no In-Reply-To
// at all, so our answer arrived at the counterparty as a NEW letter sitting
// beside their own. Harmless-looking while one agent answered; fatal once
// several answer the same letter from their own boxes — the customer would get
// three orphans instead of one conversation.
//
// In-Reply-To names the parent. References carries the whole ancestry, oldest
// first, because Gmail and Outlook build the tree from References — a chain of
// one collapses a long thread the moment a third person joins it.
// -----------------------------------------------------------------------------
function replyHeaders(
  selected: MailItem,
  threadLetters: MailItem[] | undefined
): { in_reply_to?: string; references?: string[] } {
  const parent = selected.messageId;
  if (!parent) return {};
  const chain = (threadLetters || [])
    .slice()
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
    .map((l) => l.messageId)
    .filter((id): id is string => !!id && id !== parent);
  return chain.length ? { in_reply_to: parent, references: chain } : { in_reply_to: parent };
}

function replyFromFor(item: MailItem): string {
  const mb = item.mailbox.toLowerCase();
  if (isTransactional(mb)) return SUPPORT_ADDRESS;
  if (mb === OWNER_PERSONAL) return 'sales@dasexperten.com';
  return APEX_SENDERS.includes(mb) ? mb : 'sales@dasexperten.com';
}

type ComposeInit = { to?: string; subject?: string; text?: string; from?: string; title?: string };

function plainFromHtml(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function replySubject(subject: string): string {
  return subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`;
}

// Owner 2026-07-29: the agent drafts, the human sends. This hook has no send
// path at all — it opens the compose window with the text filled in, and the
// existing Отправить button stays the only way out (HARD_RULES §0).
// =============================================================================
// Threads (Owner 2026-07-31) — Gmail-style conversation grouping.
//
// The archive gives us two headers per letter: its own Message-ID and, in the
// field named threadId, the In-Reply-To of its parent. That name is a lie: it
// is a PARENT POINTER, not a conversation id. A four-letter exchange carries
// three different values plus an empty one at the root, so grouping by it
// directly shatters the conversation.
//
// So we union-find instead: every parent pointer is an edge, and letters with
// no usable headers fall back to a key of normalised subject + counterparty.
// That fallback is deliberately narrow — subject alone would happily merge two
// unrelated "Заказ" letters from different companies.
// =============================================================================

interface Thread {
  /** The newest letter — what the list row shows. */
  head: MailItem;
  /** Oldest → newest, always contains head. */
  letters: MailItem[];
  count: number;
  unread: boolean;
  starred: boolean;
  /** Distinct counterparty names, oldest first — the Gmail participant line. */
  people: string[];
}

const REPLY_PREFIX = /^\s*(?:(?:re|fwd|fw|ответ|отв|пересл|переслано)\s*(?:\[\d+\])?\s*:\s*)+/i;

function normSubject(subject: string): string {
  return subject.replace(REPLY_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Disjoint-set over letter ids. */
function makeUnionFind() {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    if (r === x) { parent.set(x, x); return x; }
    r = find(r);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union };
}

function buildThreads(items: MailItem[]): Thread[] {
  const uf = makeUnionFind();
  const byMessageId = new Map<string, string>();   // Message-ID → letter id
  const bySubjectKey = new Map<string, string>();  // fallback key → letter id

  for (const it of items) {
    uf.find(it.id);
    if (it.messageId && !byMessageId.has(it.messageId)) byMessageId.set(it.messageId, it.id);
  }

  for (const it of items) {
    // Edge 1: this letter answers a letter we also hold.
    if (it.parentId) {
      const parentLetter = byMessageId.get(it.parentId);
      if (parentLetter) uf.union(it.id, parentLetter);
    }
    // Edge 2: same normalised subject with the same counterparty.
    const subj = normSubject(it.subject);
    if (subj.length >= 4) {
      const key = `${subj}::${it.org.toLowerCase()}`;
      const seen = bySubjectKey.get(key);
      if (seen) uf.union(it.id, seen);
      else bySubjectKey.set(key, it.id);
    }
  }

  const buckets = new Map<string, MailItem[]>();
  for (const it of items) {
    const root = uf.find(it.id);
    const b = buckets.get(root);
    if (b) b.push(it); else buckets.set(root, [it]);
  }

  const threads: Thread[] = [];
  for (const letters of Array.from(buckets.values())) {
    letters.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    const head = letters[letters.length - 1]!;
    const people: string[] = [];
    for (const l of letters) if (!people.includes(l.from)) people.push(l.from);
    threads.push({
      head,
      letters,
      count: letters.length,
      unread: letters.some((l) => l.unread),
      starred: letters.some((l) => l.starred),
      people,
    });
  }

  // Newest conversation first — the list keeps behaving the way it always did.
  threads.sort((a, b) => (b.head.timestamp || '').localeCompare(a.head.timestamp || ''));
  return threads;
}

// =============================================================================
// Foreign-letter detection (Owner 2026-07-31)
// A letter that is neither Russian nor English offers a "Перевести" button.
// This runs on the client only to decide whether the button appears; the real
// source language is named by the model in the answer.
// =============================================================================

const EN_STOPWORDS = new Set([
  'the','and','of','to','in','is','are','for','with','you','we','your','our','that','this',
  'have','has','will','can','please','from','it','be','on','at','as','not','was','were','по',
]);

/** Cheap markup strip so the detector reads prose, not tags. */
function plainish(src: string): string {
  return src
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
}

/**
 * True when the letter is worth offering a translation for.
 * Cyrillic → treated as Russian, no button. Non-Latin scripts → always.
 * Latin → button when the text carries diacritics or too few English stopwords.
 * Short letters stay silent: under 12 words there is no statistic to trust.
 */
function isForeignLetter(raw: string): boolean {
  const text = plainish(raw || '').trim();
  if (text.length < 40) return false;

  // No \p{L} here: the build target predates ES6 unicode regex flags.
  const letters = text.replace(
    /[^A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u1EA0-\u1EF9\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g,
    ''
  );
  if (letters.length < 30) return false;

  const cyr = (letters.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyr / letters.length > 0.15) return false;

  // CJK, Arabic, Hebrew, Thai, Devanagari, Hangul, Kana — nothing to argue about.
  if (/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0600-\u06FF\u0590-\u05FF\u0E00-\u0E7F\u0900-\u097F]/.test(text)) {
    return true;
  }

  // Latin with diacritics: Polish, German, Vietnamese, French, Turkish, Spanish…
  if (/[\u00C0-\u017F\u01A0-\u01B0\u1EA0-\u1EF9\u0218-\u021B]/.test(text)) return true;

  const words = text.toLowerCase().match(/[a-z']{2,}/g) || [];
  if (words.length < 12) return false;
  const hits = words.filter((w) => EN_STOPWORDS.has(w)).length;
  return hits / words.length < 0.08;
}

/** Translation state for the открытое письмо — one letter at a time. */
function useTranslation(letterId: string | null) {
  const [text, setText] = useState<string | null>(null);
  const [lang, setLang] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setText(null); setLang(''); setTruncated(false); setBusy(false); setShowOriginal(false); setErr(null);
  }, [letterId]);

  const run = useCallback(async (body: { text?: string; html?: string } | null) => {
    if (!body) return;
    if (text) { setShowOriginal((v) => !v); return; }
    setBusy(true); setErr(null);
    const payload: { text?: string; html?: string } = {};
    if (body.text) payload.text = body.text;
    else if (body.html) payload.html = body.html;
    const r = await translateEmail(payload);
    setBusy(false);
    if (!r.success) { setErr(r.error || 'Не удалось перевести'); return; }
    setText(r.translation || '');
    setLang(r.sourceLanguage || '');
    setTruncated(Boolean(r.truncated));
    setShowOriginal(false);
  }, [text]);

  return { text, lang, truncated, busy, showOriginal, err, run };
}

function useAgentDraft(
  openCompose: (init: ComposeInit) => void,
  toast: (t: string, undo?: () => void) => void
) {
  const [drafting, setDrafting] = useState(false);

  const run = useCallback(
    async (item: MailItem | null, body: { text?: string; html?: string } | null) => {
      if (!item || drafting) return;
      setDrafting(true);
      try {
        // The agent reads the letter from the archive itself — we pass the key,
        // not the body, so the agent works from the record and not from what
        // the browser happens to have rendered.
        const r = await draftAgentReply({ key: item.key });
        if (r.success && r.draft) {
          openCompose({
            to: item.org,
            subject: replySubject(item.subject),
            text: r.draft.trim(),
            from: replyFromFor(item),
            title: `Черновик агента${r.by ? ` — ${r.by}` : ''} — проверьте перед отправкой`,
          });
        } else {
          toast(r.error || 'Агент не смог составить ответ');
        }
      } catch {
        toast('Агент не смог составить ответ');
      } finally {
        setDrafting(false);
      }
    },
    [drafting, openCompose, toast]
  );

  return { drafting, run };
}

/**
 * Учи — the seat studies this letter and reports only what is NEW for it
 * (Lena's novelty law, Owner 2026-07-19). Engine lives on the org board;
 * this hook only hands over the archive key. Nothing is sent anywhere.
 */
function useLetterLearn(toast: (t: string, undo?: () => void) => void) {
  const [learning, setLearning] = useState(false);
  // Studied letters are remembered by archive key. A second press on the same
  // letter re-opens the report instead of spending another model call and
  // writing a second line into knowledge/sources/log — re-study is explicit.
  const [reports, setReports] = useState<Record<string, LearnReport>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);

  const run = useCallback(
    async (item: MailItem | null, threadKeys?: string[], force = false) => {
      if (!item || learning) return;
      if (!force && reports[item.key]) {
        setOpenKey(item.key);
        return;
      }
      setLearning(true);
      setOpenKey(item.key);
      try {
        const r = await learnFromLetter({ key: item.key, keys: threadKeys });
        if (r.success && r.result) {
          setReports((prev) => ({ ...prev, [item.key]: r.result as LearnReport }));
        } else {
          setOpenKey(null);
          toast(r.error || 'Learn failed');
        }
      } catch {
        setOpenKey(null);
        toast('Learn failed');
      } finally {
        setLearning(false);
      }
    },
    [learning, reports, toast]
  );

  return {
    learning,
    run,
    studied: (key?: string) => !!(key && reports[key]),
    reportFor: (key?: string) => (key && openKey === key ? reports[key] || null : null),
    close: () => setOpenKey(null),
  };
}

function mailboxUnread(items: MailItem[], m: UiMailbox): number {
  const set = new Set(addressesForMailbox(m));
  return items.filter((i) => i.folder === 'inbox' && i.unread && set.has(i.mailbox.toLowerCase())).length;
}

// Owner 2026-07-26: an agent's folder holds every letter that PERSON wrote or
// received — including mail they sent from a role mailbox such as partnerships@.
// The author slug travels with the record; the mailbox match stays as fallback
// for older letters written before slugs were stored.
function matchesScope(item: MailItem, scope: MailboxScope): boolean {
  if (!scope) return true;
  const def = findUiMailbox(scope.address);
  const slug = def?.slug ?? (scope as { slug?: string }).slug;
  if (slug && item.agent && item.agent === slug) return true;
  if (!def) return item.mailbox.toLowerCase() === scope.address.toLowerCase();
  return addressesForMailbox(def).includes(item.mailbox.toLowerCase());
}

// Owner 2026-07-26: picking an agent means "show me this person's mail" —
// both what they received and what they sent, in one list. Before this the
// agent was only a filter on top of the open folder, so clicking an agent
// who had sent letters but received none showed an empty screen.
// Archive and Важные stay real folders; Входящие/Отправленные merge under a scope.
function passesFolder(item: MailItem, activeFolder: FolderId, scoped: boolean): boolean {
  if (activeFolder === 'archive') return item.folder === 'archive';
  if (activeFolder === 'starred') return item.starred && item.folder !== 'archive';
  if (scoped) return item.folder !== 'archive';
  return item.folder === activeFolder;
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
  initial?: { to?: string; subject?: string; text?: string; from?: string; title?: string };
  onClose: () => void;
  onSent: (msg: string) => void;
}) {
  const [from, setFrom] = useState(
    initial?.from && APEX_SENDERS.includes(initial.from) ? initial.from : APEX_SENDERS[0]!
  );
  const [to, setTo] = useState(initial?.to || '');
  const [subject, setSubject] = useState(initial?.subject || '');
  const [text, setText] = useState(
    initial?.text ??
      signatureFor(
        initial?.from && APEX_SENDERS.includes(initial.from) ? initial.from : APEX_SENDERS[0]!
      )
  );
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Switching the sender swaps the signature with it — otherwise a letter from
  // Tamara could leave signed by Zina, which is worse than no signature at all.
  function changeFrom(next: string) {
    const old = signatureFor(from);
    setText((prev) => (prev.endsWith(old) ? prev.slice(0, prev.length - old.length) + signatureFor(next) : prev));
    setFrom(next);
  }

  async function submit() {
    if (!to || !subject || !bodyWithoutSignature(text, signatureFor(from))) {
      setErr('Заполните кому, тему и текст.');
      return;
    }
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
          <div className="cmodal-title">{initial?.title || 'Новое письмо'}</div>
          <button className="abtn" onClick={onClose} aria-label="Закрыть"><X size={18} /></button>
        </div>
        <label className="cmodal-label">От кого
          <select value={from} onChange={(e) => changeFrom(e.target.value)}>
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
  const [compose, setCompose] = useState<ComposeInit | null>(null);
  const agentDraft = useAgentDraft(setCompose, toast);
  const letterLearn = useLetterLearn(toast);
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);
  const replyRef = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<MailboxScope>(null);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [deptsOpen, setDeptsOpen] = useState(true);
  const { listWidth, onSplitterDown } = useListPaneResize();
  const tr = useTranslation(selectedId);

  // Owner 2026-08-03: a conversation is one object, not one per folder. The
  // folder filter used to run BEFORE grouping, so a thread opened from
  // Входящие could never contain our own answer — it had been cut away while
  // it was still a loose letter. Group first over everything the scope and the
  // search allow, then keep the threads that have at least one letter in the
  // open folder. `visible` stays letter-shaped: the checkboxes act on letters.
  const scoped = useMemo(() => {
    let list = items.filter((e) => matchesScope(e, scope));
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (e) => e.subject.toLowerCase().includes(q) || e.from.toLowerCase().includes(q) || e.org.toLowerCase().includes(q)
      );
    }
    return list;
  }, [items, query, scope]);

  const visible = useMemo(
    () => scoped.filter((e) => passesFolder(e, activeFolder, Boolean(scope))),
    [scoped, activeFolder, scope]
  );

  const threads = useMemo(
    () =>
      buildThreads(scoped).filter((t) =>
        t.letters.some((l) => passesFolder(l, activeFolder, Boolean(scope)))
      ),
    [scoped, activeFolder, scope]
  );
  const openThread = useMemo(
    () => threads.find((t) => t.letters.some((l) => l.id === selectedId)) || null,
    [threads, selectedId]
  );

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
    // Signature is prefilled, not appended at send: the person sees exactly
    // what the customer will read before pressing Отправить (HARD_RULES §0).
    setReplyText(signatureFor(replyFromFor(it)));
    markRead(it);
  };

  async function submitReply() {
    if (!selected || replySending) return;
    const fromAddr = replyFromFor(selected);
    const sig = signatureFor(fromAddr);
    // A letter that is nothing but the signature is not a letter.
    if (!bodyWithoutSignature(replyText, sig)) return;
    setReplySending(true);
    try {
      const r = await sendReply({
        to: selected.org,
        subject: selected.subject.toLowerCase().startsWith('re:') ? selected.subject : `Re: ${selected.subject}`,
        text: replyText,
        from: fromAddr,
        ...replyHeaders(selected, openThread?.letters),
      });
      if (r.success) { setReplyText(sig); toast('Ответ отправлен'); }
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
            {!loading && !error && threads.length === 0 && <div className="empty">Здесь пока пусто</div>}
            {threads.map((t) => {
              const e = t.head;
              const inThread = t.letters.some((l) => l.id === selectedId);
              return (
              <div key={e.id} className={`row ${inThread ? 'selected' : ''} ${sel.checked.has(e.id) ? 'checked' : ''} ${t.unread ? 'unread' : ''}`} onClick={() => openEmail(e)}>
                <RowCheck on={sel.checked.has(e.id)} onToggle={() => sel.toggle(e.id)} />
                <div className="ava" style={{ background: e.color }}>{e.initial}</div>
                <div className="rmain">
                  <div className="rtop">
                    <div className={`rfrom ${t.unread ? '' : 'read'}`}>
                      {t.count > 1 ? t.people.join(', ') : e.from}
                      {t.count > 1 && <span className="thcount">{t.count}</span>}
                    </div>
                    <div className="rtime">{e.time}</div>
                  </div>
                  <div className={`rsub ${t.unread ? '' : 'read'}`}>{e.subject}</div>
                  <div className="rprev">
                    {e.direction === 'received'
                      ? <ArrowDownLeft className="dirarr in" size={13} strokeWidth={3} aria-label="Входящее" />
                      : <ArrowUpRight className="dirarr out" size={13} strokeWidth={3} aria-label="Отправленное" />}
                    <span className="rprev-t">{e.preview}</span>
                  </div>
                  <div className="rtags">
                    <span className="pill" style={{ background: e.tagStyle.bg, color: e.tagStyle.fg }}>
                      <span className="pill-dot" style={{ background: e.tagStyle.dot }} />
                      {e.tag}
                    </span>
                    {e.priority === 'high' && <span className="prio">СРОЧНО</span>}
                    <button className={`starb ${t.starred ? 'on' : ''}`} onClick={(ev) => { ev.stopPropagation(); toggleStar(e.id); }} aria-label="Пометить важным">
                      <Star size={14} fill={t.starred ? '#FFB020' : 'none'} />
                    </button>
                  </div>
                </div>
              </div>
              );
            })}
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
                    {isForeignLetter(body?.text || body?.html || '') && (
                      <button
                        className={`ibtn tbtn ${tr.text && !tr.showOriginal ? 'on' : ''}`}
                        onClick={() => tr.run(body)}
                        disabled={tr.busy}
                        title={tr.lang ? `Оригинал: ${tr.lang}` : 'Перевести письмо на русский'}
                      >
                        {tr.busy ? <Loader2 size={15} className="dxmail-spin" /> : <Languages size={15} />}
                        <span>{tr.text && !tr.showOriginal ? 'Оригинал' : 'Перевести'}</span>
                      </button>
                    )}
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

                {openThread && openThread.count > 1 && (
                  <div className="thstrip">
                    {/* Newest first (Owner 2026-08-01). The strip is capped at 168px:
                        chronological order buried the latest letter below the fold,
                        which is the one letter you always want first. The underlying
                        array stays oldest-first — Learn reads it in sequence. */}
                    {openThread.letters.slice().reverse().map((l) => (
                      <button
                        key={l.id}
                        className={`thline ${l.id === selectedId ? 'on' : ''} ${l.unread ? 'unread' : ''}`}
                        onClick={() => { if (l.id !== selectedId) openEmail(l); }}
                      >
                        {l.direction === 'received'
                          ? <ArrowDownLeft className="dirarr in" size={12} strokeWidth={3} />
                          : <ArrowUpRight className="dirarr out" size={12} strokeWidth={3} />}
                        <span className="thwho">{l.from}</span>
                        <span className="thtime">{l.time}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className={`dbody ${body?.html && !(tr.text && !tr.showOriginal) ? 'is-html' : ''}`}>
                  <div className="dbody-inner">
                    {tr.err && <div className="tnote err">{tr.err}</div>}
                    {tr.text && !tr.showOriginal ? (
                      <>
                        <div className="tnote">
                          Перевод с языка: {tr.lang || 'не определён'} · Sonnet
                          {tr.truncated ? ' · длинное письмо переведено не полностью' : ''}
                        </div>
                        {linkifyText(tr.text)}
                      </>
                    ) : (
                      <BodyView item={selected} body={body} loading={bodyLoading} />
                    )}
                  </div>
                </div>
              </div>

              {letterLearn.reportFor(selected.key) && (
                <div className="learncard">
                  <div className="learncard-tri" />
                  <div className="learncard-body">
                    <div className="learncard-head">
                      <span className="learncard-who">{letterLearn.reportFor(selected.key)!.agentName}</span>
                      {letterLearn.reportFor(selected.key)!.ownerMail && <span className="learncard-tag">указание владельца</span>}
                      {letterLearn.reportFor(selected.key)!.unverifiedOwnerClaim && (
                        <span className="learncard-warn">отправитель не подтверждён</span>
                      )}
                      {letterLearn.reportFor(selected.key)!.studied > 1 && (
                        <span className="learncard-scope">
                          вся переписка · {letterLearn.reportFor(selected.key)!.studied} писем
                          {letterLearn.reportFor(selected.key)!.truncated ? ' · ранние отсечены' : ''}
                        </span>
                      )}
                      <button className="learncard-x" onClick={letterLearn.close} aria-label="Закрыть">
                        <X size={13} />
                      </button>
                    </div>
                    {letterLearn.reportFor(selected.key)!.summary && (
                      <div className="learncard-sum">{letterLearn.reportFor(selected.key)!.summary}</div>
                    )}
                    {letterLearn.reportFor(selected.key)!.newIntel.length > 0 && (
                      <div className="learncard-sec">
                        <div className="learncard-lab">Новое для меня</div>
                        <ul>{letterLearn.reportFor(selected.key)!.newIntel.map((x, i) => <li key={i}>{x}</li>)}</ul>
                      </div>
                    )}
                    {letterLearn.reportFor(selected.key)!.lessons.length > 0 && (
                      <div className="learncard-sec">
                        <div className="learncard-lab">В playbook</div>
                        <ul>{letterLearn.reportFor(selected.key)!.lessons.map((x, i) => <li key={i}>{x}</li>)}</ul>
                      </div>
                    )}
                    {letterLearn.reportFor(selected.key)!.alreadyKnew.length > 0 && (
                      <div className="learncard-sec learncard-dim">
                        <div className="learncard-lab">Уже знала</div>
                        <ul>{letterLearn.reportFor(selected.key)!.alreadyKnew.map((x, i) => <li key={i}>{x}</li>)}</ul>
                      </div>
                    )}
                    {letterLearn.reportFor(selected.key)!.nothingNew && (
                      <div className="learncard-none">Нового нет — источник ничего не добавил сверх устава и playbook.</div>
                    )}
                    <button
                      className="learncard-again"
                      onClick={() => letterLearn.run(selected, openThread?.letters.map((l) => l.key), true)}
                      disabled={letterLearn.learning}
                    >
                      Изучить заново
                    </button>
                  </div>
                </div>
              )}

              <div className="replybar">
                <input
                  ref={replyRef}
                  placeholder={`Ответить: ${selected.from}...`}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitReply(); }}
                />
                <button
                  className={letterLearn.studied(selected.key) ? "learnb learnb-done" : "learnb"}
                  onClick={() => letterLearn.run(selected, openThread?.letters.map((l) => l.key))}
                  disabled={letterLearn.learning || agentDraft.drafting}
                  title={letterLearn.studied(selected.key) ? "Уже изучено — открыть отчёт" : "Агент изучит письмо и скажет, что в нём для него нового"}
                >
                  {letterLearn.learning ? <Loader2 size={13} className="dxmail-spin" /> : <GraduationCap size={13} />}
                  {letterLearn.studied(selected.key) ? 'Learned' : 'Learn'}
                </button>
                <button
                  className="draftb"
                  onClick={() => agentDraft.run(selected, body)}
                  disabled={agentDraft.drafting || replySending}
                  title="Агент составит черновик — отправляете вы"
                >
                  {agentDraft.drafting ? <Loader2 size={13} className="dxmail-spin" /> : <Wand2 size={13} />} Ответит агент
                </button>
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
          <div className="mb-rprev">
            {email.direction === 'received'
              ? <ArrowDownLeft className="dirarr in" size={14} strokeWidth={3} aria-label="Входящее" />
              : <ArrowUpRight className="dirarr out" size={14} strokeWidth={3} aria-label="Отправленное" />}
            <span className="mb-rprev-t">{email.preview}</span>
          </div>
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
  const [compose, setCompose] = useState<ComposeInit | null>(null);
  const agentDraft = useAgentDraft(setCompose, toast);
  const letterLearn = useLetterLearn(toast);
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
    let list = items.filter((e) => passesFolder(e, activeFolder, Boolean(scope)));
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
    setReplyText(it ? signatureFor(replyFromFor(it)) : '');
    if (it) markRead(it);
  };
  const archiveEmail = (id: string) => { archive(id); toast('Перемещено в архив', () => unarchive(id)); };
  const deleteEmail = (id: string) => { remove(id); toast('Письмо удалено', () => restore(id)); };

  async function submitReply() {
    if (!opened || replySending) return;
    const fromAddr = replyFromFor(opened);
    const sig = signatureFor(fromAddr);
    if (!bodyWithoutSignature(replyText, sig)) return;
    setReplySending(true);
    try {
      // The phone layout has no thread strip, so the ancestry is rebuilt from
      // the same grouping the desktop uses. Without it a reply sent from a
      // phone would break the thread that a reply from a laptop keeps.
      const thread = buildThreads(items).find((t) => t.letters.some((l) => l.id === opened.id));
      const r = await sendReply({
        to: opened.org,
        subject: opened.subject.toLowerCase().startsWith('re:') ? opened.subject : `Re: ${opened.subject}`,
        text: replyText,
        from: fromAddr,
        ...replyHeaders(opened, thread?.letters),
      });
      if (r.success) { setReplyText(sig); toast('Ответ отправлен'); }
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
            <button
              className="mdraftb"
              onClick={() => agentDraft.run(opened, body)}
              disabled={agentDraft.drafting || replySending}
              aria-label="Ответит агент"
            >
              {agentDraft.drafting ? <Loader2 size={17} className="dxmail-spin" /> : <Wand2 size={17} />}
            </button>
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
