'use client';

import { ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpDown, FileSpreadsheet, Loader2, Search, Users, Video, X } from 'lucide-react';
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
  metrics_as_of: string | null;
};

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

type UgcPayload = {
  creators: Creator[];
  summary: { creators: number; profiles: number; content_items: number; active_outreach: number; published: number };
  platforms: { platform: string; creator_count: number }[];
};

const PLATFORM_TABS = ['all', 'instagram', 'tiktok', 'vk', 'shopee', 'lazada', 'facebook', 'telegram', 'youtube', 'other'];
const STAGES = ['found', 'qualified', 'invited', 'accepted', 'sample_delivered', 'published', 'orders_mature', 'renew', 'stop'];
const API_EMPTY: UgcPayload = { creators: [], summary: { creators: 0, profiles: 0, content_items: 0, active_outreach: 0, published: 0 }, platforms: [] };

function formatNumber(value: number | null | undefined): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en', { maximumFractionDigits: 1, notation: value >= 10_000 ? 'compact' : 'standard' }).format(value);
}

function primaryProfile(creator: Creator, activePlatform: string): PlatformMetric {
  return creator.profiles.find((profile) => profile.platform === activePlatform)
    ?? [...creator.profiles].sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1))[0];
}

function Card({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-card)' }}>
      <div className="dx-eyebrow" style={{ color: 'var(--fg-3)' }}>{label}</div>
      <div className="mt-2" style={{ fontFamily: 'var(--font-display)', fontSize: '32px', fontWeight: 900, lineHeight: 1 }}>{value}</div>
      <div className="mt-2 text-sm" style={{ color: 'var(--fg-2)' }}>{note}</div>
    </div>
  );
}

export default function UgcPage() {
  const [data, setData] = useState<UgcPayload>(API_EMPTY);
  const [platform, setPlatform] = useState('all');
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [sort, setSort] = useState('followers');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const urlStateReady = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (platform !== 'all') params.set('platform', platform);
    if (search.trim()) params.set('search', search.trim());
    if (stage) params.set('stage', stage);
    const response = await apiGet<UgcPayload>(`/api/ugc?${params.toString()}`);
    if (!response.success || !response.result) setError(response.errors[0]?.message ?? 'UGC data could not be loaded');
    else setData(response.result);
    setLoading(false);
  }, [platform, search, stage]);

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
    if (sort === 'followers') params.delete('sort'); else params.set('sort', sort);
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, [platform, search, stage, sort]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlPlatform = params.get('platform');
    const urlSort = params.get('sort');
    if (urlPlatform && PLATFORM_TABS.includes(urlPlatform)) setPlatform(urlPlatform);
    if (urlSort && ['followers', 'views', 'engagement', 'stage'].includes(urlSort)) setSort(urlSort);
    setSearch(params.get('search') ?? '');
    setStage(params.get('stage') ?? '');
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

  return (
    <div className="p-5 md:p-8 space-y-7">
      <PageHeader
        eyebrow="Creator operations"
        title="UGC"
        subtitle="Creators, platform evidence, outreach, samples, content and usage rights in one operating view."
        actions={(
          <>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onImport} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={Boolean(importing)} className="min-h-11 px-4 flex items-center gap-2 font-bold transition-transform hover:-translate-y-0.5 disabled:transform-none disabled:opacity-60" style={{ color: 'var(--fg-on-brand)', background: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-raised)' }}>
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
              {importing ?? 'Import XLSX'}
            </button>
          </>
        )}
      />

      {error && <div role="alert" className="p-4 flex items-start justify-between gap-4" style={{ background: 'var(--paper-sunk)', borderLeft: '4px solid var(--status-error)' }}><span>{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError(null)} className="min-h-11 flex items-center justify-center" style={{ minWidth: '44px' }}><X className="h-5 w-5" /></button></div>}
      <div role="status" aria-live="polite" className="sr-only">{importing}</div>

      <section className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        <Card label="Creators" value={formatNumber(data.summary.creators)} note="distinct platform identities" />
        <Card label="Profiles" value={formatNumber(data.summary.profiles)} note="across all platforms" />
        <Card label="Content" value={formatNumber(data.summary.content_items)} note="observed publications" />
        <Card label="In motion" value={formatNumber(data.summary.active_outreach)} note="active outreach" />
        <Card label="Published" value={formatNumber(data.summary.published)} note="tracked collaborations" />
      </section>

      <section className="space-y-4">
        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Platforms">
          {PLATFORM_TABS.map((key) => {
            const count = key === 'all' ? data.summary.creators : data.platforms.find((item) => item.platform === key)?.creator_count;
            return <button key={key} type="button" aria-pressed={platform === key} onClick={() => setPlatform(key)} className="min-h-11 shrink-0 px-4 font-bold capitalize" style={{ color: platform === key ? 'var(--fg-on-brand)' : 'var(--fg-1)', background: platform === key ? 'var(--brand-schwarz)' : 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{key} {count != null ? `· ${count}` : ''}</button>;
          })}
        </div>

        <div className="grid md:grid-cols-[minmax(240px,1fr)_180px_180px] gap-3">
          <label className="min-h-11 px-3 flex items-center gap-2" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
            <Search className="h-4 w-4" style={{ color: 'var(--fg-3)' }} />
            <input aria-label="Search creators" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search creators…" className="w-full bg-transparent outline-none" />
          </label>
          <select aria-label="Filter by collaboration stage" value={stage} onChange={(event) => setStage(event.target.value)} className="min-h-11 px-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}><option value="">All stages</option>{STAGES.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select>
          <label className="min-h-11 px-3 flex items-center gap-2" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}><ArrowUpDown className="h-4 w-4" /><select aria-label="Sort creators" value={sort} onChange={(event) => setSort(event.target.value)} className="w-full bg-transparent outline-none"><option value="followers">Followers</option><option value="views">Views</option><option value="engagement">Engagement</option><option value="stage">Stage</option></select></label>
        </div>
      </section>

      <section className="overflow-x-auto" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-card)' }}>
        <table className="w-full text-sm">
          <thead style={{ background: 'var(--paper-sunk)', color: 'var(--fg-2)' }}><tr><th className="text-left p-3">Creator</th><th className="text-left p-3">Platform</th><th className="text-right p-3">Followers</th><th className="text-right p-3">ER</th><th className="text-right p-3">Avg / observed views</th><th className="text-right p-3">Content</th><th className="text-left p-3">Stage</th><th className="text-left p-3">Next action</th></tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={8} className="p-10 text-center"><Loader2 className="h-6 w-6 animate-spin inline-block" /> <span className="ml-2">Loading UGC…</span></td></tr> : creators.length === 0 ? <tr><td colSpan={8} className="p-10 text-center" style={{ color: 'var(--fg-2)' }}><Users className="h-7 w-7 mx-auto mb-2" />No creators match this view.</td></tr> : creators.map((creator) => {
              const profile = primaryProfile(creator, platform);
              const views = profile.avg_video_views ?? profile.latest_observed_views;
              return <tr key={creator.id} style={{ borderTop: '1px solid var(--border-hairline)' }}><td className="p-3"><button type="button" onClick={() => setSelectedId(creator.id)} className="text-left rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"><span className="block font-bold underline decoration-transparent underline-offset-4 hover:decoration-current">{creator.display_name || `@${profile.handle}`}</span><span className="block" style={{ color: 'var(--fg-3)' }}>@{profile.handle}</span></button></td><td className="p-3 capitalize">{profile.platform}</td><td className="p-3 text-right tabular-nums">{formatNumber(profile.followers)}</td><td className="p-3 text-right tabular-nums">{profile.engagement_rate == null ? '—' : `${formatNumber(profile.engagement_rate)}%`}</td><td className="p-3 text-right tabular-nums">{formatNumber(views)}{profile.view_observations === 1 ? <span title="One observed publication"> *</span> : null}</td><td className="p-3 text-right tabular-nums">{formatNumber(profile.content_count)}</td><td className="p-3"><span className="px-2 py-1 font-bold" style={{ background: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)' }}>{creator.lifecycle_stage.replaceAll('_', ' ')}</span></td><td className="p-3">{creator.collaboration?.next_action || '—'}</td></tr>;
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
