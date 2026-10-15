'use client';

import { ChangeEvent, createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpDown, ExternalLink, Eye, Facebook, FileSpreadsheet, FileText, Globe, Hand, Heart, ImageIcon, Instagram, Link, Link2Off, Loader2, MessageCircle, Search, Send, SquarePlay, Users, Video, X, Youtube } from 'lucide-react';
import './ugc-layout.css';
import PageHeader from '@/components/ui/page-header';
import { apiGet, apiPatch, apiPost, apiPostTimed } from '@/lib/api';
import { parseUgcWorkbook } from '@/lib/ugc-import';
import { canPay, formatRub, PAYOUT_STATUS_LABEL, payoutCell } from '@/lib/ugc-payout-cell.mjs';
import { getUser } from '@/lib/auth';
import { formatActivity, formatCount, formatRate, platformLabel } from '@/lib/ugc-table-format.mjs';

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
  metrics_as_of: string | null;
};

type ContentObservation = {
  id: string;
  content_url: string | null;
  content_type: string | null;
  published_at: string | null;
  views: number | null;
  likes?: number | null;
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
};

type PaidCount = { count: number; minor: number; day: string };

type Creator = {
  id: string;
  normalized_handle: string;
  display_name: string | null;
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
  payouts?: Payout[];
  paid_total_minor?: number;
  last_activity_at?: number | null;
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
  payout_summary?: { paid_konsol?: { today: PaidCount; yesterday: PaidCount } };
  summary: { creators: number; profiles: number; content_items: number; active_outreach: number; published: number } & LinkSummary;
  platforms: { platform: string; creator_count: number }[];
  products: { sku: string; name: string; content_count: number }[];
};

const PLATFORM_TABS = ['all', 'instagram', 'tiktok', 'vk', 'shopee', 'lazada', 'facebook', 'telegram', 'youtube', 'other'];
// Diana's statuses (Owner 2026-10-15, DH-LAW-261015-02): one English word, at most 7 letters.
const STAGES = ['new', 'sent', 'replied', 'agreed', 'cart', 'payout', 'paid', 'ordered', 'review', 'posted', 'gold', 'silent', 'failed', 'fee', 'refused', 'unfit', 'rival', 'owner'];
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
    {badge}
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

function PlatformIcon({ platform }: { platform: string }) {
  const key = String(platform ?? '').toLowerCase();
  const label = platformLabel(key);
  const glyph = key === 'instagram' ? <Instagram className="h-[18px] w-[18px]" aria-hidden="true" />
    : key === 'youtube' ? <Youtube className="h-[18px] w-[18px]" aria-hidden="true" />
    : key === 'facebook' ? <Facebook className="h-[18px] w-[18px]" aria-hidden="true" />
    : key === 'telegram' ? <Send className="h-[18px] w-[18px]" aria-hidden="true" />
    : key === 'tiktok' ? <svg viewBox="0 0 24 24" className="h-[16px] w-[16px]" aria-hidden="true"><path fill="currentColor" d={TIKTOK_PATH} /></svg>
    : LETTER_MARK[key] ? <span className="ugc-letter-mark" aria-hidden="true">{LETTER_MARK[key]}</span>
    : <Globe className="h-[18px] w-[18px]" aria-hidden="true" />;
  return <span className="ugc-platform-icon" role="img" aria-label={label} title={label}>{glyph}</span>;
}

function PlatformIcons({ creator }: { creator: Creator }) {
  const platforms = Array.from(new Set(creator.profiles.map((profile) => String(profile.platform ?? '').toLowerCase()).filter(Boolean)));
  if (!platforms.length) return <span className="ugc-muted">—</span>;
  return <span className="ugc-platforms-cell">{platforms.map((platform) => <PlatformIcon key={platform} platform={platform} />)}</span>;
}

const LINK_STATUS_LABEL: Record<LinkStatus, string> = { active: 'Active', missing: 'Missing', restricted: 'Restricted', unknown: 'Unknown', invalid: 'Invalid' };
// Table cells speak Russian, like the column heads (Owner 2026-10-14).
const LINK_STATUS_SHORT: Record<LinkStatus, string> = { active: 'Доступна', missing: 'Удалена', restricted: 'Закрыта', unknown: 'Не ясно', invalid: 'Ошибка' };
const MEDIA_LABEL: Record<ReturnType<typeof mediaKind>, string> = { Video: 'видео', Image: 'фото', Post: 'пост', Content: 'ссылка' };
const PRODUCT_PILLS = 2;
// «Контент» (Owner 2026-10-16): per publication, its link icon as tall as the three
// figures stacked right of it (views, likes, comments); a dead link is faded.
// Two publications side by side, then «+N».
const CONTENT_ICONS = 2;
const DEAD_LINK: ReadonlySet<LinkStatus> = new Set<LinkStatus>(['missing', 'restricted', 'invalid']);

function Publication({ item, href, more }: { item: ContentObservation; href: string; more: number }) {
  const kind = mediaKind(item);
  const status = item.link_status ? LINK_STATUS_SHORT[item.link_status] : 'Не проверена';
  const state = item.link_status === 'active' ? 'live' : item.link_status && DEAD_LINK.has(item.link_status) ? 'dead' : 'unknown';
  const Glyph = kind === 'Video' ? SquarePlay : kind === 'Image' ? ImageIcon : kind === 'Post' ? FileText : Link;
  const figure = (label: string, value: number | null | undefined) => `${label}: ${value == null ? 'нет данных' : value}`;
  return <span className="ugc-pub" data-state={state}>
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} className="ugc-pub-link focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={`${MEDIA_LABEL[kind]} · ${status}`} title={[MEDIA_LABEL[kind], status, item.link_checked_at ? new Date(item.link_checked_at).toLocaleDateString('ru-RU') : null, item.content_url].filter(Boolean).join(' · ')}><Glyph aria-hidden="true" /></a>
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
  if (item.products.length) return <div className="flex flex-nowrap items-center gap-2">{item.products.map((product) => <span key={`${product.sku}-${product.raw_offer_id}`} title={`${product.name} · ${product.raw_offer_id} · ${product.source} · confidence ${product.confidence}`} className="px-2 py-1 text-xs font-bold" style={{ color: 'var(--brand-schwarz)', background: 'var(--brand-gold)', borderRadius: 'var(--radius-pill)' }}>{compactProductCode(product.sku)}</span>)}<span className="text-xs" style={{ color: 'var(--status-success)' }}>Confirmed from explicit product field</span></div>;
  if (item.unknown_product_codes.length) return <div className="text-xs" style={{ color: 'var(--status-warning)' }}>Unknown product code: {item.unknown_product_codes.join(', ')} · needs review</div>;
  if (item.product_status === 'queued') return <div className="text-xs" style={{ color: 'var(--fg-3)' }}>Product identification queued · no explicit product evidence</div>;
  return <div className="text-xs" style={{ color: 'var(--fg-3)' }}>Product unknown</div>;
}

// «Оплачено сегодня / вчера» (Owner 2026-10-15): only payouts executed in Konsol.
/** The cached copy keeps only what the table shows: no phone mask, no bank ids. */
function cacheSafe(payload: UgcPayload): UgcPayload {
  const strip = (p: Payout): Payout => ({ ...p, phone_masked: null, fps_bank_member_id: null, bank_ref: null });
  return { ...payload, creators: payload.creators.map((c) => ({ ...c, payout: c.payout ? strip(c.payout) : c.payout, payouts: c.payouts?.map(strip) })) };
}

function PaidCounter({ paid }: { paid?: { today: PaidCount; yesterday: PaidCount } }) {
  if (!paid) return null;
  const part = (label: string, p: PaidCount) => <span>{label}: <b>{p.count}</b> на <b>{formatRub(p.minor) || '0 ₽'}</b></span>;
  return <div className="ugc-paid-counter" title="Только выплаты, исполненные в Консоли">Оплачено блогерам · {part('сегодня', paid.today)} · {part('вчера', paid.yesterday)}</div>;
}

function Kpi({ label, value, exact, note, accent }: { label: string; value: string; exact: string; note: string; accent: string }) {
  return (
    <div className="px-4 py-3" title={exact} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', borderTop: `4px solid ${accent}`, borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-raised)' }}>
      <div className="dx-eyebrow" style={{ color: 'var(--fg-3)' }}>{label}</div>
      <div className="mt-1" style={{ fontFamily: 'var(--font-display)', fontSize: '28px', fontWeight: 900, lineHeight: 1 }}>{value}</div>
      <div className="mt-1 text-xs" style={{ color: 'var(--fg-2)' }}>{note}</div>
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
  const [product, setProduct] = useState('');
  const [sort, setSort] = useState('recent');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [checkingLinks, setCheckingLinks] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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
    const key = `ugc-cache:v2:${getUser()?.id ?? 'anon'}:${params.toString()}`;
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
  }, [platform, search, stage, product]);

  useEffect(() => {
    const timer = window.setTimeout(load, 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!urlStateReady.current) return;
    const params = new URLSearchParams(window.location.search);
    if (platform === 'all') params.delete('platform'); else params.set('platform', platform);
    if (search.trim()) params.set('search', search.trim()); else params.delete('search');
    if (stage) params.set('stage', stage); else params.delete('stage');
    if (product) params.set('product', product); else params.delete('product');
    if (sort === 'recent') params.delete('sort'); else params.set('sort', sort);
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, [platform, search, stage, product, sort]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlPlatform = params.get('platform');
    const urlSort = params.get('sort');
    if (urlPlatform && PLATFORM_TABS.includes(urlPlatform)) setPlatform(urlPlatform);
    if (urlSort && ['recent', 'followers', 'views', 'engagement', 'stage'].includes(urlSort)) setSort(urlSort);
    setSearch(params.get('search') ?? '');
    setStage(params.get('stage') ?? '');
    setProduct(params.get('product') ?? '');
    urlStateReady.current = true;
  }, []);

  const creators = useMemo(() => {
    const rows = [...data.creators];
    rows.sort((a, b) => {
      const ap = primaryProfile(a, platform);
      const bp = primaryProfile(b, platform);
      if (sort === 'views') return (bp.avg_video_views ?? bp.latest_observed_views ?? -1) - (ap.avg_video_views ?? ap.latest_observed_views ?? -1);
      if (sort === 'engagement') return (bp.engagement_rate ?? -1) - (ap.engagement_rate ?? -1);
      if (sort === 'stage') return a.lifecycle_stage.localeCompare(b.lifecycle_stage);
      if (sort === 'recent') return ((b.last_activity_at ?? -1) - (a.last_activity_at ?? -1)) || ((bp.followers ?? -1) - (ap.followers ?? -1));
      return (bp.followers ?? -1) - (ap.followers ?? -1);
    });
    return rows;
  }, [data.creators, platform, sort]);
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
    const ers = profiles.map((item) => item.engagement_rate).filter((value): value is number => value != null);
    return { followers, avgViews: views.length ? views.reduce((a, b) => a + b, 0) / views.length : null, avgEr: ers.length ? ers.reduce((a, b) => a + b, 0) / ers.length : null };
  }, [data.creators]);

  async function onImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    setImporting('Reading workbook…');
    try {
      const rows = await parseUgcWorkbook(await file.arrayBuffer(), file.name);
      let accepted = 0;
      for (let offset = 0; offset < rows.length; offset += 25) {
        setImporting(`Importing ${Math.min(offset + 25, rows.length)} of ${rows.length} rows…`);
        const response = await apiPost<{ accepted: number }>('/api/ugc/import', { rows: rows.slice(offset, offset + 25) });
        if (!response.success) throw new Error(response.errors[0]?.message ?? 'Import failed');
        accepted += response.result?.accepted ?? 0;
      }
      setImporting(`${accepted} rows imported`);
      await load();
      window.setTimeout(() => setImporting(null), 3000);
    } catch (reason) {
      setImporting(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function checkLinks() {
    setCheckingLinks(true);
    setCheckMessage(null);
    const response = await apiPost<{ checked: number }>('/api/ugc/link-health/run', { limit: 5 });
    if (!response.success) setCheckMessage(response.errors[0]?.message ?? 'Link check failed');
    else {
      setCheckMessage(`${response.result?.checked ?? 0} links checked`);
      await load();
    }
    setCheckingLinks(false);
  }

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
    <div className="ugc-page p-5 md:p-8 space-y-7">
      <div className="ugc-heading"><PageHeader
        eyebrow="Creator operations"
        title="UGC"
        subtitle="Creators, platform evidence, outreach, samples, content and usage rights in one operating view."
        actions={(
          <>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onImport} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={Boolean(importing)} className="ugc-import min-h-11 px-1 flex items-center font-bold transition-transform hover:-translate-y-0.5 disabled:transform-none disabled:opacity-60">
              <span className="px-2.5 py-1.5 inline-flex items-center gap-2" style={{ color: 'var(--fg-on-brand)', background: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-raised)' }}>{importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}{importing ?? 'Import XLSX'}</span>
            </button>
          </>
        )}
      /></div>

      {error && <div role="alert" className="p-4 flex items-start justify-between gap-4" style={{ background: 'var(--paper-sunk)', borderLeft: '4px solid var(--status-error)' }}><span>{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError(null)} className="min-h-11 flex items-center justify-center" style={{ minWidth: '44px' }}><X className="h-5 w-5" /></button></div>}
      <div role="status" aria-live="polite" className="sr-only">{importing}</div>

      <section className="ugc-kpis grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
        <Kpi label="Creators" value={formatNumber(data.summary.creators)} exact={`${data.summary.creators} creators`} note="in this view" accent="var(--brand-schwarz)" />
        <Kpi label="Followers" value={formatNumber(headline.followers)} exact={`${headline.followers} followers`} note="known audience" accent="var(--brand-rot)" />
        <Kpi label="Avg views" value={formatNumber(headline.avgViews)} exact={headline.avgViews == null ? 'Unknown' : `${headline.avgViews} average views`} note="per known profile" accent="var(--status-info)" />
        <Kpi label="Engagement" value={headline.avgEr == null ? '—' : `${formatNumber(headline.avgEr)}%`} exact={headline.avgEr == null ? 'Unknown' : `${headline.avgEr}% average engagement`} note="known profiles" accent="var(--status-success)" />
        <Kpi label="Publications" value={formatNumber(data.summary.content_items)} exact={`${data.summary.content_items} publications`} note="observed content" accent="var(--brand-schwarz)" />
        <Kpi label="Products" value={formatNumber(data.products.length)} exact={`${data.products.length} identified product families`} note={`${formatNumber(data.summary.product_queued)} queued`} accent="var(--brand-gold)" />
      </section>
      <PaidCounter paid={data.payout_summary?.paid_konsol} />

      <section aria-label="Content link health" className="ugc-health p-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
        <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 900 }}>Link health</strong>
        <span style={{ color: 'var(--status-success)' }}>● {formatNumber(data.summary.links_active)} active</span>
        <span style={{ color: 'var(--status-error)' }}>● {formatNumber(data.summary.links_missing)} missing</span>
        <span style={{ color: 'var(--status-warning)' }}>● {formatNumber(data.summary.links_restricted)} restricted</span>
        <span style={{ color: 'var(--status-warning)' }}>● {formatNumber(data.summary.links_unknown)} unknown</span>
        <span style={{ color: 'var(--status-error)' }}>● {formatNumber(data.summary.links_invalid)} invalid</span>
        <span style={{ color: 'var(--fg-3)' }}>{formatNumber(data.summary.links_unchecked)} not checked</span>
        <span className="ml-auto" style={{ color: 'var(--fg-3)' }}>Last check: {formatCheckedAt(data.summary.links_last_checked_at)} · {formatNumber(data.summary.link_check_history)} audits</span>
        <button type="button" onClick={checkLinks} disabled={checkingLinks} className="min-h-11 px-1 inline-flex items-center font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"><span className="px-2.5 py-1 inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--fg-on-brand)', background: 'var(--brand-schwarz)', borderRadius: 'var(--radius-sm)' }}>{checkingLinks && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{checkingLinks ? 'Checking…' : 'Check 5 now'}</span></button>
        {checkMessage && <span role="status" aria-live="polite" className="text-xs" style={{ color: checkMessage.includes('checked') ? 'var(--status-success)' : 'var(--status-error)' }}>{checkMessage}</span>}
      </section>

      <section className="ugc-controls space-y-4" data-expanded={filtersExpanded}>
        <div className="ugc-mobile-controls"><h2>UGC</h2><span>{formatNumber(data.summary.creators)} creators</span><button type="button" aria-expanded={filtersExpanded} aria-controls="ugc-platforms ugc-filters" onClick={() => setFiltersExpanded((value) => !value)}>{filtersExpanded ? 'Close filters' : `Filters${platform !== 'all' || stage || product ? ' · active' : ''}`}</button></div>
        <div id="ugc-platforms" className="ugc-platforms flex flex-wrap gap-2 pb-1" aria-label="Platforms">
          {PLATFORM_TABS.map((key) => {
            const count = key === 'all' ? data.summary.creators : data.platforms.find((item) => item.platform === key)?.creator_count;
            return <button key={key} type="button" aria-pressed={platform === key} onClick={() => setPlatform(key)} className="min-h-11 shrink-0 px-1 flex items-center font-bold capitalize focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"><span className="px-2.5 py-1" style={{ color: platform === key ? 'var(--fg-on-brand)' : 'var(--fg-1)', background: platform === key ? 'var(--brand-schwarz)' : 'var(--paper-sunk)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-pill)' }}>{key} {count != null ? `· ${count}` : ''}</span></button>;
          })}
        </div>

        <div id="ugc-filters" className="ugc-filters grid gap-2">
          <label className="dx-keep-flex min-h-11 px-3 flex items-center gap-2" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
            <Search className="h-4 w-4" style={{ color: 'var(--fg-3)' }} />
            <input aria-label="Search creators" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search creators…" className="w-full bg-transparent outline-none" />
          </label>
          <select className="ugc-network-select min-h-11 px-3" aria-label="Social network" value={platform} onChange={(event) => setPlatform(event.target.value)} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{PLATFORM_TABS.map((key) => <option key={key} value={key}>{key === 'all' ? 'All social networks' : key.charAt(0).toUpperCase() + key.slice(1)}</option>)}</select>
          <select aria-label="Filter by collaboration stage" value={stage} onChange={(event) => setStage(event.target.value)} className="min-h-11 px-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}><option value="">All stages</option>{STAGES.map((value) => <option key={value} value={value}>{value}</option>)}</select>
          <select aria-label="Filter by product" value={product} onChange={(event) => setProduct(event.target.value)} className="min-h-11 px-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}><option value="">All products</option>{data.products.map((item) => <option key={item.sku} value={item.sku}>{compactProductCode(item.sku)} · {item.content_count}</option>)}</select>
          <label className="dx-keep-flex min-h-11 px-3 flex items-center gap-2" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}><ArrowUpDown className="h-4 w-4" /><select aria-label="Sort creators" value={sort} onChange={(event) => setSort(event.target.value)} className="w-full bg-transparent outline-none"><option value="recent">Recent activity</option><option value="followers">Followers</option><option value="views">Views</option><option value="engagement">Engagement</option><option value="stage">Stage</option></select></label>
        </div>
      </section>

      <section className="ugc-table-shell" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-card)' }}>
        <div className="ugc-mobile-list">
          <div className="ugc-mobile-row ugc-mobile-head" aria-hidden="true"><span>Автор</span><span>Подп.</span><span>ER</span><span>Просм.</span><span>Оплата</span></div>
          {loading ? <p className="p-3">Загрузка…</p> : creators.length === 0 ? <p className="p-3">Никого не найдено.</p> : creators.map((creator) => {
            const profile = primaryProfile(creator, platform);
            const views = profile.avg_video_views ?? profile.latest_observed_views;
            const name = profile.handle ? `@${profile.handle}` : creator.display_name || 'Автор';
            return <div key={creator.id} className="ugc-mobile-row">
              <button type="button" className="ugc-mobile-name" title={creator.display_name ? `${name} · ${creator.display_name}` : name} onClick={() => setSelectedId(creator.id)}><span className="ugc-mobile-title">{name}</span><span className="ugc-mobile-meta"><PlatformIcons creator={creator} /><span>{formatActivity(creator.last_activity_at)}</span></span></button>
              <span title={`Подписчики: ${profile.followers ?? 'нет данных'}`}>{formatCount(profile.followers)}</span>
              <span title={`ER: ${profile.engagement_rate ?? 'нет данных'}`}>{formatRate(profile.engagement_rate)}</span>
              <span title={`Просмотры: ${views ?? 'нет данных'}`}>{formatCount(views)}</span>
              <span className="ugc-mobile-pay"><PayoutBadge payout={creator.payout} /></span>
            </div>;
          })}
        </div>
        <table ref={tableRef} className="ugc-table dx-keep-table w-full text-sm">
          <thead><tr className="border-b border-stone-200 bg-stone-50">
            <th scope="col" className="ugc-c-creator">Автор</th>
            <th scope="col" className="ugc-c-platform">Сеть</th>
            <th scope="col" className="ugc-c-num ugc-c-followers">Подписчики</th>
            <th scope="col" className="ugc-c-num ugc-c-er" title="Вовлечённость">ER</th>
            <th scope="col" className="ugc-c-num ugc-c-views" title="Средние просмотры; со звёздочкой одна публикация">Просмотры</th>
            <th scope="col" className="ugc-c-num ugc-c-activity" title="Последний контакт, выплата или публикация">Активность</th>
            <th scope="col" className="ugc-c-num ugc-c-pay">Оплата</th>
            <th scope="col" className="ugc-c-product ugc-sec-2">Продукт</th>
            <th scope="col" className="ugc-c-media ugc-sec-3">Контент</th>
            <th scope="col" className="ugc-c-next ugc-sec-1">Статус</th>
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={10} className="p-10 text-center"><Loader2 className="h-6 w-6 animate-spin inline-block" /> <span className="ml-2">Загрузка…</span></td></tr> : creators.length === 0 ? <tr><td colSpan={10} className="p-10 text-center" style={{ color: 'var(--fg-2)' }}><Users className="h-7 w-7 mx-auto mb-2" />Никого не найдено.</td></tr> : creators.map((creator) => {
              const profile = primaryProfile(creator, platform);
              const views = profile.avg_video_views ?? profile.latest_observed_views;
              const linked = linkedContent(profile);
              const products = Array.from(new Map(profile.content.flatMap((item) => item.products).map((item) => [item.sku, item])).values());
              const handle = profile.handle ? `@${profile.handle}` : null;
              const name = handle ?? creator.display_name ?? 'Автор';
              const secondName = handle && creator.display_name ? creator.display_name : null;
              return <tr key={creator.id} style={{ borderTop: '1px solid var(--border-hairline)' }}>
                <td className="ugc-c-creator"><button type="button" title={[name, secondName].filter(Boolean).join(' · ')} onClick={() => setSelectedId(creator.id)} className="ugc-creator min-h-11 text-left rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"><span className="ugc-creator-name">{name}</span><OriginMark origin={creator.origin} />{secondName ? <span className="ugc-creator-handle">{secondName}</span> : null}<span className="ugc-creator-platform"><PlatformIcons creator={creator} /></span></button></td>
                <td className="ugc-c-platform"><PlatformIcons creator={creator} /></td>
                <td className="ugc-c-num" title={profile.followers == null ? 'Нет данных' : `${profile.followers}`}>{formatCount(profile.followers)}</td>
                <td className="ugc-c-num" title={profile.engagement_rate == null ? 'Нет данных' : `${profile.engagement_rate}%`}>{formatRate(profile.engagement_rate)}</td>
                <td className="ugc-c-num" title={views == null ? 'Нет данных' : profile.view_observations === 1 ? `${views} · одна публикация` : `${views}`}><span className="ugc-figure">{formatCount(views)}{profile.view_observations === 1 && views != null ? <span className="ugc-star" aria-label="одна публикация">*</span> : null}</span></td>
                <td className="ugc-c-num" title={creator.last_activity_at ? new Date(creator.last_activity_at).toLocaleString('ru-RU', { timeZone: 'Asia/Yerevan', dateStyle: 'short', timeStyle: 'short' }) : 'Нет данных'}>{formatActivity(creator.last_activity_at)}</td>
                <td className="ugc-c-num ugc-c-pay"><PayoutBadge payout={creator.payout} /></td>
                <td className="ugc-c-product ugc-sec-2">{products.length ? <div className="ugc-pills" title={products.map((item) => `${compactProductCode(item.sku)} · ${item.name}`).join('\n')}>{products.slice(0, PRODUCT_PILLS).map((item) => <span key={`${item.sku}-${item.raw_offer_id}`} className="ugc-pill">{compactProductCode(item.sku)}</span>)}{products.length > PRODUCT_PILLS ? <span className="ugc-pill-more">+{products.length - PRODUCT_PILLS}</span> : null}</div> : <span className="ugc-muted">{profile.content.some((item) => item.product_status === 'queued') ? 'В очереди' : 'Не определён'}</span>}</td>
                <td className="ugc-c-media ugc-sec-3" aria-label={`${profile.content_count} публикаций`}>{linked.length ? <div className="ugc-media">{linked.slice(0, CONTENT_ICONS).map(({ item, href }, index) => <Publication key={item.id} item={item} href={href} more={index === CONTENT_ICONS - 1 ? linked.length - CONTENT_ICONS : 0} />)}</div> : <span className="ugc-muted">—</span>}</td>
                <td className="ugc-c-next ugc-sec-1" title={creator.collaboration?.next_action || undefined}><span className="ugc-stage" data-stage={creator.lifecycle_stage}>{creator.lifecycle_stage}</span></td>
              </tr>;
            })}
          </tbody>
        </table>
      </section>

      {selected && <div ref={(node) => { if (node) node.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}><CreatorPanel key={selected.id} creator={selected} onClose={() => setSelectedId(null)} onSaved={load} /></div>}
      <div className="ugc-stage-legend" aria-label="Статусы">{STAGES.map((value) => <span key={value} className="ugc-stage" data-stage={value}>{value}</span>)}</div>
      <p className="erp-page-help text-sm" style={{ color: 'var(--fg-3)' }}>* Одна публикация: показаны её просмотры, а не среднее. Нет данных: прочерк.</p>
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
  const [message, setMessage] = useState<string | null>(null);
  const content = creator.profiles.flatMap((profile) => profile.content.map((item) => ({ ...item, platform: profile.platform })));

  async function save() {
    setSaving(true); setMessage(null);
    const creatorResult = await apiPatch(`/api/ugc/creators/${creator.id}`, { lifecycle_stage: stage, origin: origin || null, owner, notes });
    const collabResult = await apiPost('/api/ugc/collaborations', { id: collaboration.id, creator_id: creator.id, platform: creator.profiles[0]?.platform, status: stage, contact_channel: channel, next_action: nextAction, next_action_at: nextActionAt, sample_status: sampleStatus, deliverables, rights_scope: rights, rights_expires_at: rightsExpiry });
    if (!creatorResult.success || !collabResult.success) setMessage(creatorResult.errors[0]?.message ?? collabResult.errors[0]?.message ?? 'Save failed');
    else { setMessage('Saved'); await onSaved(); }
    setSaving(false);
  }

  return <section className="p-5 md:p-6 space-y-5" style={{ background: 'var(--bg-surface)', border: '2px solid var(--brand-schwarz)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-raised)' }}>
    <div className="flex items-start justify-between gap-4"><div><div className="dx-eyebrow">Creator record</div><h2 className="mt-1 text-2xl font-extrabold">{creator.display_name || `@${creator.profiles[0]?.handle}`}</h2></div><button type="button" onClick={onClose} className="min-h-11 min-w-11 flex items-center justify-center" aria-label="Close creator panel"><X className="h-5 w-5" /></button></div>
    <div className="grid md:grid-cols-3 gap-3">{creator.profiles.map((profile) => <div key={profile.id} className="p-4" style={{ background: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)' }}><div className="font-bold capitalize">{profile.platform} · @{profile.handle}</div><div className="mt-2 text-sm" style={{ color: 'var(--fg-2)' }}>{formatNumber(profile.followers)} followers · {profile.view_observations} view observations</div><div className="mt-1 text-sm" style={{ color: 'var(--fg-2)' }}>{formatNumber(profile.commerce_clicks)} clicks · {formatNumber(profile.commerce_orders)} orders</div><div className="mt-1 text-sm" style={{ color: 'var(--fg-3)' }}>Metrics as of {profile.metrics_as_of || 'unknown'}</div></div>)}</div>
    {creator.payouts?.length ? <section className="space-y-2" aria-labelledby={`payouts-${creator.id}`}>
      <div className="flex items-end justify-between gap-3"><div><div className="dx-eyebrow">Barter refunds</div><h3 id={`payouts-${creator.id}`} className="mt-1 text-xl font-extrabold">Оплата</h3></div><div className="text-sm tabular-nums" style={{ color: 'var(--fg-2)' }}>Paid {formatRub(creator.paid_total_minor ?? 0)}</div></div>
      <div className="grid gap-2">{creator.payouts.map((item) => <div key={item.id} className="p-3 flex items-center justify-between gap-3" style={{ background: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)' }}><PayoutBadge payout={item} /><span className="text-xs" style={{ color: 'var(--fg-3)' }}>{item.status === 'awaiting_approval' || item.status === 'approved' ? 'В очереди' : item.payout_date}</span></div>)}</div>
    </section> : null}
    <section className="space-y-3" aria-labelledby={`content-history-${creator.id}`}>
      <div className="flex items-end justify-between gap-3"><div><div className="dx-eyebrow">Content evidence</div><h3 id={`content-history-${creator.id}`} className="mt-1 text-xl font-extrabold">Publication history</h3></div><div className="text-sm tabular-nums" style={{ color: 'var(--fg-2)' }}>{content.length} observations</div></div>
      {content.length ? <div className="grid lg:grid-cols-2 gap-3">{content.map((item) => {
        const href = contentHref(item.content_url);
        return <article key={item.id} className="p-4 space-y-3" style={{ background: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)' }}>
          <div className="flex items-start justify-between gap-3"><div><div className="font-bold capitalize">{item.platform}{item.content_type ? ` · ${item.content_type}` : ''}</div><div className="mt-1 text-xs" style={{ color: 'var(--fg-3)' }}>{item.published_at ? `Published ${item.published_at}` : `${item.source_sheet || 'Source'}${item.source_row == null ? '' : ` · row ${item.source_row}`}`}</div></div>{href ? <div className="shrink-0"><a href={href} target="_blank" rel="noopener noreferrer" className="min-h-11 px-1 inline-flex items-center font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={`Open ${item.platform} content`}><span className="px-2 py-1 inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--fg-on-brand)', background: 'var(--brand-schwarz)', borderRadius: 'var(--radius-sm)' }}><ExternalLink className="h-3.5 w-3.5" />Open content</span></a></div> : <span className="min-h-11 px-3 shrink-0 inline-flex items-center gap-2 text-sm" style={{ color: 'var(--fg-3)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}><Link2Off className="h-4 w-4" />No link recorded</span>}</div>
          {href && <a title={item.content_url || undefined} href={href} target="_blank" rel="noopener noreferrer" className="min-h-11 ugc-content-url block text-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ color: 'var(--brand-rot)' }}>{item.content_url}</a>}
          <ProductEvidence item={item} />
          {href && <LinkHealth item={item} />}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" style={{ color: 'var(--fg-2)' }}><span>{formatNumber(item.views)} views</span><span>{formatNumber(item.likes ?? null)} likes</span><span>{formatNumber(item.comments)} comments</span><span>{item.product_codes.length ? item.product_codes.join(', ') : 'No products recorded'}</span></div>
        </article>;
      })}</div> : <div className="min-h-20 p-4 flex items-center gap-3" style={{ color: 'var(--fg-2)', background: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)' }}><Link2Off className="h-5 w-5" />No content observations recorded.</div>}
    </section>
    <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
      <Field label="Stage"><select value={stage} onChange={(event) => setStage(event.target.value)}>{STAGES.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
      <Field label="Origin"><select value={origin} onChange={(event) => setOrigin(event.target.value)}><option value="">—</option>{ORIGINS.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
      <Field label="Owner"><input value={owner} onChange={(event) => setOwner(event.target.value)} /></Field>
      <Field label="Contact channel"><input value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="Shopee, TikTok Shop, Zalo…" /></Field>
      <Field label="Sample status"><input value={sampleStatus} onChange={(event) => setSampleStatus(event.target.value)} /></Field>
      <Field label="Next action"><input value={nextAction} onChange={(event) => setNextAction(event.target.value)} /></Field>
      <Field label="Next action date"><input type="date" value={nextActionAt} onChange={(event) => setNextActionAt(event.target.value)} /></Field>
      <Field label="Rights expiry"><input type="date" value={rightsExpiry} onChange={(event) => setRightsExpiry(event.target.value)} /></Field>
      <Field label="Deliverables"><input value={deliverables} onChange={(event) => setDeliverables(event.target.value)} placeholder="1 Shopee Video…" /></Field>
    </div>
    <div className="grid md:grid-cols-2 gap-4"><Field label="Rights"><textarea value={rights} onChange={(event) => setRights(event.target.value)} rows={3} /></Field><Field label="Notes"><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} /></Field></div>
    <div className="flex items-center gap-3"><button type="button" disabled={saving} onClick={save} className="min-h-11 px-5 font-bold flex items-center gap-2 transition-transform hover:-translate-y-0.5 disabled:transform-none disabled:opacity-60" style={{ color: 'var(--fg-on-brand)', background: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-raised)' }}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}Save creator</button>{message && <span role="status" aria-live="polite" className="text-sm" style={{ color: message === 'Saved' ? 'var(--status-success)' : 'var(--status-error)' }}>{message}</span>}</div>
  </section>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="space-y-2"><span className="block text-sm font-bold" style={{ color: 'var(--fg-2)' }}>{label}</span><span className="block [&>input]:w-full [&>input]:min-h-11 [&>input]:px-3 [&>select]:w-full [&>select]:min-h-11 [&>select]:px-3 [&>textarea]:w-full [&>textarea]:p-3 [&>*]:bg-transparent [&>*]:outline-none" style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{children}</span></label>;
}
