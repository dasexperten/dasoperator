'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Card,
  Metric,
  Text,
  Title,
  AreaChart,
  BarChart,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
  Badge,
  Flex,
  Bold,
  Italic,
  ProgressBar,
} from '@tremor/react';

// =============================================================================
// /analytics - SEO & Marketplace Analytics dashboard.
//
// Data legs (all read-only, unauth per Aram's "сначала без auth, позже закроем"):
//   - /api/metrika/stats         (today + 30d visits timeline)
//   - /api/metrika/sources       (traffic sources 90d / 30d, with purchases + CR)
//   - /api/metrika/phrases       (top organic search phrases)
//   - /api/analytics/marketplace-summary (Ozon + WB FBO units & 30d sales from D1)
//
// Last verified baseline: audits/2026-06-11_yandex-audit.md
// Latest audit:           audits/2026-07-05_full-audit.md
// =============================================================================

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

// ----- types -----------------------------------------------------------------
type TimelinePoint = { date: string; visits: number; users: number };
type SourceRow = { source: string; visits: number; purchases: number; cr: number };
type SourcePayload = {
  window_days: number;
  totals: { visits: number; purchases: number; cr: number };
  rows: SourceRow[];
  synced_at: number;
};
type PhraseRow = { phrase: string; visits: number };
type PhrasePayload = {
  window_days: number;
  total_visits_with_phrase: number;
  rows: PhraseRow[];
  synced_at: number;
};
type StatsPayload = {
  today: { visits: number; users: number; bounce_rate_pct: number; avg_duration_sec: number };
  timeline: TimelinePoint[];
};
type MpSummary = {
  marketplaces: Array<{
    marketplace: string;
    fbo_units: number;
    sales_30d: number;
    sku_count_stock: number;
    sku_count_sales: number;
    last_sync: number | null;
    last_finish: number | null;
  }>;
  top_sku: Array<{ base_sku: string; marketplace: string; units_30d: number }>;
  per_sku: Array<{ base_sku: string; marketplace: string; fbo_units: number; sales_30d: number }>;
};

// ----- hardcode: 5 money clusters without landing pages (per Aram's decision) -
const MONEY_CLUSTERS: Array<{
  cluster: string;
  query_ru: string;
  query_en: string;
  sku: string;
  status: string;
}> = [
  { cluster: 'Энзимная паста', query_ru: 'ферментная зубная паста', query_en: 'enzyme toothpaste', sku: 'INNOWEISS', status: 'no landing' },
  { cluster: 'Пробиотическая паста', query_ru: 'пробиотическая зубная паста', query_en: 'probiotic toothpaste', sku: 'SYMBIOS', status: 'no landing' },
  { cluster: 'Charcoal', query_ru: 'угольная зубная паста', query_en: 'charcoal toothpaste', sku: 'SCHWARZ', status: 'no landing' },
  { cluster: 'Clean-label / без фтора', query_ru: 'зубная паста без фтора', query_en: 'fluoride-free toothpaste', sku: 'DETOX / BIO', status: 'no landing' },
  { cluster: 'Ершики для брекетов', query_ru: 'межзубные ершики для брекетов', query_en: 'interdental brushes braces', sku: 'MITTEL', status: 'no landing' },
];

// ----- intent classifier (das-adaptation §1) --------------------------------
type Intent = 'money' | 'info' | 'brand' | 'competitor' | 'diy' | 'other';
function classifyIntent(phrase: string): Intent {
  const p = phrase.toLowerCase();
  if (/(купить|цена|заказать|сколько стоит|отзывы|состав)/.test(p)) return 'money';
  if (/(как |что такое |зачем |полезен|вред|миф|инструкция|отзывы)/.test(p)) return 'info';
  const brand = /(das\s?experten|dasexperten|дас\s?экспертен|innoweiss|symbios|schwarz|termo|detox|ginger|grosse|zero|buddy|forall|mittel|cellike|hardhair)/i;
  if (brand.test(p)) return 'brand';
  if (/(splat|lacalut|r\.?o\.?c\.?s|parodontax|colgate|sensodyne|marvis|biorepair|bio neo)/i.test(p)) return 'competitor';
  if (/(своими руками|рецепт|сода|перекись|homemade|diy)/i.test(p)) return 'diy';
  return 'other';
}
const INTENT_META: Record<Intent, { label: string; color: string }> = {
  money:      { label: 'Money',      color: '#1B7A3D' },
  info:       { label: 'Info',       color: '#9A6700' },
  brand:      { label: 'Brand',      color: '#7C3AED' },
  competitor: { label: 'Competitor', color: '#B42318' },
  diy:        { label: 'DIY',        color: '#C2410C' },
  other:      { label: 'Other',      color: '#64748B' },
};

// ----- helpers ---------------------------------------------------------------
function fmtNum(n: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US').format(n);
}
function fmtPct(n: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return `${n.toFixed(2)}%`;
}
function fmtDate(unix: number | null): string {
  if (!unix) return '—';
  try {
    return new Date(unix * 1000).toISOString().slice(0, 19).replace('T', ' ');
  } catch {
    return '—';
  }
}
function timeAgo(unix: number | null): string {
  if (!unix) return 'never';
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Request failed (${res.status}) for ${path}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.errors?.[0]?.message ?? 'API error');
  return json.result as T;
}
function pctChange(curr: number, prev: number): { delta: string; up: boolean | null; tone: 'good' | 'bad' | 'flat' } {
  if (!prev || prev === 0) return { delta: '—', up: null, tone: 'flat' };
  const d = ((curr - prev) / prev) * 100;
  const sign = d >= 0 ? '+' : '';
  return {
    delta: `${sign}${d.toFixed(1)}%`,
    up: d >= 0,
    tone: d >= 0 ? 'good' : 'bad',
  };
}

// =============================================================================
// Main page
// =============================================================================
export default function AnalyticsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);

  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [sources90, setSources90] = useState<SourcePayload | null>(null);
  const [sources30, setSources30] = useState<SourcePayload | null>(null);
  const [phrases90, setPhrases90] = useState<PhrasePayload | null>(null);
  const [phrases30, setPhrases30] = useState<PhrasePayload | null>(null);
  const [mp, setMp] = useState<MpSummary | null>(null);

  const [windowSel, setWindowSel] = useState<'90' | '30'>('90');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const [s, src90, src30, ph90, ph30, mpSum] = await Promise.all([
          apiGet<StatsPayload>('/api/metrika/stats'),
          apiGet<SourcePayload>('/api/metrika/sources?days=90'),
          apiGet<SourcePayload>('/api/metrika/sources?days=30'),
          apiGet<PhrasePayload>('/api/metrika/phrases?days=90&limit=200'),
          apiGet<PhrasePayload>('/api/metrika/phrases?days=30&limit=100'),
          apiGet<MpSummary>('/api/analytics/marketplace-summary'),
        ]);
        if (cancelled) return;
        setStats(s);
        setSources90(src90);
        setSources30(src30);
        setPhrases90(ph90);
        setPhrases30(ph30);
        setMp(mpSum);
        setSyncedAt(Math.floor(Date.now() / 1000));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const curSrc = windowSel === '90' ? sources90 : sources30;
  const curPhr = windowSel === '90' ? phrases90 : phrases30;

  // today's KPI from stats
  const todayVisits = stats?.today?.visits ?? 0;
  // last 30d total
  const last30Visits = useMemo(
    () => (stats?.timeline ?? []).reduce((a, p) => a + (p.visits ?? 0), 0),
    [stats]
  );
  const src30Totals = sources30?.totals;
  const src90Totals = sources90?.totals;
  const mpUnitsTotal = useMemo(
    () => (mp?.marketplaces ?? []).reduce((a, m) => a + (m.fbo_units ?? 0), 0),
    [mp]
  );

  //////////////////////////////////////////////////////////////////////////////////
  return (
    <div className="space-y-8 max-w-7xl">
      {/* ============================ HEADER ============================ */}
      <div>
        <div className="dx-eyebrow mb-2">Cross-cutting dashboards</div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 900, color: 'var(--fg-1)' }}>
          SEO &amp; Marketplace Analytics
        </h1>
        <Text style={{ color: 'var(--fg-2)', marginTop: 4 }}>
          Live: Yandex Metrika (counter 107720199) + Ozon/WB FBO snapshots from D1.
          {' '}Baseline: 2026-06-11 audit · Latest: 2026-07-05 audit.
          {syncedAt && <Italic> · Synced {timeAgo(syncedAt)}</Italic>}
        </Text>
      </div>

      {error && (
        <Card decoration="top" decorationColor="red" style={{ borderColor: 'var(--border-subtle)' }}>
          <Text color="red" style={{ fontWeight: 600 }}>Load error: {error}</Text>
          <Text style={{ color: 'var(--fg-2)', marginTop: 4 }}>
            Check worker deployment and YANDEX_METRIKA_TOKEN secret on dasoperator-api.
          </Text>
        </Card>
      )}

      {/* ============================ KPI cards ============================ */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card decoration="left" decorationColor="slate" style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
          <Text style={{ color: 'var(--fg-2)' }}>Today visits</Text>
          <Metric style={{ color: 'var(--fg-1)' }}>{fmtNum(todayVisits)}</Metric>
        </Card>
        <Card decoration="left" decorationColor="indigo" style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
          <Text style={{ color: 'var(--fg-2)' }}>30d visits</Text>
          <Metric style={{ color: 'var(--fg-1)' }}>{fmtNum(last30Visits)}</Metric>
        </Card>
        <Card decoration="left" decorationColor="green" style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
          <Text style={{ color: 'var(--fg-2)' }}>30d purchases</Text>
          <Metric style={{ color: 'var(--fg-1)' }}>{fmtNum(src30Totals?.purchases ?? 0)}</Metric>
        </Card>
        <Card decoration="left" decorationColor="amber" style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
          <Text style={{ color: 'var(--fg-2)' }}>30d CR</Text>
          <Metric style={{ color: 'var(--fg-1)' }}>{fmtPct(src30Totals?.cr ?? 0)}</Metric>
        </Card>
        <Card decoration="left" decorationColor="rose" style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
          <Text style={{ color: 'var(--fg-2)' }}>MP FBO units</Text>
          <Metric style={{ color: 'var(--fg-1)' }}>{fmtNum(mpUnitsTotal)}</Metric>
        </Card>
      </div>

      {/* ============================ 30d visits timeline ============================ */}
      <Card style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
        <Title style={{ color: 'var(--fg-1)' }}>30-day visits timeline</Title>
        <Text style={{ color: 'var(--fg-2)', marginBottom: 12 }}>
          Yandex Metrika daily visits to dasexperten.ru — last 30 days.
        </Text>
        {stats && stats.timeline && stats.timeline.length > 0 ? (
          <AreaChart
            className="h-72 mt-2"
            data={stats.timeline}
            index="date"
            categories={['visits']}
            colors={['indigo']}
            valueFormatter={fmtNum}
            showAnimation={false}
          />
        ) : (
          <Text style={{ color: 'var(--fg-3)' }}>No timeline data.</Text>
        )}
      </Card>

      {/* ============================ Window toggle ============================ */}
      <Flex justifyContent="between" alignItems="center">
        <Title style={{ color: 'var(--fg-1)' }}>Traffic sources &amp; search phrases</Title>
        <div style={{ display: 'inline-flex', gap: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
          {(['90', '30'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setWindowSel(v)}
              style={{
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                background: windowSel === v ? 'var(--brand-schwarz)' : 'var(--paper-raised)',
                color: windowSel === v ? 'var(--paper)' : 'var(--fg-2)',
              }}
            >{v === '90' ? '90 days' : '30 days'}</button>
          ))}
        </div>
      </Flex>

      {/* ============================ Sources bar chart ============================ */}
      <Card style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
        <Title style={{ color: 'var(--fg-1)' }}>Visits by source</Title>
        <Text style={{ color: 'var(--fg-2)', marginBottom: 12 }}>
          {windowSel === '90' ? '90-day' : '30-day'} traffic source breakdown. Organic = Search engine traffic (the channel to feed).
        </Text>
        {curSrc && curSrc.rows && curSrc.rows.length > 0 ? (
          <BarChart
            className="h-72 mt-2"
            data={curSrc.rows.map(r => ({ source: r.source, visits: r.visits, purchases: r.purchases }))}
            index="source"
            categories={['visits', 'purchases']}
            colors={['slate', 'green']}
            valueFormatter={fmtNum}
            showAnimation={false}
            layout="vertical"
          />
        ) : (
          <Text style={{ color: 'var(--fg-3)' }}>No source data for this window.</Text>
        )}
      </Card>

      {/* ============================ Sources table ============================ */}
      <Card style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
        <Title style={{ color: 'var(--fg-1)' }}>Traffic sources — {windowSel === '90' ? '90d' : '30d'}</Title>
        <Table style={{ marginTop: 12 }}>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Source</TableHeaderCell>
              <TableHeaderCell>Visits</TableHeaderCell>
              <TableHeaderCell>Purchases</TableHeaderCell>
              <TableHeaderCell>CR</TableHeaderCell>
              <TableHeaderCell>% of total</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {curSrc && curSrc.rows && curSrc.rows.map((r) => {
              const total = curSrc.totals.visits || 1;
              const share = (r.visits / total) * 100;
              const isOrganic = /search engine/i.test(r.source);
              const isDirect = /direct/i.test(r.source);
              const accent = isOrganic ? 'emerald' : isDirect ? 'indigo' : 'slate';
              return (
                <TableRow key={r.source}>
                  <TableCell>
                    <Badge color={accent as any} size="xs">{r.source}</Badge>
                  </TableCell>
                  <TableCell><Bold>{fmtNum(r.visits)}</Bold></TableCell>
                  <TableCell>{fmtNum(r.purchases)}</TableCell>
                  <TableCell>
                    <span style={{ color: r.cr >= 4 ? '#1B7A3D' : r.cr >= 2 ? 'var(--fg-1)' : '#9A6700', fontWeight: 600 }}>
                      {fmtPct(r.cr)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Flex alignItems="center" justifyContent="start" style={{ gap: 8 }}>
                      <span style={{ minWidth: 36 }}>{share.toFixed(1)}%</span>
                      <ProgressBar value={share} color={accent as any} style={{ flex: 1 }} />
                    </Flex>
                  </TableCell>
                </TableRow>
              );
            })}
            {curSrc && curSrc.totals && (
              <TableRow style={{ borderTop: '2px solid var(--border-subtle)' }}>
                <TableCell><Bold>TOTAL</Bold></TableCell>
                <TableCell><Bold>{fmtNum(curSrc.totals.visits)}</Bold></TableCell>
                <TableCell><Bold>{fmtNum(curSrc.totals.purchases)}</Bold></TableCell>
                <TableCell><Bold>{fmtPct(curSrc.totals.cr)}</Bold></TableCell>
                <TableCell>100%</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {/* ============================ Top search phrases ============================ */}
      <Card style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
        <Title style={{ color: 'var(--fg-1)' }}>Top organic search phrases — {windowSel === '90' ? '90d' : '30d'}</Title>
        <Text style={{ color: 'var(--fg-2)', marginBottom: 12 }}>
          What buyers actually type in Yandex to reach dasexperten.ru. Intent badge = purchase / info / brand / competitor / DIY per Das Experten adaptation.
        </Text>
        <Table style={{ marginTop: 12 }}>
          <TableHead>
            <TableRow>
              <TableHeaderCell>#</TableHeaderCell>
              <TableHeaderCell>Phrase</TableHeaderCell>
              <TableHeaderCell>Visits</TableHeaderCell>
              <TableHeaderCell>Intent</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {curPhr && curPhr.rows && curPhr.rows.slice(0, 30).map((r, i) => {
              const intent = classifyIntent(r.phrase);
              const im = INTENT_META[intent];
              return (
                <TableRow key={r.phrase + i}>
                  <TableCell style={{ color: 'var(--fg-3)' }}>{i + 1}</TableCell>
                  <TableCell style={{ maxWidth: 480, wordBreak: 'break-word' }}>{r.phrase}</TableCell>
                  <TableCell><Bold>{fmtNum(r.visits)}</Bold></TableCell>
                  <TableCell>
                    <span style={{
                      background: `${im.color}15`,
                      color: im.color,
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600,
                    }}>{im.label}</span>
                  </TableCell>
                </TableRow>
              );
            })}
            {(!curPhr || !curPhr.rows || curPhr.rows.length === 0) && (
              <TableRow>
                <TableCell colSpan={4} style={{ color: 'var(--fg-3)' }}>No phrase data for this window.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {curPhr && curPhr.total_visits_with_phrase !== undefined && (
          <Text style={{ color: 'var(--fg-3)', marginTop: 8, fontSize: 12 }}>
            Metrika masked referrers — only {fmtNum(curPhr.total_visits_with_phrase)} of organic visits carry a search phrase.
          </Text>
        )}
      </Card>

      {/* ============================ Money cluster gap table ============================ */}
      <Card decoration="top" decorationColor="rose" style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
        <Title style={{ color: 'var(--fg-1)' }}>Money clusters without landing pages</Title>
        <Text style={{ color: 'var(--fg-2)', marginBottom: 12 }}>
          Audit debt from 2026-06-11 baseline + 2026-07-05 audit — 5 high-intent non-brand clusters already receive organic visits but have no dedicated landing (H1 = query). Highest-leverage SEO action.
        </Text>
        <Table style={{ marginTop: 12 }}>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Cluster</TableHeaderCell>
              <TableHeaderCell>Target query (RU)</TableHeaderCell>
              <TableHeaderCell>Target query (EN)</TableHeaderCell>
              <TableHeaderCell>SKU</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {MONEY_CLUSTERS.map((c) => (
              <TableRow key={c.cluster}>
                <TableCell><Bold>{c.cluster}</Bold></TableCell>
                <TableCell>{c.query_ru}</TableCell>
                <TableCell style={{ color: 'var(--fg-2)' }}>{c.query_en}</TableCell>
                <TableCell><Badge color="slate" size="xs">{c.sku}</Badge></TableCell>
                <TableCell>
                  <span style={{
                    background: '#FBE3E4',
                    color: '#B42318',
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 600,
                  }}>{c.status}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* ============================ Marketplace block ============================ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(mp?.marketplaces ?? []).map((m) => {
          const color = m.marketplace === 'ozon' ? '#005BFF' : '#CB11AB';
          const topSku = (mp?.top_sku ?? []).filter(s => s.marketplace === m.marketplace).slice(0, 5);
          return (
            <Card key={m.marketplace} decoration="left" decorationColor={m.marketplace === 'ozon' ? 'blue' : 'pink'} style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
              <Flex alignItems="center" justifyContent="between">
                <Title style={{ color: color, textTransform: 'uppercase', letterSpacing: 1 }}>{m.marketplace}</Title>
                <Text style={{ color: 'var(--fg-3)', fontSize: 11 }}>sync {timeAgo(m.last_finish ?? m.last_sync)}</Text>
              </Flex>
              <div className="grid grid-cols-3 gap-2 mt-3">
                <div>
                  <Text style={{ color: 'var(--fg-2)', fontSize: 11 }}>FBO units</Text>
                  <Metric style={{ color: 'var(--fg-1)', fontSize: 22 }}>{fmtNum(m.fbo_units)}</Metric>
                </div>
                <div>
                  <Text style={{ color: 'var(--fg-2)', fontSize: 11 }}>30d sales</Text>
                  <Metric style={{ color: 'var(--fg-1)', fontSize: 22 }}>{fmtNum(m.sales_30d)}</Metric>
                </div>
                <div>
                  <Text style={{ color: 'var(--fg-2)', fontSize: 11 }}>SKUs (stock / sales)</Text>
                  <Metric style={{ color: 'var(--fg-1)', fontSize: 22 }}>{m.sku_count_stock}/{m.sku_count_sales}</Metric>
                </div>
              </div>
              {topSku.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <Text style={{ color: 'var(--fg-2)', fontSize: 11, marginBottom: 4 }}>Top-5 SKU by 30d units</Text>
                  <Table>
                    <TableBody>
                      {topSku.map((s, i) => (
                        <TableRow key={s.base_sku}>
                          <TableCell style={{ color: 'var(--fg-3)', padding: '4px 0' }}>{i + 1}</TableCell>
                          <TableCell style={{ padding: '4px 8px' }}><Bold>{s.base_sku}</Bold></TableCell>
                          <TableCell style={{ padding: '4px 0', textAlign: 'right' }}>{fmtNum(s.units_30d)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Card>
          );
        })}
        {(!mp || mp.marketplaces.length === 0) && !loading && (
          <Card style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
            <Text style={{ color: 'var(--fg-3)' }}>No marketplace data. Sync may not have run yet — check /api/marketplaces/sync.</Text>
          </Card>
        )}
      </div>

      {/* ============================ Top-10 SKU across MPs ============================ */}
      {mp && mp.top_sku && mp.top_sku.length > 0 && (
        <Card style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-hairline)' }}>
          <Title style={{ color: 'var(--fg-1)' }}>Top-10 SKU across both marketplaces (30d units)</Title>
          <Table style={{ marginTop: 12 }}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>#</TableHeaderCell>
                <TableHeaderCell>SKU</TableHeaderCell>
                <TableHeaderCell>Marketplace</TableHeaderCell>
                <TableHeaderCell>30d units</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {mp.top_sku.map((s, i) => (
                <TableRow key={`${s.base_sku}-${s.marketplace}`}>
                  <TableCell style={{ color: 'var(--fg-3)' }}>{i + 1}</TableCell>
                  <TableCell><Bold>{s.base_sku}</Bold></TableCell>
                  <TableCell>
                    <span style={{ color: s.marketplace === 'ozon' ? '#005BFF' : '#CB11AB', fontWeight: 600 }}>
                      {s.marketplace.toUpperCase()}
                    </span>
                  </TableCell>
                  <TableCell>{fmtNum(s.units_30d)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {loading && (
        <Text style={{ color: 'var(--fg-3)' }}>Loading analytics…</Text>
      )}

      {/* ============================ Footer ============================ */}
      <div style={{ paddingTop: 16, borderTop: '1px solid var(--border-hairline)' }}>
        <Text style={{ color: 'var(--fg-3)', fontSize: 11 }}>
          Data sources: Yandex Metrika counter 107720199 (live OAuth) · D1 fbo_stocks_cluster + fbo_sales_cluster + marketplace_sync_log.
          {' '}Doctrine: Jono Catliff method (query = H1 = promise). Audit baseline 2026-06-11, latest 2026-07-05.
          {' '}Gap: Google Ads API (refresh_token invalid_grant — pending re-OAuth). Yandex Direct API (skeleton, not connected).
        </Text>
      </div>
    </div>
  );
}
