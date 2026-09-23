'use client';

import { ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpDown, ExternalLink, FileSpreadsheet, FileText, ImageIcon, Link, Link2Off, Loader2, Search, Users, Video, X } from 'lucide-react';
import PageHeader from '@/components/ui/page-header';
import { apiGet, apiPatch, apiPost } from '@/lib/api';
import { parseUgcWorkbook } from '@/lib/ugc-import';

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

type Creator = {
  id: string;
  normalized_handle: string;
  display_name: string | null;
  category: string | null;
  audience_market: string | null;
  audience_language: string | null;
  lifecycle_stage: string;
  priority: string | null;
  owner: string | null;
  notes: string | null;
  profiles: PlatformMetric[];
  collaboration: Collaboration | null;
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
  summary: { creators: number; profiles: number; content_items: number; active_outreach: number; published: number } & LinkSummary;
  platforms: { platform: string; creator_count: number }[];
  products: { sku: string; name: string; content_count: number }[];
};

const PLATFORM_TABS = ['all', 'instagram', 'tiktok', 'vk', 'shopee', 'lazada', 'facebook', 'telegram', 'youtube', 'other'];
const STAGES = ['found', 'qualified', 'invited', 'accepted', 'sample_delivered', 'published', 'orders_mature', 'renew', 'stop'];
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

function latestLinkedContent(profile: PlatformMetric): { item: ContentObservation; href: string } | null {
  for (const item of profile.content) {
    const href = contentHref(item.content_url);
    if (href) return { item, href };
  }
  return null;
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

const LINK_STATUS_LABEL: Record<LinkStatus, string> = { active: 'Active', missing: 'Missing', restricted: 'Restricted', unknown: 'Unknown', invalid: 'Invalid' };

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
  return <span className={`inline-flex items-center gap-1.5 ${compact ? 'text-xs' : 'text-sm'}`} style={{ color: statusColor(item.link_status) }} title={item.link_check_note || undefined}><span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: statusColor(item.link_status) }} />{label}{item.link_checked_at ? ` · ${formatCheckedAt(item.link_checked_at)}` : ''}</span>;
}

function ProductEvidence({ item }: { item: ContentObservation }) {
  if (item.products.length) return <div className="flex flex-wrap items-center gap-2">{item.products.map((product) => <span key={`${product.sku}-${product.raw_offer_id}`} title={`${product.name} · ${product.raw_offer_id} · ${product.source} · confidence ${product.confidence}`} className="px-2 py-1 text-xs font-bold" style={{ color: 'var(--brand-schwarz)', background: 'var(--brand-gold)', borderRadius: 'var(--radius-pill)' }}>{compactProductCode(product.raw_offer_id || product.raw_code || product.sku)}</span>)}<span className="text-xs" style={{ color: 'var(--status-success)' }}>Confirmed from explicit product field</span></div>;
  if (item.unknown_product_codes.length) return <div className="text-xs" style={{ color: 'var(--status-warning)' }}>Unknown product code: {item.unknown_product_codes.join(', ')} · needs review</div>;
  if (item.product_status === 'queued') return <div className="text-xs" style={{ color: 'var(--fg-3)' }}>Product identification queued · no explicit product evidence</div>;
  return <div className="text-xs" style={{ color: 'var(--fg-3)' }}>Product unknown</div>;
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

export default function UgcPage() {
  const [data, setData] = useState<UgcPayload>(API_EMPTY);
  const [platform, setPlatform] = useState('all');
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [product, setProduct] = useState('');
  const [sort, setSort] = useState('followers');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [checkingLinks, setCheckingLinks] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const urlStateReady = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (platform !== 'all') params.set('platform', platform);
    if (search.trim()) params.set('search', search.trim());
    if (stage) params.set('stage', stage);
    if (product) params.set('product', product);
    const response = await apiGet<UgcPayload>(`/api/ugc?${params.toString()}`);
    if (!response.success || !response.result) setError(response.errors[0]?.message ?? 'UGC data could not be loaded');
    else setData(response.result);
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
    if (sort === 'followers') params.delete('sort'); else params.set('sort', sort);
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, [platform, search, stage, product, sort]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlPlatform = params.get('platform');
    const urlSort = params.get('sort');
    if (urlPlatform && PLATFORM_TABS.includes(urlPlatform)) setPlatform(urlPlatform);
    if (urlSort && ['followers', 'views', 'engagement', 'stage'].includes(urlSort)) setSort(urlSort);
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
      return (bp.followers ?? -1) - (ap.followers ?? -1);
    });
    return rows;
  }, [data.creators, platform, sort]);
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

  return (
    <div className="p-5 md:p-8 space-y-7">
      <PageHeader
        eyebrow="Creator operations"
        title="UGC"
        subtitle="Creators, platform evidence, outreach, samples, content and usage rights in one operating view."
        actions={(
          <>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onImport} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={Boolean(importing)} className="min-h-11 px-1 flex items-center font-bold transition-transform hover:-translate-y-0.5 disabled:transform-none disabled:opacity-60">
              <span className="px-2.5 py-1.5 inline-flex items-center gap-2" style={{ color: 'var(--fg-on-brand)', background: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-raised)' }}>{importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}{importing ?? 'Import XLSX'}</span>
            </button>
          </>
        )}
      />

      {error && <div role="alert" className="p-4 flex items-start justify-between gap-4" style={{ background: 'var(--paper-sunk)', borderLeft: '4px solid var(--status-error)' }}><span>{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError(null)} className="min-h-11 flex items-center justify-center" style={{ minWidth: '44px' }}><X className="h-5 w-5" /></button></div>}
      <div role="status" aria-live="polite" className="sr-only">{importing}</div>

      <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
        <Kpi label="Creators" value={formatNumber(data.summary.creators)} exact={`${data.summary.creators} creators`} note="in this view" accent="var(--brand-schwarz)" />
        <Kpi label="Followers" value={formatNumber(headline.followers)} exact={`${headline.followers} followers`} note="known audience" accent="var(--brand-rot)" />
        <Kpi label="Avg views" value={formatNumber(headline.avgViews)} exact={headline.avgViews == null ? 'Unknown' : `${headline.avgViews} average views`} note="per known profile" accent="var(--status-info)" />
        <Kpi label="Engagement" value={headline.avgEr == null ? '—' : `${formatNumber(headline.avgEr)}%`} exact={headline.avgEr == null ? 'Unknown' : `${headline.avgEr}% average engagement`} note="known profiles" accent="var(--status-success)" />
        <Kpi label="Publications" value={formatNumber(data.summary.content_items)} exact={`${data.summary.content_items} publications`} note="observed content" accent="var(--brand-schwarz)" />
        <Kpi label="Products" value={formatNumber(data.products.length)} exact={`${data.products.length} identified product families`} note={`${formatNumber(data.summary.product_queued)} queued`} accent="var(--brand-gold)" />
      </section>

      <section aria-label="Content link health" className="p-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
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

      <section className="space-y-4">
        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Platforms">
          {PLATFORM_TABS.map((key) => {
            const count = key === 'all' ? data.summary.creators : data.platforms.find((item) => item.platform === key)?.creator_count;
            return <button key={key} type="button" aria-pressed={platform === key} onClick={() => setPlatform(key)} className="min-h-11 shrink-0 px-1 flex items-center font-bold capitalize focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"><span className="px-2.5 py-1" style={{ color: platform === key ? 'var(--fg-on-brand)' : 'var(--fg-1)', background: platform === key ? 'var(--brand-schwarz)' : 'var(--paper-sunk)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-pill)' }}>{key} {count != null ? `· ${count}` : ''}</span></button>;
          })}
        </div>

        <div className="grid md:grid-cols-2 xl:grid-cols-[minmax(240px,1fr)_170px_190px_170px] gap-2">
          <label className="min-h-11 px-3 flex items-center gap-2" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
            <Search className="h-4 w-4" style={{ color: 'var(--fg-3)' }} />
            <input aria-label="Search creators" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search creators…" className="w-full bg-transparent outline-none" />
          </label>
          <select aria-label="Filter by collaboration stage" value={stage} onChange={(event) => setStage(event.target.value)} className="min-h-11 px-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}><option value="">All stages</option>{STAGES.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select>
          <select aria-label="Filter by product" value={product} onChange={(event) => setProduct(event.target.value)} className="min-h-11 px-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}><option value="">All products</option>{data.products.map((item) => <option key={item.sku} value={item.sku}>{compactProductCode(item.sku)} · {item.content_count}</option>)}</select>
          <label className="min-h-11 px-3 flex items-center gap-2" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}><ArrowUpDown className="h-4 w-4" /><select aria-label="Sort creators" value={sort} onChange={(event) => setSort(event.target.value)} className="w-full bg-transparent outline-none"><option value="followers">Followers</option><option value="views">Views</option><option value="engagement">Engagement</option><option value="stage">Stage</option></select></label>
        </div>
      </section>

      <section className="overflow-x-auto" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-card)' }}>
        <table className="w-full text-sm">
          <thead style={{ background: 'var(--paper-sunk)', color: 'var(--fg-2)' }}><tr><th className="text-left p-3">Creator</th><th className="text-right p-3">Followers</th><th className="text-right p-3">Avg views</th><th className="text-right p-3">Engagement</th><th className="text-left p-3">Publications</th><th className="text-left p-3">Product</th><th className="text-left p-3">Media</th><th className="text-left p-3">Next</th></tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={8} className="p-10 text-center"><Loader2 className="h-6 w-6 animate-spin inline-block" /> <span className="ml-2">Loading UGC…</span></td></tr> : creators.length === 0 ? <tr><td colSpan={8} className="p-10 text-center" style={{ color: 'var(--fg-2)' }}><Users className="h-7 w-7 mx-auto mb-2" />No creators match this view.</td></tr> : creators.map((creator) => {
              const profile = primaryProfile(creator, platform);
              const views = profile.avg_video_views ?? profile.latest_observed_views;
              const latest = latestLinkedContent(profile);
              const media = latest ? mediaKind(latest.item) : null;
              const products = Array.from(new Map(profile.content.flatMap((item) => item.products).map((item) => [item.sku, item])).values());
              return <tr key={creator.id} style={{ borderTop: '1px solid var(--border-hairline)' }}><td className="p-3"><button type="button" onClick={() => setSelectedId(creator.id)} className="min-h-11 text-left rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"><span className="block font-bold underline decoration-transparent underline-offset-4 hover:decoration-current">{creator.display_name || `@${profile.handle}`}</span><span className="block text-xs capitalize" style={{ color: 'var(--fg-3)' }}>{profile.platform} · @{profile.handle}</span></button></td><td className="p-3 text-right tabular-nums" title={profile.followers == null ? 'Unknown' : `${profile.followers}`}>{formatNumber(profile.followers)}</td><td className="p-3 text-right tabular-nums" title={views == null ? 'Unknown' : `${views}`}>{formatNumber(views)}{profile.view_observations === 1 ? <span title="One observed publication"> *</span> : null}</td><td className="p-3 text-right tabular-nums" title={profile.engagement_rate == null ? 'Unknown' : `${profile.engagement_rate}%`}>{profile.engagement_rate == null ? '—' : `${formatNumber(profile.engagement_rate)}%`}</td><td className="p-3 tabular-nums" aria-label={`${profile.content_count} content observations`}>{formatNumber(profile.content_count)}</td><td className="p-3">{products.length ? <div className="flex flex-wrap gap-1">{products.slice(0, 2).map((item) => <span key={`${item.sku}-${item.raw_offer_id}`} title={`${item.name} · ${item.raw_offer_id} · confirmed from explicit import`} className="px-2 py-1 text-xs font-bold" style={{ background: 'var(--brand-gold)', color: 'var(--brand-schwarz)', borderRadius: 'var(--radius-pill)' }}>{compactProductCode(item.raw_offer_id || item.raw_code || item.sku)}</span>)}</div> : <span className="text-xs" style={{ color: 'var(--fg-3)' }}>{profile.content.some((item) => item.product_status === 'queued') ? 'Queued' : 'Unknown'}</span>}</td><td className="p-3">{latest && media ? <div className="inline-flex flex-col gap-1"><a href={latest.href} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} className="min-h-11 px-1 inline-flex items-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={`Open latest ${media.toLowerCase()} from @${profile.handle}`} title={latest.item.content_url ?? undefined}><span className="px-2 py-1 inline-flex items-center gap-1.5 text-xs font-bold" style={{ color: 'var(--brand-rot)', background: 'var(--paper-sunk)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{media === 'Video' ? <Video className="h-4 w-4" /> : media === 'Image' ? <ImageIcon className="h-4 w-4" /> : media === 'Post' ? <FileText className="h-4 w-4" /> : <Link className="h-4 w-4" />}<span>{media}</span><ExternalLink className="h-3 w-3" /></span></a><LinkHealth item={latest.item} compact /></div> : <span style={{ color: 'var(--fg-3)' }}>N/A</span>}</td><td className="p-3">{creator.collaboration?.next_action || '—'}</td></tr>;
            })}
          </tbody>
        </table>
      </section>

      {selected && <CreatorPanel key={selected.id} creator={selected} onClose={() => setSelectedId(null)} onSaved={load} />}
      <p className="text-sm" style={{ color: 'var(--fg-3)' }}>* A single publication is shown as observed views, not as an average. Unknown values remain blank.</p>
    </div>
  );
}

function CreatorPanel({ creator, onClose, onSaved }: { creator: Creator; onClose: () => void; onSaved: () => Promise<void> }) {
  const collaboration = creator.collaboration ?? {};
  const [stage, setStage] = useState(creator.lifecycle_stage);
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
    const creatorResult = await apiPatch(`/api/ugc/creators/${creator.id}`, { lifecycle_stage: stage, owner, notes });
    const collabResult = await apiPost('/api/ugc/collaborations', { id: collaboration.id, creator_id: creator.id, platform: creator.profiles[0]?.platform, status: stage, contact_channel: channel, next_action: nextAction, next_action_at: nextActionAt, sample_status: sampleStatus, deliverables, rights_scope: rights, rights_expires_at: rightsExpiry });
    if (!creatorResult.success || !collabResult.success) setMessage(creatorResult.errors[0]?.message ?? collabResult.errors[0]?.message ?? 'Save failed');
    else { setMessage('Saved'); await onSaved(); }
    setSaving(false);
  }

  return <section className="p-5 md:p-6 space-y-5" style={{ background: 'var(--bg-surface)', border: '2px solid var(--brand-schwarz)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-raised)' }}>
    <div className="flex items-start justify-between gap-4"><div><div className="dx-eyebrow">Creator record</div><h2 className="mt-1 text-2xl font-extrabold">{creator.display_name || `@${creator.profiles[0]?.handle}`}</h2></div><button type="button" onClick={onClose} className="min-h-11 min-w-11 flex items-center justify-center" aria-label="Close creator panel"><X className="h-5 w-5" /></button></div>
    <div className="grid md:grid-cols-3 gap-3">{creator.profiles.map((profile) => <div key={profile.id} className="p-4" style={{ background: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)' }}><div className="font-bold capitalize">{profile.platform} · @{profile.handle}</div><div className="mt-2 text-sm" style={{ color: 'var(--fg-2)' }}>{formatNumber(profile.followers)} followers · {profile.view_observations} view observations</div><div className="mt-1 text-sm" style={{ color: 'var(--fg-2)' }}>{formatNumber(profile.commerce_clicks)} clicks · {formatNumber(profile.commerce_orders)} orders</div><div className="mt-1 text-sm" style={{ color: 'var(--fg-3)' }}>Metrics as of {profile.metrics_as_of || 'unknown'}</div></div>)}</div>
    <section className="space-y-3" aria-labelledby={`content-history-${creator.id}`}>
      <div className="flex items-end justify-between gap-3"><div><div className="dx-eyebrow">Content evidence</div><h3 id={`content-history-${creator.id}`} className="mt-1 text-xl font-extrabold">Publication history</h3></div><div className="text-sm tabular-nums" style={{ color: 'var(--fg-2)' }}>{content.length} observations</div></div>
      {content.length ? <div className="grid lg:grid-cols-2 gap-3">{content.map((item) => {
        const href = contentHref(item.content_url);
        return <article key={item.id} className="p-4 space-y-3" style={{ background: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)' }}>
          <div className="flex items-start justify-between gap-3"><div><div className="font-bold capitalize">{item.platform}{item.content_type ? ` · ${item.content_type}` : ''}</div><div className="mt-1 text-xs" style={{ color: 'var(--fg-3)' }}>{item.published_at ? `Published ${item.published_at}` : `${item.source_sheet || 'Source'}${item.source_row == null ? '' : ` · row ${item.source_row}`}`}</div></div>{href ? <div className="shrink-0"><a href={href} target="_blank" rel="noopener noreferrer" className="min-h-11 px-1 inline-flex items-center font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={`Open ${item.platform} content`}><span className="px-2 py-1 inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--fg-on-brand)', background: 'var(--brand-schwarz)', borderRadius: 'var(--radius-sm)' }}><ExternalLink className="h-3.5 w-3.5" />Open content</span></a></div> : <span className="min-h-11 px-3 shrink-0 inline-flex items-center gap-2 text-sm" style={{ color: 'var(--fg-3)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}><Link2Off className="h-4 w-4" />No link recorded</span>}</div>
          {href && <a href={href} target="_blank" rel="noopener noreferrer" className="min-h-11 flex items-center break-all text-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ color: 'var(--brand-rot)' }}>{item.content_url}</a>}
          <ProductEvidence item={item} />
          {href && <LinkHealth item={item} />}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" style={{ color: 'var(--fg-2)' }}><span>{formatNumber(item.views)} views</span><span>{formatNumber(item.comments)} comments</span><span>{item.product_codes.length ? item.product_codes.join(', ') : 'No products recorded'}</span></div>
        </article>;
      })}</div> : <div className="min-h-20 p-4 flex items-center gap-3" style={{ color: 'var(--fg-2)', background: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)' }}><Link2Off className="h-5 w-5" />No content observations recorded.</div>}
    </section>
    <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
      <Field label="Stage"><select value={stage} onChange={(event) => setStage(event.target.value)}>{STAGES.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></Field>
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
