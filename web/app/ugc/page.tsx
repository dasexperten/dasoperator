'use client';

import { createContext, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type MouseEvent, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, ArrowUpDown, CheckCheck, Clock, Star, ExternalLink, Eye, Facebook, Globe, Hand, Heart, Instagram, Link, Link2Off, Loader2, MessageCircle, Search, Send, Users, Video, X, Youtube } from 'lucide-react';
import { createPortal } from 'react-dom';
import './ugc-layout.css';
import { apiGet, apiPatch, apiPost, apiPostTimed } from '@/lib/api';
import { canPay, formatRub, PAYOUT_STATUS_LABEL, payoutCell } from '@/lib/ugc-payout-cell.mjs';
import { getUser } from '@/lib/auth';
import { formatActivity, formatCount, formatCountShort, platformLabel } from '@/lib/ugc-table-format.mjs';
import { instagramChatHref } from '@/lib/ugc-instagram-chat.mjs';
import { deviceTargets } from '@/lib/browser-target.mjs';

type PlatformMetric = {
  id: string;
  platform: string;
  handle: string;
  followers: number | null;
  engagement_rate: number | null;
  avg_video_views: number | null;
  median_video_views: number | null;
  latest_observed_views: number | null;
  view_observations: number;
  avg_comments: number | null;
  commerce_clicks: number | null;
  commerce_orders: number | null;
  content_count: number;
  content: ContentObservation[];
  source_products?: ProductMatch[];
  source_product_labels?: { name: string }[];
  metrics_as_of: string | null;
  has_avatar?: boolean;
  avatar_version?: number;
  posts_count?: number | null;
  er_sample_posts?: number | null;
  er_checked_at?: string | null;
  engagement_rate_method?: string | null;
  profile_checked_at?: string | null;
  profile_attempted_at?: string | null;
  profile_error?: string | null;
  availability_status?: 'available' | 'unavailable' | null;
  availability_checked_at?: string | null;
  availability_note?: string | null;
};

type ContentObservation = {
  id: string;
  content_url: string | null;
  content_type: string | null;
  published_at: string | null;
  views: number | null;
  likes?: number | null;
  metrics_checked_at?: string | null;
  comments: number | null;
  product_codes: string[];
  source_sheet: string | null;
  source_row: number | null;
  link_status: LinkStatus | null;
  link_checked_at: string | null;
  link_http_status: number | null;
  link_final_url: string | null;
  link_check_note: string | null;
  products: ProductMatch[];
  product_labels?: { name: string }[];
  unknown_product_codes: string[];
  product_status: 'identified' | 'queued' | 'unknown' | null;
  product_source: 'explicit_import' | 'metadata_text' | 'vision' | 'manual' | null;
  product_confidence: number | null;
  product_evidence: string | null;
  product_checked_at: string | null;
};

type LinkStatus = 'active' | 'missing' | 'restricted' | 'unknown' | 'invalid';
type ProductMatch = { raw_code: string; raw_offer_id: string; sku: string; name: string; pack_factor: number | null; source: string; confidence: number };

type Collaboration = {
  id?: string;
  platform?: string | null;
  status?: string | null;
  contact_channel?: string | null;
  next_action?: string | null;
  next_action_at?: string | null;
  offer_type?: string | null;
  deliverables?: string | null;
  product_codes?: string | null;
  sample_status?: string | null;
  content_due_at?: string | null;
  rights_scope?: string | null;
  rights_expires_at?: string | null;
  notes?: string | null;
};

type PayoutStatus = 'awaiting_approval' | 'approved' | 'sent' | 'paid' | 'failed';
type Payout = {
  id: string;
  product?: string | null;
  amount_minor: number;
  currency: string;
  status: PayoutStatus;
  payout_date: string;
  approved_at: string | null;
  sent_at: string | null;
  paid_at: string | null;
  failed_at: string | null;
  bank_ref: string | null;
  note: string | null;
  updated_at: number;
  konsol_payment_id?: string | null;
  konsol_status?: string | null;
  handle?: string | null;
  phone_masked?: string | null;
  fps_bank_member_id?: string | null;
  execute_claim?: string | null;
  has_requisites?: number | boolean;
  over_limit?: boolean;
  notice_status?: 'sending' | 'delivered' | 'failed' | 'queued' | null;
  notice_error?: string | null;
  notice_at?: string | null;
};

type PaidCount = { count: number; minor: number; day: string };
type RegisterRecord = { amount_minor: number; source_document: string; source_sheet: string; source_row: number; source_title?: string; amount_column?: string };

type Creator = {
  id: string;
  normalized_handle: string;
  display_name: string | null;
  city?: string | null;
  archived_at?: number | null;
  category: string | null;
  audience_market: string | null;
  audience_language: string | null;
  lifecycle_stage: string;
  origin?: 'invited' | 'self' | null;
  priority: string | null;
  owner: string | null;
  notes: string | null;
  profiles: PlatformMetric[];
  collaboration: Collaboration | null;
  payout?: Payout | null;
  payment_register?: RegisterRecord[];
  payment_sources?: { source_document: string; source_title: string; records: RegisterRecord[] }[];
  payouts?: Payout[];
  paid_total_minor?: number;
  last_activity_at?: number | null;
  attention?: { at: string; code?: string; status: string; kind: string; label: string; reason: string; last_in?: Array<{ id: string; text: string; images: number; at: string }> } | null;
};

type LinkSummary = {
  linked_content: number;
  links_active: number;
  links_missing: number;
  links_restricted: number;
  links_unknown: number;
  links_invalid: number;
  links_unchecked: number;
  links_checked_30d: number;
  links_last_checked_at: string | null;
  link_check_history: number;
  product_identified: number;
  product_queued: number;
};

type UgcPayload = {
  creators: Creator[];
  inactive_count?: number;
  payout_summary?: { paid_konsol?: { today: PaidCount; yesterday: PaidCount }; konsol_own_minor?: number | null; queue_need_minor?: number };
  summary: { creators: number; profiles: number; content_items: number; active_outreach: number; published: number } & LinkSummary;
  platforms: { platform: string; creator_count: number }[];
  products: { sku: string; name: string; content_count: number }[];
};

const PLATFORM_TABS = ['all', 'instagram', 'tiktok', 'vk', 'shopee', 'lazada', 'facebook', 'telegram', 'youtube', 'other'];
// Diana's statuses (Owner 2026-10-15, DH-LAW-261015-02): one English word, at most 7 letters.
const STAGES = ['replied', 'agreed', 'cart', 'paid', 'ordered', 'creation', 'posted', 'gold', 'silent', 'failed', 'fee', 'refused', 'unfit', 'rival', 'owner'];
const ORIGINS = ['invited', 'self'];
const API_EMPTY: UgcPayload = { creators: [], summary: { creators: 0, profiles: 0, content_items: 0, active_outreach: 0, published: 0, linked_content: 0, links_active: 0, links_missing: 0, links_restricted: 0, links_unknown: 0, links_invalid: 0, links_unchecked: 0, links_checked_30d: 0, links_last_checked_at: null, link_check_history: 0, product_identified: 0, product_queued: 0 }, platforms: [], products: [] };

function formatNumber(value: number | null | undefined): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en', { maximumFractionDigits: 1, notation: value >= 10_000 ? 'compact' : 'standard' }).format(value);
}

function compactProductCode(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^DE/i, '') || 'Unknown';
}

function primaryProfile(creator: Creator, activePlatform: string): PlatformMetric {
  return creator.profiles.find((profile) => profile.platform === activePlatform)
    ?? [...creator.profiles].sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1))[0];
}

function unavailableInstagram(profile: PlatformMetric): boolean {
  return profile.platform === 'instagram' && profile.availability_status === 'unavailable';
}

function ProfileAvailability({ profile }: { profile: PlatformMetric }) {
  if (!unavailableInstagram(profile)) return null;
  const checked = profile.availability_checked_at ? new Date(profile.availability_checked_at).toLocaleString('ru-RU', { timeZone: 'Asia/Yerevan', dateStyle: 'short', timeStyle: 'short' }) : null;
  return <span className="ugc-profile-unavailable" title={['Instagram недоступен', checked ? `Проверено: ${checked}` : null, profile.availability_note].filter(Boolean).join(' · ')}><Link2Off aria-hidden="true" />Instagram недоступен</span>;
}

function contentHref(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function linkedContent(profile: PlatformMetric): { item: ContentObservation; href: string }[] {
  return profile.content.flatMap((item) => { const href = contentHref(item.content_url); return href ? [{ item, href }] : []; });
}

function mediaKind(item: ContentObservation): 'Video' | 'Image' | 'Post' | 'Content' {
  const value = item.content_type?.toLowerCase() ?? '';
  if (value.includes('video') || value.includes('reel')) return 'Video';
  if (value.includes('image') || value.includes('photo')) return 'Image';
  if (value.includes('post')) {
    if (item.content_url?.includes('instagram.com/p/')) return 'Image';
    return 'Post';
  }
  return 'Content';
}

// «Оплата» (Owner 2026-10-15): green only when executed in Konsol; brown when
// requisites are in and the payout waits; grey without requisites; red when it
// failed or sat «Отправлено» without Konsol for 2 days. Reason under the amount.
function payoutTitle(payout: Payout | null | undefined): string {
  if (!payout) return PAYOUT_STATUS_LABEL.none;
  const at = payout.paid_at ?? payout.sent_at ?? payout.approved_at ?? payout.failed_at;
  return [payoutCell(payout).title, formatRub(payout.amount_minor), at ? new Date(at).toLocaleString('ru-RU', { timeZone: 'Asia/Yerevan', dateStyle: 'short', timeStyle: 'short' }) : null, payout.bank_ref].filter(Boolean).join(' · ');
}

// «Откуда» (Owner 2026-10-15): set once, never a step; sits right after the @account. Invited — brown magnifier;
// self — green raised hand, the creator volunteered. No mark until Diana knows.
function OriginMark({ origin }: { origin?: string | null }) {
  if (origin !== 'invited' && origin !== 'self') return null;
  const label = origin === 'invited' ? 'Мы пригласили' : 'Сама пришла';
  return <span className="ugc-origin" data-origin={origin} role="img" aria-label={label} title={label}>{origin === 'invited' ? <Search className="h-4 w-4" aria-hidden="true" /> : <Hand className="h-4 w-4" aria-hidden="true" />}</span>;
}

// «Оплатить» (Owner 2026-10-15): Admin only; the Owner confirms, then the click
// goes to POST /api/ugc/payouts/:id/execute. Nothing pays without that click.
type PayApi = { isAdmin: boolean; busy: ReadonlySet<string>; errors: Readonly<Record<string, string>>; pay: (payout: Payout) => void };
const PayContext = createContext<PayApi>({ isAdmin: false, busy: new Set(), errors: {}, pay: () => undefined });

function RegisterAmounts({ records }: { records: RegisterRecord[] }) {
  const total = records.reduce((sum, row) => sum + row.amount_minor, 0);
  const sourceTitle = records[0]?.source_title ?? 'Оплаты Консоль';
  const title = `Итог ${records.length} строк «${sourceTitle}», включая повторы по указанию владельца. Исполнение старых переводов не подтверждено.`;
  return <span className="ugc-payout-cell" title={title}>
    <span className="ugc-payout" data-tone="grey" data-source="register">{formatRub(total)}</span>
    <span className="ugc-payout-reason" data-source="register">{sourceTitle === 'Blooger Database' ? 'по базе' : 'по реестру'}</span>
  </span>;
}

function CreatorPayment({ creator }: { creator: Creator }) {
  if (creator.payout || !creator.payment_register?.length) return <PayoutBadge payout={creator.payout} />;
  return <RegisterAmounts records={creator.payment_register} />;
}

// Owner 2026-10-18: Gold is awarded by hand after watching the reel — a star next to «posted».
// Owner 2026-10-18: a photo the ERP cannot open — the Owner looks in the app and tells Diana what is on it.
// Owner 2026-10-19: decision window on every business exclamation mark — one line, Diana answers by it.
function DecisionNote({ creatorId, onSaved }: { creatorId: string; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  if (done) return <p className="ugc-photo-note" role="status"><strong>Решение передано Диане.</strong> Она ответит блогеру в ближайшую минуту.</p>;
  return <form className="ugc-photo-note" onSubmit={async (event) => {
    event.preventDefault();
    if (!text.trim()) { setError('Напишите решение'); return; }
    setBusy(true); setError('');
    const r = await apiPost(`/api/ugc/creators/${creatorId}/decision`, { text: text.trim() });
    setBusy(false);
    if (r.success) { setText(''); setDone(true); onSaved(); window.dispatchEvent(new Event('ugc:reload')); } else setError(r.errors?.[0]?.message ?? 'Не сохранилось');
  }}>
    <label htmlFor={`decision-${creatorId}`}>Ваше решение для Дианы</label>
    <textarea id={`decision-${creatorId}`} value={text} onChange={(event) => { setText(event.target.value); if (error) setError(''); }} rows={2} placeholder="Например: ссылки нет, вежливо попроси ссылку на пост" />
    <button type="submit" disabled={busy}>{busy ? 'Передаю…' : 'Передать Диане'}</button>
    {error ? <span role="alert">{error}</span> : null}
  </form>;
}

function PhotoNote({ creatorId, onSaved }: { creatorId: string; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form className="ugc-photo-note" onSubmit={async (event) => {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true); setError('');
    const r = await apiPost(`/api/ugc/creators/${creatorId}/photo-note`, { text: text.trim() });
    setBusy(false);
    if (r.success) { setText(''); onSaved(); window.dispatchEvent(new Event('ugc:reload')); } else setError(r.errors?.[0]?.message ?? 'Не сохранилось');
  }}>
    <label htmlFor={`photo-note-${creatorId}`}>Что на фото</label>
    <textarea id={`photo-note-${creatorId}`} value={text} onChange={(event) => setText(event.target.value)} rows={2} placeholder="Например: скрин заказа, TERMO, 395 ₽" />
    <button type="submit" disabled={busy || !text.trim()}>{busy ? 'Передаю…' : 'Передать Диане'}</button>
    {error ? <span role="alert">{error}</span> : null}
  </form>;
}

function GoldAward({ creator }: { creator: Creator }) {
  const { isAdmin } = useContext(PayContext);
  const [busy, setBusy] = useState(false);
  if (!isAdmin || creator.lifecycle_stage !== 'posted') return null;
  return <button type="button" className="ugc-gold-btn" disabled={busy} title="Вручить Gold" aria-label={`Вручить Gold ${creator.normalized_handle}`} onClick={async (event) => {
    event.preventDefault(); event.stopPropagation();
    if (!window.confirm(`Вручить Gold @${creator.normalized_handle}?`)) return;
    setBusy(true);
    const r = await apiPatch(`/api/ugc/creators/${creator.id}`, { lifecycle_stage: 'gold' });
    setBusy(false);
    if (r.success) window.dispatchEvent(new Event('ugc:reload'));
  }}><Star className="h-3.5 w-3.5" aria-hidden="true" /></button>;
}

function CreatorStatus({ creator }: { creator: Creator }) {
  return <span className="ugc-stage-wrap"><CreatorStatusBadge creator={creator} /><GoldAward creator={creator} /></span>;
}

function CreatorStatusBadge({ creator }: { creator: Creator }) {
  const href = instagramChatHref(creator.profiles);
  // Owner 2026-10-18: no status (old new/sent) shows as a plain dash, not a word.
  if (!creator.lifecycle_stage || creator.lifecycle_stage === 'new' || creator.lifecycle_stage === 'sent') return <span className="ugc-stage ugc-stage-none" title="Без статуса">—</span>;
  return href
    ? <a href={href} target="_blank" rel="noopener noreferrer" className="ugc-stage ugc-stage-btn focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" data-stage={creator.lifecycle_stage} aria-label={`Переписка в Instagram · ${creator.lifecycle_stage}`} title="Открыть переписку в Instagram">{creator.lifecycle_stage}</a>
    : <span className="ugc-stage" data-stage={creator.lifecycle_stage} title="Instagram-аккаунт не указан">{creator.lifecycle_stage}</span>;
}

// The Owner reserved only whitespace for opening the card. Text selection,
// numbers, links, payment buttons and icons retain their own behaviour.
function blankRowClick(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element) || target.closest('button, input, select, textarea, svg, img, [role="img"]') || window.getSelection()?.toString()) return false;
  // A profile link spans its cell: its empty padding is still row whitespace.
  // Only actual text/image hits retain the link action; preventDefault in the row handler cancels blank-link navigation.
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    for (const rect of Array.from(range.getClientRects())) {
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return false;
    }
  }
  return true;
}

function CreatorModal({ creator, onClose, onSaved }: { creator: Creator; onClose: () => void; onSaved: () => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const main = document.querySelector('main');
    const previousOverflow = main?.style.overflow;
    if (main) main.style.overflow = 'hidden';
    dialog.showModal();
    dialog.querySelector('button')?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (main) main.style.overflow = previousOverflow ?? '';
      opener?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} className="ugc-creator-modal" aria-labelledby="ugc-creator-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><CreatorPanel creator={creator} onClose={onClose} onSaved={onSaved} /></dialog>;
}

// Owner 2026-10-19: «Очередь браузера · N». On a computer one button for this machine (PC or Mac);
// on a phone two. A click starts sending at once in the Owner's own Chrome on that machine.
type PayDays = { today: { n: number; minor: number }; yesterday: { n: number; minor: number } };
function BrowserQueueButton() {
  const [count, setCount] = useState<number | null>(null);
  const [pay, setPay] = useState<PayDays | null>(null);
  const [targets, setTargets] = useState<Array<'pc' | 'mac'>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pressed, setPressed] = useState<'pc' | 'mac' | null>(null);
  const [writable, setWritable] = useState(false);
  const refresh = useCallback(async () => {
    try { const r = await apiGet<{ count: number; pay?: PayDays }>('/api/ugc/browser-queue'); if (r.success && r.result) { setCount(r.result.count); setPay(r.result.pay ?? null); } } catch { /* the count stays as it was */ }
  }, []);
  useEffect(() => {
    const user = getUser(); setWritable(user?.role === 'admin' || ['full', 'rw'].includes(user?.permissions?.['/ugc'] ?? ''));
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    setTargets(deviceTargets(navigator.userAgent, nav.userAgentData?.platform || navigator.platform || '', navigator.maxTouchPoints || 0) as Array<'pc' | 'mac'>);
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  if (!writable || count == null) return null;
  // Owner 2026-10-19: no extra line for the result — it shows on the pressed button itself for a few seconds.
  const label = (t: 'pc' | 'mac') => message && pressed === t ? message : targets.length > 1 ? `${t === 'pc' ? 'ПК' : 'Mac'} · ${count}` : `Очередь · ${count}`;
  return <span className="ugc-bq">{targets.map((t) => <button key={t} type="button" className="ugc-bq-btn" disabled={busy || count === 0}
    title={message || (count === 0 ? 'Очередь пуста' : `Отправить ${count} в Chrome на ${t === 'pc' ? 'ПК' : 'Mac'}`)}
    onClick={async () => {
      setBusy(true); setMessage(''); setPressed(t);
      try {
        const r = await apiPost<{ started: boolean; count: number }>('/api/ugc/browser-queue/run', { target: t });
        if (!r.success || !r.result) setMessage(r.errors[0]?.message ?? 'Не удалось запустить');
        else setMessage('Запущено');
      } catch { setMessage('Ответ не получен'); }
      finally { setBusy(false); window.setTimeout(() => setMessage(''), 8_000); window.setTimeout(() => { void refresh(); }, 90_000); }
    }}>{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{label(t)}</button>)}{pay ? <span className="ugc-bq-pay" title="Оплаты блогерам: сегодня и вчера"><span className="ugc-bq-pay-today">{pay.today.n} · {formatRub(pay.today.minor)}</span><span>{pay.yesterday.n} · {formatRub(pay.yesterday.minor)}</span></span> : null}{message ? <span className="sr-only" role="status">{message}</span> : null}</span>;
}

function ProfileRefresh({ profileId, onSaved }: { profileId?: string; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [writable, setWritable] = useState(false);
  useEffect(() => { const user = getUser(); setWritable(user?.role === 'admin' || ['full', 'rw'].includes(user?.permissions?.['/ugc'] ?? '')); }, []);
  if (!writable) return null;
  return <span className="ugc-profile-refresh"><button type="button" disabled={busy} className="ugc-profile-refresh-btn" onClick={async () => {
    setBusy(true); setMessage('');
    try {
      const response = await apiPostTimed<{ attempted: number; updated: number; busy: boolean }>('/api/ugc/profiles/refresh', { profile_id: profileId }, 210_000);
      if (!response.success || !response.result) setMessage(response.errors[0]?.message ?? 'Не удалось обновить');
      else if (response.result.busy) setMessage('Загрузка профилей уже идёт');
      else { setMessage(`Проверено: ${response.result.attempted} · обновлено: ${response.result.updated}`); await onSaved(); }
    } catch { setMessage('Ответ не получен. Проверьте время последней загрузки.'); }
    finally { setBusy(false); }
  }}>{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{busy ? 'Загружаю…' : profileId ? 'Обновить профиль' : 'Профили'}</button>{message ? <span role="status">{message}</span> : null}</span>;
}

// Reuse private authenticated image reads across the desktop list, phone list and card.
const avatarRequests = new Map<string, Promise<string | null>>();
function BloggerAvatar({ profile, compact = false }: { profile: PlatformMetric; compact?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setAvatar(null);
    if (!profile.has_avatar || !ref.current) return;
    const key = `${profile.id}:${profile.avatar_version ?? profile.profile_checked_at ?? ''}`;
    const load = () => {
      let request = avatarRequests.get(key);
      if (!request) {
        request = apiGet<{ data_url: string }>(`/api/ugc/profiles/${encodeURIComponent(profile.id)}/avatar`)
          .then(r => r.success ? r.result?.data_url ?? null : null).catch(() => null);
        avatarRequests.set(key, request);
        request.then(value => { if (!value) avatarRequests.delete(key); });
      }
      request.then(value => { if (active) setAvatar(value); });
    };
    // Hidden responsive lists and off-screen rows do not download images.
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); }
    }, { rootMargin: '160px' });
    observer.observe(ref.current);
    return () => { active = false; observer.disconnect(); };
  }, [profile.id, profile.has_avatar, profile.profile_checked_at, profile.avatar_version]);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setZoomed(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [zoomed]);
  // Owner 2026-10-18: a tap on the avatar shows it large, so the person can be seen; it does not open the profile link.
  const open = (event: MouseEvent | ReactKeyboardEvent<HTMLSpanElement>) => { event.preventDefault(); event.stopPropagation(); setZoomed(true); };
  return <>
    <span ref={ref} role={avatar ? 'button' : 'img'} tabIndex={avatar ? 0 : undefined}
      onClick={avatar ? open : undefined}
      onKeyDown={avatar ? (event => { if (event.key === 'Enter' || event.key === ' ') open(event); }) : undefined}
      aria-label={avatar ? `Увеличить аватар @${profile.handle}` : 'Аватар пока не загружен'} title={avatar ? 'Увеличить фото' : undefined}
      className={`ugc-blogger-avatar${compact ? ' ugc-avatar-compact' : ''}${avatar ? ' ugc-avatar-zoomable' : ' ugc-avatar-empty'}`}>
      {avatar ? <img src={avatar} alt="" width={compact ? 32 : 72} height={compact ? 32 : 72} decoding="async" /> : <Users aria-hidden="true" />}
    </span>
    {zoomed && avatar ? createPortal(<div className="ugc-avatar-zoom" role="dialog" aria-modal="true" aria-label={`Фото @${profile.handle}`} onClick={event => { event.stopPropagation(); setZoomed(false); }}>
      <figure onClick={event => event.stopPropagation()}>
        <img src={avatar} alt={`Фото @${profile.handle}`} />
        <figcaption>@{profile.handle}</figcaption>
        <button type="button" autoFocus onClick={() => setZoomed(false)} aria-label="Закрыть фото"><X className="h-5 w-5" /></button>
      </figure>
    </div>, document.body) : null}
  </>;
}

function BloggerProfile({ profile, onSaved, showHandle = false }: { profile: PlatformMetric; onSaved: () => Promise<void>; showHandle?: boolean }) {
  const date = (value?: string | null) => value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Asia/Yerevan', dateStyle: 'short', timeStyle: 'short' }) : 'ещё не загружен';
  const views = profile.avg_video_views ?? profile.latest_observed_views;
  const er = profile.engagement_rate == null ? '—' : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(profile.engagement_rate)}%`;
  // Owner 2026-10-17: four tiles — followers, average views, publications, ER.
  return <div className="ugc-blogger-profile ugc-card-audience">
    {showHandle ? <div className="ugc-profile-note"><strong>@{profile.handle}</strong> · {platformLabel(profile.platform)}</div> : null}
    <dl className="ugc-card-kpis">
      <div><dt>Подписчики</dt><dd>{formatCount(profile.followers)}</dd></div>
      <div title="Средние просмотры"><dt>Просмотры</dt><dd>{formatCount(views ?? null)}</dd></div>
      <div><dt>Публикации</dt><dd>{formatCount(profile.posts_count ?? null)}</dd></div>
      <div><dt>ER</dt><dd>{er}</dd></div>
    </dl>
    <p className="ugc-profile-note">Данные: {date(profile.profile_checked_at || profile.metrics_as_of)}{profile.profile_error ? ` · Последняя попытка: ${date(profile.profile_attempted_at)}. ${profile.profile_error}` : ''}</p>
    {profile.platform === 'instagram' ? <ProfileRefresh profileId={profile.id} onSaved={onSaved} /> : null}
  </div>;
}

// Owner 2026-10-19: the message about the transfer sits level with the payment badge; the reason shows on hover only.
function NoticeChip({ payout }: { payout: Payout | null | undefined }) {
  const st = payout?.notice_status;
  if (!payout || !st) return null;
  const time = payout.notice_at ? new Date(payout.notice_at).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Yerevan', hour: '2-digit', minute: '2-digit' }) : '';
  const view = st === 'delivered' ? { icon: <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />, text: time, title: `Сообщение о переводе доставлено${time ? ` в ${time}` : ''}` }
    : st === 'queued' ? { icon: <Clock className="h-3.5 w-3.5" aria-hidden="true" />, text: 'очередь', title: payout.notice_error || 'Ждёт отправки из браузера' }
    : st === 'failed' ? { icon: <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />, text: 'нет', title: `Сообщение не доставлено: ${payout.notice_error || 'причина неизвестна'}` }
    : { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />, text: '', title: 'Сообщение отправляется' };
  return <span className="ugc-notice" data-notice={st} title={view.title} aria-label={view.title} onClick={(event) => event.stopPropagation()}>{view.icon}{view.text ? <span>{view.text}</span> : null}</span>;
}


// Owner 2026-10-19: hovering the exclamation mark shows what the blogger last wrote, or her photo.
function AttentionPhoto({ id, index }: { id: string; index: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    apiGet<{ data_url: string }>(`/api/ugc/dm-messages/${encodeURIComponent(id)}/image/${index}`)
      .then((r) => { if (!live) return; if (r.success && r.result?.data_url) setSrc(r.result.data_url); else setFailed(true); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [id, index]);
  if (failed) return <span className="ugc-attn-nophoto">Фото не открывается у нас, оно есть в переписке</span>;
  return src ? <img src={src} alt="Фото от блогера" className="ugc-attn-photo" /> : <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />;
}

function AttentionMark({ attention, name, onOpen }: { attention: NonNullable<Creator['attention']>; name: string; onOpen: () => void }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLButtonElement | null>(null);
  const last = attention.last_in ?? [];
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(window.innerWidth - 336, r.right - 320)) });
  };
  const hide = () => setPos(null);
  return <span className="ugc-attn" onMouseEnter={show} onMouseLeave={hide}>
    <button ref={ref} type="button" onClick={onOpen} onFocus={show} onBlur={hide} aria-label={`${attention.label}: ${name}`}
      className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-sm focus-visible:outline focus-visible:outline-2" style={{ color: '#7a4e25', width: 44, height: 44 }}><AlertCircle className="h-5 w-5" /></button>
    {pos ? createPortal(<span className="ugc-attn-card" role="tooltip" style={{ top: pos.top, left: pos.left }}>
      <strong>{attention.label}</strong>
      <span className="ugc-attn-reason">{attention.reason}</span>
      {attention.kind === 'business' ? <span className="ugc-attn-head">Нажмите на знак, чтобы написать решение</span> : null}
      {last.length ? <span className="ugc-attn-head">Последнее от блогера</span> : null}
      {last.map((m) => <span key={m.id} className="ugc-attn-msg">
        {m.text ? <span>{m.text}</span> : null}
        {Array.from({ length: Math.min(m.images, 2) }, (_, i) => <AttentionPhoto key={i} id={m.id} index={i} />)}
      </span>)}
    </span>, document.body) : null}
  </span>;
}

function PayoutBadge({ payout }: { payout: Payout | null | undefined }) {
  const cell = payoutCell(payout);
  const { isAdmin, busy, errors, pay } = useContext(PayContext);
  const payable = Boolean(isAdmin && payout && canPay(payout));
  const isBusy = Boolean(payout && busy.has(payout.id));
  const payError = payout ? errors[payout.id] : undefined;
  // Owner 2026-10-15: the brown badge itself is the button (Admin only). Green is done, not clickable.
  // Only the clicked badge waits; every other badge stays clickable.
  const badge = payable && payout
    ? <button type="button" className="ugc-payout ugc-payout-btn" data-tone={cell.tone} disabled={isBusy} aria-label={`Оплатить: ${payoutTitle(payout)}`} onClick={(event) => { event.stopPropagation(); pay(payout); }}>{isBusy ? <Loader2 className="h-3 w-3 animate-spin inline" aria-hidden="true" /> : cell.text}</button>
    : <span className="ugc-payout" data-tone={cell.tone} aria-label={payoutTitle(payout)}>{cell.text}</span>;
  return <span className="ugc-payout-cell" title={payable ? `Нажми, чтобы оплатить · ${payoutTitle(payout)}` : payoutTitle(payout)}>
    <span className="ugc-payout-line">{badge}<NoticeChip payout={payout} /></span>
    {payError
      ? <span className="ugc-payout-reason" role="alert" style={{ color: 'var(--status-error)' }}>{payError}</span>
      : cell.reason ? <span className="ugc-payout-reason">{isBusy ? 'отправляю…' : payable ? 'оплатить' : cell.reason}</span> : null}
  </span>;
}

// «Сеть» (Owner 2026-10-14): one monochrome icon per network, never the word.
// Lucide marks where they exist; TikTok is its public glyph in currentColor;
// VK, Shopee and Lazada get a letter mark in the same ink.
const TIKTOK_PATH = 'M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z';
const LETTER_MARK: Record<string, string> = { vk: 'VK', shopee: 'S', lazada: 'L' };

// Owner 2026-10-16: the account name opens the blogger's own page, not our card.
function profileHref(profile: { platform: string; handle: string }): string | null {
  const h = String(profile.handle ?? '').replace(/^@/, '').trim();
  if (!h) return null;
  const p = String(profile.platform ?? '').toLowerCase();
  if (p === 'tiktok') return `https://www.tiktok.com/@${h}`;
  if (p === 'youtube') return `https://www.youtube.com/@${h}`;
  if (p === 'vk') return `https://vk.com/${h}`;
  if (p === 'telegram') return `https://t.me/${h}`;
  if (p === 'facebook') return `https://www.facebook.com/${h}`;
  return `https://www.instagram.com/${h}/`;
}

// Owner 2026-10-18: in the «Сеть» column the mark opens the chat with the blogger —
// Instagram Direct (ig.me/m), Telegram (t.me); TikTok the profile (no chat link exists).
function chatHref(profile: { platform: string; handle: string }): string | null {
  const h = String(profile.handle ?? '').replace(/^@/, '').trim();
  if (!h) return null;
  const p = String(profile.platform ?? '').toLowerCase();
  if (p === 'instagram') return `https://ig.me/m/${encodeURIComponent(h)}`;
  // Telegram: t.me/<handle> opens the chat with that account.
  if (p === 'telegram') return `https://t.me/${encodeURIComponent(h)}`;
  // TikTok has no public chat link by handle: the profile, where Message is one tap away.
  if (p === 'tiktok') return `https://www.tiktok.com/@${encodeURIComponent(h)}`;
  return null;
}

function PlatformIcon({ platform, href }: { platform: string; href?: string | null }) {
  const key = String(platform ?? '').toLowerCase();
  const label = platformLabel(key);
  const glyph = key === 'instagram' ? <Instagram className="h-[18px] w-[18px]" aria-hidden="true" />
    : key === 'youtube' ? <Youtube className="h-[18px] w-[18px]" aria-hidden="true" />
    : key === 'facebook' ? <Facebook className="h-[18px] w-[18px]" aria-hidden="true" />
    : key === 'telegram' ? <Send className="h-[18px] w-[18px]" aria-hidden="true" />
    : key === 'tiktok' ? <svg viewBox="0 0 24 24" className="h-[16px] w-[16px]" aria-hidden="true"><path fill="currentColor" d={TIKTOK_PATH} /></svg>
    : LETTER_MARK[key] ? <span className="ugc-letter-mark" aria-hidden="true">{LETTER_MARK[key]}</span>
    : <Globe className="h-[18px] w-[18px]" aria-hidden="true" />;
  if (href) return <a href={href} target="_blank" rel="noopener noreferrer" className="ugc-platform-icon ugc-platform-chat" aria-label={key === 'tiktok' ? `${label}: написать автору` : `${label}: открыть чат`} title={key === 'instagram' ? `${label} — открыть чат в Direct` : key === 'telegram' ? `${label} — открыть чат` : `${label} — открыть страницу, там кнопка сообщения`} onClick={(event) => event.stopPropagation()}>{glyph}</a>;
  return <span className="ugc-platform-icon" role="img" aria-label={label} title={label}>{glyph}</span>;
}

function PlatformIcons({ creator, chat = false }: { creator: Creator; chat?: boolean }) {
  const platforms = Array.from(new Set(creator.profiles.map((profile) => String(profile.platform ?? '').toLowerCase()).filter(Boolean)));
  if (!platforms.length) return <span className="ugc-muted">—</span>;
  const linkFor = (platform: string) => {
    if (!chat) return null;
    const profile = creator.profiles.find((item) => String(item.platform ?? '').toLowerCase() === platform && item.handle);
    return profile ? chatHref(profile) : null;
  };
  return <span className="ugc-platforms-cell">{platforms.map((platform) => <PlatformIcon key={platform} platform={platform} href={linkFor(platform)} />)}</span>;
}

const LINK_STATUS_LABEL: Record<LinkStatus, string> = { active: 'Active', missing: 'Missing', restricted: 'Restricted', unknown: 'Unknown', invalid: 'Invalid' };
// Table cells speak Russian, like the column heads (Owner 2026-10-14).
const LINK_STATUS_SHORT: Record<LinkStatus, string> = { active: 'Доступна', missing: 'Удалена', restricted: 'Закрыта', unknown: 'Не ясно', invalid: 'Ошибка' };
const MEDIA_LABEL: Record<ReturnType<typeof mediaKind>, string> = { Video: 'видео', Image: 'фото', Post: 'пост', Content: 'ссылка' };
// «Продукт» (Owner 2026-10-16): no «+N»; two rows of three, six at most.
const PRODUCT_PILLS = 6;
// «Контент» (Owner 2026-10-16): per publication, its link icon as tall as the three
// figures stacked right of it (views, likes, comments); a dead link is faded.
// Two publications side by side, then «+N».
const CONTENT_ICONS = 2;
const DEAD_LINK: ReadonlySet<LinkStatus> = new Set<LinkStatus>(['missing', 'restricted', 'invalid']);

function Publication({ item, href, more }: { item: ContentObservation; href: string; more: number }) {
  const kind = mediaKind(item);
  const status = item.link_status ? LINK_STATUS_SHORT[item.link_status] : 'Не проверена';
  const state = item.link_status === 'active' ? 'live' : item.link_status && DEAD_LINK.has(item.link_status) ? 'dead' : 'unknown';
  // The network the link lives on (Owner 2026-10-16, Marika): Instagram, TikTok, YouTube…
  // instead of photo / video glyphs; a live link is bright, a dead one faded (data-state).
  const host = (() => { try { return new URL(href).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } })();
  const net = /instagram\.com|instagr\.am/.test(host) ? 'instagram' : /tiktok\.com/.test(host) ? 'tiktok' : /youtube\.com|youtu\.be/.test(host) ? 'youtube'
    : /vk\.com|vkvideo\.ru/.test(host) ? 'vk' : /t\.me|telegram/.test(host) ? 'telegram' : /facebook\.com|fb\.watch/.test(host) ? 'facebook' : '';
  const Glyph = net === 'instagram' ? Instagram : net === 'youtube' ? Youtube : net === 'telegram' ? Send : net === 'facebook' ? Facebook : null;
  const read = item.metrics_checked_at ? ` · ${new Date(item.metrics_checked_at).toLocaleDateString('ru-RU')}` : '';
  const figure = (label: string, value: number | null | undefined) => `${label}: ${value == null ? 'нет данных' : value}${read}`;
  return <span className="ugc-pub" data-state={state} data-net={net || undefined}>
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} className="ugc-pub-link focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={`${net ? platformLabel(net) : 'Ссылка'} · ${MEDIA_LABEL[kind]} · ${status}`} title={[net ? platformLabel(net) : null, MEDIA_LABEL[kind], status, item.link_checked_at ? new Date(item.link_checked_at).toLocaleDateString('ru-RU') : null, item.content_url].filter(Boolean).join(' · ')}>{Glyph ? <Glyph aria-hidden="true" /> : net === 'tiktok' ? <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={TIKTOK_PATH} /></svg> : net === 'vk' ? <span className="ugc-pub-letter" aria-hidden="true">VK</span> : <Link aria-hidden="true" />}</a>
    <span className="ugc-pub-stats">
      <span title={figure('Просмотры', item.views)}><Eye aria-hidden="true" />{formatCount(item.views)}</span>
      <span title={figure('Лайки', item.likes)}><Heart aria-hidden="true" />{formatCount(item.likes)}</span>
      <span title={figure('Комментарии', item.comments)}><MessageCircle aria-hidden="true" />{formatCount(item.comments)}</span>
    </span>
    {more > 0 ? <span className="ugc-pub-more" title={`Ещё ${more}`}>+{more}</span> : null}
  </span>;
}

function formatCheckedAt(value: string | null | undefined): string {
  if (!value) return 'Not checked';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date);
}

function statusColor(status: LinkStatus | null): string {
  if (status === 'active') return 'var(--status-success)';
  if (status === 'restricted' || status === 'unknown') return 'var(--status-warning)';
  if (status === 'missing' || status === 'invalid') return 'var(--status-error)';
  return 'var(--fg-3)';
}

function LinkHealth({ item, compact = false }: { item: ContentObservation; compact?: boolean }) {
  const label = item.link_status ? LINK_STATUS_LABEL[item.link_status] : 'Not checked';
  return <span className={`inline-flex items-center gap-1.5 ${compact ? 'text-xs' : 'text-sm'}`} style={{ color: statusColor(item.link_status) }} title={[item.link_check_note, item.link_checked_at ? formatCheckedAt(item.link_checked_at) : null].filter(Boolean).join(' · ') || undefined}><span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: statusColor(item.link_status) }} />{label}{item.link_checked_at ? ` · ${compact ? new Date(item.link_checked_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : formatCheckedAt(item.link_checked_at)}` : ''}</span>;
}

function ProductEvidence({ item }: { item: ContentObservation }) {
  if (item.product_labels?.length) return <div className="flex flex-wrap gap-2">{item.products.map((product) => <span key={product.sku} className="ugc-pill">{compactProductCode(product.sku)} · {product.name}</span>)}{item.product_labels.map((label) => <span key={label.name} className="ugc-pill">{label.name} · тип не указан</span>)}</div>;
  if (item.products.length) return <div className="flex flex-wrap items-center gap-2">{item.products.map((product) => <span key={`${product.sku}-${product.raw_offer_id}`} title={product.name} className="ugc-pill">{compactProductCode(product.sku)} · {product.name}</span>)}<span className="text-xs" style={{ color: 'var(--status-success)' }}>{item.product_source === 'metadata_text' ? 'По описанию публикации' : 'По товарному полю источника'}</span></div>;
  if (item.unknown_product_codes.length) return <div className="text-xs" style={{ color: 'var(--status-warning)' }}>Неизвестный код товара: {item.unknown_product_codes.join(', ')}</div>;
  if (item.product_status === 'queued') return <div className="text-xs" style={{ color: 'var(--fg-3)' }}>Товар ещё не определён</div>;
  let result: string | undefined;
  try { result = JSON.parse(item.product_evidence ?? '{}').result; } catch { /* legacy evidence */ }
  return <div className="text-xs" style={{ color: 'var(--fg-3)' }}>{result === 'unavailable' ? 'Публикация недоступна; товар не определён' : result === 'no_product_match' ? 'В описании нет точного товара' : 'В источнике товар не указан'}</div>;
}

// «Оплачено сегодня / вчера» (Owner 2026-10-15): only payouts executed in Konsol.
/** The cached copy keeps only what the table shows: no phone mask, no bank ids. */
function cacheSafe(payload: UgcPayload): UgcPayload {
  const strip = (p: Payout): Payout => ({ ...p, phone_masked: null, fps_bank_member_id: null, bank_ref: null });
  return { ...payload, creators: payload.creators.map((c) => ({ ...c, payout: c.payout ? strip(c.payout) : c.payout, payouts: c.payouts?.map(strip) })) };
}

function PaidCounter({ paid, own, need }: { paid?: { today: PaidCount; yesterday: PaidCount }; own?: number | null; need?: number }) {
  if (!paid) return null;
  const part = (label: string, p: PaidCount) => <span>{label}: <b>{p.count}</b> на <b>{formatRub(p.minor) || '0 ₽'}</b></span>;
  // Owner 2026-10-20: own RUB in Konsol on the same line; red when it cannot cover the queue.
  const short = own != null && (need ?? 0) > own;
  return <div className="ugc-paid-counter" data-short={short ? 'yes' : undefined} title="Только выплаты, исполненные в Консоли">Оплачено блогерам · {part('сегодня', paid.today)} · {part('вчера', paid.yesterday)}
    {own != null ? <> · <span className="ugc-konsol-own">на счёте Консоли <b>{formatRub(own) || '0 ₽'}</b>{short ? <>, не хватает <b>{formatRub((need ?? 0) - own)}</b></> : null}</span></> : null}</div>;
}

function Kpi({ label, value, exact, note, accent }: { label: string; value: string; exact: string; note: string; accent: string }) {
  return (
    <div className="ugc-kpi" title={exact} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', borderTop: `4px solid ${accent}`, borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-raised)' }}>
      <div className="dx-eyebrow ugc-kpi-label" style={{ color: 'var(--fg-3)' }}>{label}</div>
      <div className="ugc-kpi-value" style={{ fontFamily: 'var(--font-display)', fontSize: '24px', fontWeight: 900, lineHeight: 1 }}>{value}</div>
      <div className="ugc-kpi-note" style={{ color: 'var(--fg-2)' }}>{note}</div>
    </div>
  );
}

// Owner 2026-10-14: every head reads in full. A head wider than its column steps
// its size down by half a point to 10px; only at 10px may it wrap. No ellipsis,
// no letter-spacing.
const HEAD_MAX = 14;
const HEAD_MIN = 10;
function fitHeads(table: HTMLTableElement | null) {
  if (!table) return;
  table.querySelectorAll<HTMLTableCellElement>('thead th').forEach((th) => {
    th.style.removeProperty('font-size');
    th.style.removeProperty('white-space');
    if (th.offsetParent === null) return;
    let size = HEAD_MAX;
    th.style.setProperty('font-size', `${size}px`, 'important');
    while (th.scrollWidth > th.clientWidth && size > HEAD_MIN) {
      size -= 0.5;
      th.style.setProperty('font-size', `${size}px`, 'important');
    }
    if (th.scrollWidth > th.clientWidth) th.style.setProperty('white-space', 'normal', 'important');
  });
  // A figure never hides behind an ellipsis either (§4h-2): it shrinks, it is not cut.
  // Read every cell first (one layout), then touch only the few that overflow.
  const over = Array.from(table.querySelectorAll<HTMLTableCellElement>('tbody td.ugc-c-num'))
    .filter((td) => td.offsetParent !== null && td.scrollWidth > td.clientWidth);
  over.forEach((td) => {
    let size = parseFloat(getComputedStyle(td).fontSize) || HEAD_MAX;
    while (td.scrollWidth > td.clientWidth && size > HEAD_MIN) {
      size -= 0.5;
      td.style.setProperty('font-size', `${size}px`, 'important');
    }
  });
}

export default function UgcPage() {
  const [data, setData] = useState<UgcPayload>(API_EMPTY);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [platform, setPlatform] = useState('all');
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [inactive, setInactive] = useState(false);
  const [product, setProduct] = useState('');
  const [sort, setSort] = useState('recent');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const urlStateReady = useRef(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [payBusy, setPayBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [payErrors, setPayErrors] = useState<Record<string, string>>({});
  const payLock = useRef<Set<string>>(new Set());
  useEffect(() => { setIsAdmin(getUser()?.role === 'admin'); }, []);

  // Owner 2026-10-15: render at once from this tab's cached copy, revalidate in
  // the background. Cache per user and filter; phones and bank data are stripped.
  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams();
    if (platform !== 'all') params.set('platform', platform);
    if (search.trim()) params.set('search', search.trim());
    if (stage) params.set('stage', stage);
    if (product) params.set('product', product);
    if (inactive) params.set('inactive', '1');
    const key = `ugc-cache:v3:${getUser()?.id ?? 'anon'}:${params.toString()}`;
    let cached: UgcPayload | null = null;
    try { const raw = sessionStorage.getItem(key); cached = raw ? JSON.parse(raw) as UgcPayload : null; } catch { cached = null; }
    if (cached) { setData(cached); setLoading(false); } else setLoading(true);
    const response = await apiGet<UgcPayload>(`/api/ugc?${params.toString()}`);
    if (!response.success || !response.result) setError(response.errors[0]?.message ?? 'UGC data could not be loaded');
    else {
      setData(response.result);
      try { sessionStorage.setItem(key, JSON.stringify(cacheSafe(response.result))); } catch { /* full or blocked — fine */ }
    }
    setLoading(false);
  }, [platform, search, stage, product, inactive]);

  useEffect(() => {
    const timer = window.setTimeout(load, 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Owner 2026-10-18: a tab left open overnight showed yesterday's grey amounts. The list now
  // refreshes itself every 2 minutes while visible and at once when the tab is opened again.
  useEffect(() => {
    const reload = () => { void load(); };
    window.addEventListener('ugc:reload', reload);
    return () => window.removeEventListener('ugc:reload', reload);
  }, [load]);

  useEffect(() => {
    let last = Date.now();
    const refresh = () => { if (document.visibilityState !== 'visible') return; if (Date.now() - last < 60_000) return; last = Date.now(); void load(); };
    const tick = window.setInterval(() => { if (document.visibilityState === 'visible') { last = Date.now(); void load(); } }, 120_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(tick); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); };
  }, [load]);

  useEffect(() => {
    if (!urlStateReady.current) return;
    const params = new URLSearchParams(window.location.search);
    if (platform === 'all') params.delete('platform'); else params.set('platform', platform);
    if (search.trim()) params.set('search', search.trim()); else params.delete('search');
    if (stage) params.set('stage', stage); else params.delete('stage');
    if (product) params.set('product', product); else params.delete('product');
    if (inactive) params.set('inactive', '1'); else params.delete('inactive');
    if (sort === 'recent') params.delete('sort'); else params.set('sort', sort);
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, [platform, search, stage, product, sort, inactive]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlPlatform = params.get('platform');
    const urlSort = params.get('sort');
    if (urlPlatform && PLATFORM_TABS.includes(urlPlatform)) setPlatform(urlPlatform);
    if (urlSort && ['recent', 'followers', 'views', 'stage', 'attention'].includes(urlSort)) setSort(urlSort);
    setSearch(params.get('search') ?? '');
    setStage(params.get('stage') ?? '');
    setInactive(params.get('inactive') === '1');
    setProduct(params.get('product') ?? '');
    urlStateReady.current = true;
  }, []);

  const creators = useMemo(() => {
    // Hide stale rows immediately while the separately filtered request is loading.
    const rows = data.creators.filter((creator) => creator.profiles.some(unavailableInstagram) === inactive);
    rows.sort((a, b) => {
      const ap = primaryProfile(a, platform);
      const bp = primaryProfile(b, platform);
      if (sort === 'attention') return Number(Boolean(b.attention)) - Number(Boolean(a.attention)) || Date.parse(b.attention?.at ?? '') - Date.parse(a.attention?.at ?? '') || ((b.last_activity_at ?? -1) - (a.last_activity_at ?? -1));
      if (sort === 'views') return (bp.avg_video_views ?? bp.latest_observed_views ?? -1) - (ap.avg_video_views ?? ap.latest_observed_views ?? -1);
      if (sort === 'stage') return a.lifecycle_stage.localeCompare(b.lifecycle_stage);
      if (sort === 'recent') return ((b.last_activity_at ?? -1) - (a.last_activity_at ?? -1)) || ((bp.followers ?? -1) - (ap.followers ?? -1));
      return (bp.followers ?? -1) - (ap.followers ?? -1);
    });
    return rows;
  }, [data.creators, platform, sort, inactive]);
  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    fitHeads(table);
    // Refit only when the table WIDTH changes: refitting changes row heights, and
    // reacting to height would loop every frame.
    let lastWidth = table.clientWidth;
    const observer = new ResizeObserver(() => {
      if (table.clientWidth === lastWidth) return;
      lastWidth = table.clientWidth;
      fitHeads(table);
    });
    observer.observe(table);
    document.fonts?.ready.then(() => fitHeads(table));
    return () => observer.disconnect();
  }, [creators, loading]);
  const selected = data.creators.find((creator) => creator.id === selectedId) ?? null;
  const headline = useMemo(() => {
    const profiles = data.creators.flatMap((creator) => creator.profiles);
    const followers = profiles.reduce((sum, item) => sum + (item.followers ?? 0), 0);
    const views = profiles.map((item) => item.avg_video_views ?? item.latest_observed_views).filter((value): value is number => value != null);
    return { followers, avgViews: views.length ? views.reduce((a, b) => a + b, 0) / views.length : null };
  }, [data.creators]);

  const mergePayout = (id: string, patch: Partial<Payout>) => {
    const merge = (item: Payout): Payout => (item.id === id ? { ...item, ...patch } as Payout : item);
    setData((prev) => ({ ...prev, creators: prev.creators.map((creator) => ({
      ...creator,
      payout: creator.payout ? merge(creator.payout) : creator.payout,
      payouts: creator.payouts?.map(merge),
    })) }));
  };
  // After a pay click: ask Konsol (through the ERP) about that one payout until
  // it is executed or failed — the badge goes from light green to green.
  const watchPayout = async (id: string) => {
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      try {
        const r = await apiPost<{ status?: string; konsol_status?: string }>(`/api/ugc/payouts/${encodeURIComponent(id)}/refresh`, {});
        const status = r.result?.status;
        if (r.success && (status === 'paid' || status === 'failed')) {
          mergePayout(id, { status: status as PayoutStatus, konsol_status: r.result?.konsol_status ?? null, ...(status === 'paid' ? { paid_at: new Date().toISOString() } : { failed_at: new Date().toISOString() }) });
          return;
        }
      } catch { /* next try */ }
    }
  };

  const payApi: PayApi = {
    isAdmin,
    busy: payBusy,
    errors: payErrors,
    // Owner 2026-10-15: one click pays — no confirm, no page reload. The badge
    // turns light green from the execute answer; green when Konsol executes.
    // Only the clicked payout is locked; 20 s without an answer ends with the
    // words on the badge. The server lock (execute_claim) still stops a double pay.
    pay: async (payout) => {
      const id = payout.id;
      if (payLock.current.has(id)) return;
      payLock.current.add(id);
      setPayBusy((prev) => new Set(prev).add(id));
      setPayErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
      const fail = (text: string) => {
        setPayErrors((prev) => ({ ...prev, [id]: text }));
        setError(`${payout.handle ? `@${payout.handle}: ` : ''}${text}`);
      };
      try {
        const response = await apiPostTimed<{ payout?: Partial<Payout> }>(`/api/ugc/payouts/${encodeURIComponent(id)}/execute`, {}, 20_000);
        const sent = response.result?.payout;
        if (response.success && sent) {
          mergePayout(id, sent);
          void watchPayout(id);
        } else {
          fail(`Не ушло: ${response.errors?.[0]?.message ?? 'ошибка'}`);
        }
      } catch (reason) {
        const name = reason instanceof Error ? reason.name : '';
        fail(name === 'AbortError' || name === 'TimeoutError'
          ? 'Нет ответа 20 с, проверь Консоль'
          : `Нет связи: ${reason instanceof Error ? reason.message : String(reason)}`);
      } finally {
        payLock.current.delete(id);
        setPayBusy((prev) => { const next = new Set(prev); next.delete(id); return next; });
      }
    },
  };

  return (
    <PayContext.Provider value={payApi}>
    <div className="ugc-page">
      <header className="ugc-heading">
        <h1>UGC</h1>
        <p>Creators, platform evidence, outreach, samples, content and usage rights in one operating view.</p>
      </header>

      {error && <div role="alert" className="p-4 flex items-start justify-between gap-4" style={{ background: 'var(--paper-sunk)', borderLeft: '4px solid var(--status-error)' }}><span>{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError(null)} className="min-h-11 flex items-center justify-center" style={{ minWidth: '44px' }}><X className="h-5 w-5" /></button></div>}

      {/* One line on top (Owner 2026-10-16): payments made today and yesterday — no day limit any more. */}
      <PaidCounter paid={data.payout_summary?.paid_konsol} own={data.payout_summary?.konsol_own_minor} need={data.payout_summary?.queue_need_minor} />
      <section className="ugc-kpis grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2">
        <Kpi label="Creators" value={formatNumber(data.summary.creators)} exact={`${data.summary.creators} creators`} note="in this view" accent="var(--brand-schwarz)" />
        <Kpi label="Followers" value={formatNumber(headline.followers)} exact={`${headline.followers} followers`} note="known audience" accent="var(--brand-rot)" />
        <Kpi label="Avg views" value={formatNumber(headline.avgViews)} exact={headline.avgViews == null ? 'Unknown' : `${headline.avgViews} average views`} note="per known profile" accent="var(--status-info)" />
        <Kpi label="Publications" value={formatNumber(data.summary.content_items)} exact={`${data.summary.content_items} publications`} note="observed content" accent="var(--brand-schwarz)" />
        <Kpi label="Products" value={formatNumber(data.products.length)} exact={`${data.products.length} identified product families`} note={`${formatNumber(data.summary.product_queued)} queued`} accent="var(--brand-gold)" />
      </section>

      <section className="ugc-controls" data-expanded={filtersExpanded}>
        <div className="ugc-mobile-controls"><h2>UGC</h2><span>{formatNumber(data.summary.creators)} creators</span><button type="button" aria-expanded={filtersExpanded} aria-controls="ugc-platforms ugc-filters" onClick={() => setFiltersExpanded((value) => !value)}>{filtersExpanded ? 'Close filters' : `Filters${platform !== 'all' || stage || product ? ' · active' : ''}`}</button></div>
        <div className="ugc-chips-row">
          <div id="ugc-platforms" className="ugc-platforms flex flex-wrap gap-2 pb-1" aria-label="Platforms">
            {PLATFORM_TABS.map((key) => {
              const count = key === 'all' ? data.summary.creators : data.platforms.find((item) => item.platform === key)?.creator_count;
              return <button key={key} type="button" aria-pressed={platform === key} onClick={() => setPlatform(key)} className="min-h-11 shrink-0 px-1 flex items-center font-bold capitalize focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"><span className="px-2.5 py-1" style={{ color: platform === key ? 'var(--fg-on-brand)' : 'var(--fg-1)', background: platform === key ? 'var(--brand-schwarz)' : 'var(--paper-sunk)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-pill)' }}>{key} {count != null ? `· ${count}` : ''}</span></button>;
            })}
          </div>
          <div className="ugc-profile-tools"><button type="button" className="ugc-tools-filters" aria-expanded={filtersExpanded} aria-controls="ugc-platforms ugc-filters" onClick={() => setFiltersExpanded((value) => !value)}>{filtersExpanded ? 'Close filters' : `Filters${platform !== 'all' || stage || product ? ' · active' : ''}`}</button><label className="ugc-inactive-filter"><input type="checkbox" checked={inactive} onChange={(event) => { setInactive(event.target.checked); setSelectedId(null); if (event.target.checked) setStage(''); }} /><span>Inactive</span></label><ProfileRefresh onSaved={load} /><BrowserQueueButton /></div>
        </div>

        <div id="ugc-filters" className="ugc-filters grid gap-2">
          <label className="dx-keep-flex min-h-11 px-3 flex items-center gap-2" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
            <Search className="h-4 w-4" style={{ color: 'var(--fg-3)' }} />
            <input aria-label="Search creators" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search creators…" className="w-full bg-transparent outline-none" />
          </label>
          <select className="ugc-network-select min-h-11 px-3" aria-label="Social network" value={platform} onChange={(event) => setPlatform(event.target.value)} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{PLATFORM_TABS.map((key) => <option key={key} value={key}>{key === 'all' ? 'All social networks' : key.charAt(0).toUpperCase() + key.slice(1)}</option>)}</select>
          <select aria-label="Filter by collaboration stage" value={stage} onChange={(event) => setStage(event.target.value)} className="min-h-11 px-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}><option value="">All stages</option><option value="archived">Архив</option>{STAGES.map((value) => <option key={value} value={value}>{value}</option>)}</select>
          <select aria-label="Filter by product" value={product} onChange={(event) => setProduct(event.target.value)} className="min-h-11 px-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}><option value="">All products</option>{data.products.map((item) => <option key={item.sku} value={item.sku}>{compactProductCode(item.sku)} · {item.content_count}</option>)}</select>
          <label className="dx-keep-flex min-h-11 px-3 flex items-center gap-2" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}><ArrowUpDown className="h-4 w-4" /><select aria-label="Sort creators" value={sort} onChange={(event) => setSort(event.target.value)} className="w-full bg-transparent outline-none"><option value="recent">Recent activity</option><option value="followers">Followers</option><option value="views">Views</option><option value="stage">Stage</option><option value="attention">Требуют проверки</option></select></label>
        </div>
      </section>


      <section className="ugc-table-shell" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-card)' }}>
        <div className="ugc-mobile-list">
          <div className="ugc-mobile-row ugc-mobile-head" aria-hidden="true"><span>Автор</span><span>Подп.</span><span>Оплата</span></div>
          {loading ? <p className="p-3">Загрузка…</p> : creators.length === 0 ? <p className="p-3">Никого не найдено.</p> : creators.map((creator) => {
            const profile = primaryProfile(creator, platform);
            const name = profile.handle ? `@${profile.handle}` : creator.display_name || 'Автор';
            return <div key={creator.id} className={`ugc-mobile-row ugc-creator-row${unavailableInstagram(profile) ? ' ugc-creator-row-unavailable' : ''}`} tabIndex={0} aria-label={`Карточка блогера ${name}`} onClick={(event) => { if (blankRowClick(event)) { event.preventDefault(); setSelectedId(creator.id); } }} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setSelectedId(creator.id); } }}>
              <span className="ugc-mobile-identity"><BloggerAvatar profile={profile} compact /><span className="ugc-mobile-profile-copy"><a href={profileHref(profile) ?? undefined} target="_blank" rel="noopener noreferrer" className="ugc-mobile-title" title={creator.display_name ? `${name} · ${creator.display_name}` : name}>{name}</a><ProfileAvailability profile={profile} /></span></span>
              <span title={`Подписчики: ${profile.followers ?? 'нет данных'}`}>{formatCountShort(profile.followers)}</span>
              <span className="ugc-mobile-pay"><CreatorPayment creator={creator} /></span>
            </div>;
          })}
        </div>
        <table ref={tableRef} className="ugc-table dx-keep-table w-full text-sm">
          <thead><tr className="border-b border-stone-200 bg-stone-50">
            <th scope="col" className="ugc-c-creator">Автор</th>
            <th scope="col" className="ugc-c-platform">Сеть</th>
            <th scope="col" className="ugc-c-num ugc-c-followers" title="Подписчики">Followers</th>
            <th scope="col" className="ugc-c-num ugc-c-activity" title="Дата последнего контакта с блогером: сообщение, выплата или публикация">Контакт</th>
            <th scope="col" className="ugc-c-num ugc-c-pay">Оплата</th>
            <th scope="col" className="ugc-c-product ugc-sec-2">Продукт</th>
            <th scope="col" className="ugc-c-media ugc-sec-3">Контент</th>
            <th scope="col" className="ugc-c-next ugc-sec-1">Статус</th>
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={8} className="p-10 text-center"><Loader2 className="h-6 w-6 animate-spin inline-block" /> <span className="ml-2">Загрузка…</span></td></tr> : creators.length === 0 ? <tr><td colSpan={8} className="p-10 text-center" style={{ color: 'var(--fg-2)' }}><Users className="h-7 w-7 mx-auto mb-2" />Никого не найдено.</td></tr> : creators.map((creator) => {
              const profile = primaryProfile(creator, platform);
              const linked = linkedContent(profile);
              const products = Array.from(new Map([...profile.content.flatMap((item) => item.products), ...(profile.source_products ?? [])].map((item) => [item.sku, item])).values());
              const handle = profile.handle ? `@${profile.handle}` : null;
              const name = handle ?? creator.display_name ?? 'Автор';
              // Name and city after the handle (Owner 2026-10-16: «Город нужен, город обязательно»).
              const secondName = handle ? [creator.display_name, creator.city].filter(Boolean).join(' · ') || null : null;
              return <tr key={creator.id} className={`ugc-creator-row${unavailableInstagram(profile) ? ' ugc-creator-row-unavailable' : ''}`} tabIndex={0} aria-label={`Карточка блогера ${name}`} onClick={(event) => { if (blankRowClick(event)) { event.preventDefault(); setSelectedId(creator.id); } }} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setSelectedId(creator.id); } }} style={{ borderTop: '1px solid var(--border-hairline)' }}>
                <td className="ugc-c-creator" style={creator.attention ? { position: 'relative', paddingRight: 50 } : undefined}>{creator.attention ? <span className="absolute right-1 top-1/2 -translate-y-1/2"><AttentionMark attention={creator.attention} name={name} onOpen={() => setSelectedId(creator.id)} /></span> : null}<a href={profileHref(profile) ?? undefined} target="_blank" rel="noopener noreferrer" title={[name, secondName, 'открыть страницу автора'].filter(Boolean).join(' · ')} className="ugc-creator min-h-11 text-left rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"><BloggerAvatar profile={profile} compact /><span className="ugc-creator-copy"><span className="ugc-creator-line"><span className="ugc-creator-name">{name}</span><OriginMark origin={creator.origin} /></span>{secondName ? <span className="ugc-creator-handle">{secondName}</span> : null}<span className="ugc-creator-platform"><PlatformIcons creator={creator} /></span><ProfileAvailability profile={profile} /></span></a></td>
                <td className="ugc-c-platform"><PlatformIcons creator={creator} chat /></td>
                <td className="ugc-c-num" title={profile.followers == null ? 'Нет данных' : `${profile.followers}`}>{formatCount(profile.followers)}</td>
                <td className="ugc-c-num" title={creator.last_activity_at ? new Date(creator.last_activity_at).toLocaleString('ru-RU', { timeZone: 'Asia/Yerevan', dateStyle: 'short', timeStyle: 'short' }) : 'Нет данных'}>{formatActivity(creator.last_activity_at)}</td>
                <td className="ugc-c-num ugc-c-pay"><CreatorPayment creator={creator} /></td>
                <td className="ugc-c-product ugc-sec-2">{products.length || profile.source_product_labels?.length ? <div className="ugc-pills" title={[...products.map((item) => `${compactProductCode(item.sku)} · ${item.name}${item.source === 'blogger_database' ? ' · база блогеров' : ''}`), ...(profile.source_product_labels ?? []).map((item) => `${item.name} · название из базы, тип не указан`)].join('\n')}>{products.slice(0, PRODUCT_PILLS).map((item) => <span key={`${item.sku}-${item.raw_offer_id}`} className="ugc-pill">{compactProductCode(item.sku)}</span>)}{profile.source_product_labels?.map((item) => <span key={item.name} className="ugc-pill">{item.name}</span>)}</div> : creator.payout?.product ? <div className="ugc-pills" title={`Из выплаты: ${creator.payout.product}`}>{creator.payout.product.split('+').map((part) => part.trim()).filter(Boolean).slice(0, PRODUCT_PILLS).map((part) => <span key={part} className="ugc-pill">{part}</span>)}</div> : <span className="ugc-muted">{profile.content.some((item) => item.product_status === 'queued') ? 'В очереди' : 'Не определён'}</span>}</td>
                <td className="ugc-c-media ugc-sec-3" aria-label={`${profile.content_count} публикаций`}>{linked.length ? <div className="ugc-media">{linked.slice(0, CONTENT_ICONS).map(({ item, href }, index) => <Publication key={item.id} item={item} href={href} more={index === CONTENT_ICONS - 1 ? linked.length - CONTENT_ICONS : 0} />)}</div> : <span className="ugc-muted">—</span>}</td>
                <td className="ugc-c-next ugc-sec-1" title={creator.collaboration?.next_action || undefined}><CreatorStatus creator={creator} /></td>
              </tr>;
            })}
          </tbody>
        </table>
      </section>

      {selected && <CreatorModal key={selected.id} creator={selected} onClose={() => setSelectedId(null)} onSaved={load} />}
    </div>
    </PayContext.Provider>
  );
}

function CreatorPanel({ creator, onClose, onSaved }: { creator: Creator; onClose: () => void; onSaved: () => Promise<void> }) {
  const collaboration = creator.collaboration ?? {};
  const [stage, setStage] = useState(creator.lifecycle_stage);
  const [origin, setOrigin] = useState<string>(creator.origin ?? '');
  const [owner, setOwner] = useState(creator.owner ?? '');
  const [notes, setNotes] = useState(creator.notes ?? '');
  const [channel, setChannel] = useState(collaboration.contact_channel ?? '');
  const [nextAction, setNextAction] = useState(collaboration.next_action ?? '');
  const [nextActionAt, setNextActionAt] = useState(collaboration.next_action_at ?? '');
  const [sampleStatus, setSampleStatus] = useState(collaboration.sample_status ?? '');
  const [deliverables, setDeliverables] = useState(collaboration.deliverables ?? '');
  const [rights, setRights] = useState(collaboration.rights_scope ?? '');
  const [rightsExpiry, setRightsExpiry] = useState(collaboration.rights_expires_at ?? '');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const content = creator.profiles.flatMap((profile) => profile.content.map((item) => ({ ...item, platform: profile.platform })));

  async function save() {
    setSaving(true); setMessage(null);
    const creatorResult = await apiPatch(`/api/ugc/creators/${creator.id}`, { lifecycle_stage: stage, origin: origin || null, owner, notes });
    const collabResult = await apiPost('/api/ugc/collaborations', { id: collaboration.id, creator_id: creator.id, platform: creator.profiles[0]?.platform, status: stage, contact_channel: channel, next_action: nextAction, next_action_at: nextActionAt, sample_status: sampleStatus, deliverables, rights_scope: rights, rights_expires_at: rightsExpiry });
    if (!creatorResult.success || !collabResult.success) setMessage(creatorResult.errors[0]?.message ?? collabResult.errors[0]?.message ?? 'Не удалось сохранить');
    else { setMessage('Сохранено'); await onSaved(); }
    setSaving(false);
  }

  async function toggleArchive() {
    setSaving(true); setMessage(null);
    try {
      const result = await apiPatch(`/api/ugc/creators/${creator.id}`, { archived: !creator.archived_at });
      if (!result.success) setMessage(result.errors[0]?.message ?? 'Не удалось изменить архив');
      else { await onSaved(); onClose(); }
    } catch { setMessage('Не удалось изменить архив. Повторите попытку.'); }
    finally { setSaving(false); }
  }

  const lead = creator.profiles[0];
  const sub = [creator.display_name && lead && creator.display_name !== `@${lead.handle}` ? creator.display_name : null, creator.city, lead ? platformLabel(lead.platform) : null].filter(Boolean).join(' · ');
  const leadHref = lead ? profileHref(lead) : null;
  const products = Array.from(new Map(creator.profiles.flatMap((profile) => [...profile.content.flatMap((item) => item.products), ...(profile.source_products ?? [])]).map((item) => [item.sku, item])).values());
  const productLabels = creator.profiles.flatMap((profile) => profile.source_product_labels ?? []);
  const shortDate = (value?: string | number | null) => value ? new Date(value).toLocaleDateString('ru-RU', { timeZone: 'Asia/Yerevan', day: '2-digit', month: '2-digit' }) : '—';
  // Owner 2026-10-17: one column top to bottom — who, audience, work, payment, products, publications; the edit form opens on demand.
  return <section className="ugc-creator-card ugc-card p-4 md:p-6" style={{ background: 'var(--bg-surface)', border: '2px solid var(--brand-schwarz)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-raised)' }}>
    <div className="ugc-card-top">{lead ? <BloggerAvatar profile={lead} /> : null}<div className="ugc-card-who"><h2 id="ugc-creator-title">{lead ? `@${lead.handle}` : creator.display_name || 'Автор'}</h2>{sub ? <span>{sub}</span> : null}</div><button type="button" onClick={onClose} className="min-h-11 min-w-11 flex items-center justify-center" aria-label="Закрыть карточку блогера"><X className="h-5 w-5" /></button></div>
    {creator.attention ? <p className="ugc-card-attention"><AlertCircle className="h-5 w-5 shrink-0" style={{ color: '#7a4e25' }} /><span><strong>{creator.attention.label}.</strong> {creator.attention.reason}</span></p> : null}
    {creator.attention?.code === 'photo_for_owner' ? <PhotoNote creatorId={creator.id} onSaved={onSaved} /> : creator.attention?.kind === 'business' ? <DecisionNote creatorId={creator.id} onSaved={onSaved} /> : null}
    <section className="ugc-card-sec"><div className="ugc-card-label">Аудитория</div>{creator.profiles.map((profile) => <BloggerProfile key={profile.id} profile={profile} onSaved={onSaved} showHandle={creator.profiles.length > 1} />)}</section>
    <div className="ugc-card-line"><span>Последний контакт</span><span>{shortDate(creator.last_activity_at)}</span></div>
    <section className="ugc-card-sec" aria-labelledby={`payouts-${creator.id}`}><div id={`payouts-${creator.id}`} className="ugc-card-label">Оплата</div>
      {creator.payouts?.length ? creator.payouts.map((item) => <div key={item.id} className="ugc-card-pay"><PayoutBadge payout={item} /><span>{item.status === 'awaiting_approval' || item.status === 'approved' ? 'В очереди' : item.payout_date}</span></div>) : <p className="ugc-card-empty">Выплат пока нет.</p>}
      <div className="ugc-card-line"><span>Всего выплачено</span><strong>{formatRub(creator.paid_total_minor ?? 0)}</strong></div>
    </section>
    {creator.payment_sources?.length ? <details className="ugc-card-sec">
      <summary className="ugc-card-label cursor-pointer">Исторические суммы</summary>
      <p className="text-sm" style={{ color: 'var(--fg-2)' }}>Общий итог строк внутри каждого источника, включая повторы. Исполнение переводов по этим записям не подтверждено.</p>
      {creator.payment_sources.map((source, index) => <div key={source.source_document} className="space-y-2">
        <h4 className="font-bold">{source.source_title}</h4><RegisterAmounts records={source.records} />
        {index > 0 ? <p className="text-sm" style={{ color: 'var(--fg-2)' }}>Отдельный источник, в основной итог не прибавляется.</p> : null}
        <details><summary className="cursor-pointer">Строки источника ({source.records.length})</summary>
          <ul>{source.records.map((row) => <li key={`${row.source_document}-${row.source_row}`}><a className="underline" target="_blank" rel="noopener noreferrer" href={`https://docs.google.com/spreadsheets/d/${row.source_document}/edit#gid=0&range=${row.amount_column ?? 'H'}${row.source_row}`}>Строка {row.source_row}: {formatRub(row.amount_minor)}</a></li>)}</ul>
        </details>
      </div>)}
    </details> : null}
    <section className="ugc-card-sec"><div className="ugc-card-label">Продукты</div>{products.length || productLabels.length ? <div className="ugc-pills">{products.map((item) => <span key={item.sku} className="ugc-pill" title={item.name}>{compactProductCode(item.sku)}</span>)}{productLabels.map((item) => <span key={item.name} className="ugc-pill">{item.name}</span>)}</div> : <p className="ugc-card-empty">Не определён.</p>}</section>
    <section className="ugc-card-sec" aria-labelledby={`content-history-${creator.id}`}><div id={`content-history-${creator.id}`} className="ugc-card-label">Публикации · {content.length}</div>
      {content.length ? content.map((item) => {
        const href = contentHref(item.content_url);
        const label = [item.content_type || platformLabel(item.platform), item.published_at ? shortDate(item.published_at) : null].filter(Boolean).join(' · ');
        const what = item.product_codes.length ? item.product_codes.map(compactProductCode).join(', ') : item.product_labels?.length ? item.product_labels.map((product) => product.name).join(', ') : 'Продукт не определён';
        return <div key={item.id} className="ugc-card-pub"><div className="ugc-card-pub-copy"><strong>{label}</strong><span>{what}</span>{href ? <LinkHealth item={item} /> : null}</div><span className="ugc-card-pub-views" title="Просмотры">{formatCount(item.views)}</span>{href ? <a href={href} target="_blank" rel="noopener noreferrer" className="min-h-11 min-w-11 inline-flex items-center justify-center" aria-label="Открыть публикацию"><ExternalLink className="h-4 w-4" /></a> : null}</div>;
      }) : <p className="ugc-card-empty">Публикаций пока нет.</p>}
    </section>
    <div className="ugc-card-actions"><button type="button" onClick={() => setEditing((value) => !value)} aria-expanded={editing}>{editing ? 'Скрыть поля' : 'Изменить данные'}</button>{leadHref ? <a href={leadHref} target="_blank" rel="noopener noreferrer">Открыть профиль <ExternalLink className="h-4 w-4" aria-hidden="true" /></a> : null}</div>
    {editing ? <div className="ugc-card-edit space-y-4">
    <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
      <Field label="Статус"><select value={stage} onChange={(event) => setStage(event.target.value)}><option value="">— без статуса</option>{STAGES.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
      <Field label="Откуда"><select value={origin} onChange={(event) => setOrigin(event.target.value)}><option value="">—</option>{ORIGINS.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
      <Field label="Ответственный"><input value={owner} onChange={(event) => setOwner(event.target.value)} /></Field>
      <Field label="Канал связи"><input value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="Shopee, TikTok Shop, Zalo…" /></Field>
      <Field label="Образец"><input value={sampleStatus} onChange={(event) => setSampleStatus(event.target.value)} /></Field>
      <Field label="Следующий шаг"><input value={nextAction} onChange={(event) => setNextAction(event.target.value)} /></Field>
      <Field label="Срок шага"><input type="date" value={nextActionAt} onChange={(event) => setNextActionAt(event.target.value)} /></Field>
      <Field label="Права до"><input type="date" value={rightsExpiry} onChange={(event) => setRightsExpiry(event.target.value)} /></Field>
      <Field label="Что сдаёт"><input value={deliverables} onChange={(event) => setDeliverables(event.target.value)} placeholder="1 Shopee Video…" /></Field>
    </div>
    <div className="grid md:grid-cols-2 gap-4"><Field label="Права"><textarea value={rights} onChange={(event) => setRights(event.target.value)} rows={3} /></Field><Field label="Заметки"><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} /></Field></div>
    <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={saving} onClick={save} className="min-h-11 px-5 font-bold flex items-center gap-2 transition-transform hover:-translate-y-0.5 disabled:transform-none disabled:opacity-60" style={{ color: 'var(--fg-on-brand)', background: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-raised)' }}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}Сохранить</button><button type="button" disabled={saving} onClick={toggleArchive} className="ugc-profile-refresh-btn">{creator.archived_at ? 'Вернуть в активные' : 'Убрать из активных'}</button>{message && <span role="status" aria-live="polite" className="text-sm" style={{ color: message === 'Сохранено' ? 'var(--status-success)' : 'var(--status-error)' }}>{message}</span>}</div>
    </div> : null}
  </section>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="space-y-2"><span className="block text-sm font-bold" style={{ color: 'var(--fg-2)' }}>{label}</span><span className="block [&>input]:w-full [&>input]:min-h-11 [&>input]:px-3 [&>select]:w-full [&>select]:min-h-11 [&>select]:px-3 [&>textarea]:w-full [&>textarea]:p-3 [&>*]:bg-transparent [&>*]:outline-none" style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{children}</span></label>;
}
