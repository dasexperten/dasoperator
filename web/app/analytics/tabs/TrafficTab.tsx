'use client';

// =============================================================================
// Traffic & Sources tab.
//   Block 1: GA4 channel groups + landing pages (global .com contour)
//   Block 2: Yandex Metrika sources + search phrases (RU contour — KEPT from
//            the original page, labelled; incl. money-cluster gap table)
// The two contours see different traffic (geo + consent + sampling) and are
// never blended (HARD RULE 3).
// =============================================================================

import React, { useState } from 'react';
import { BarChart } from '@tremor/react';
import {
  useApi, fmtNum, fmtPct, fmtMoney, timeAgo,
  Panel, LoadState, ChartLegend,
  type Ga4Channels, type Ga4Pages, type MetrikaSources, type MetrikaPhrases,
} from '../shared';

// ----- intent classifier (das-adaptation §1 — ported from the original page) --
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
const INTENT_META: Record<Intent, { label: string; cls: string }> = {
  money: { label: 'Money', cls: 'ok' },
  info: { label: 'Info', cls: 'warn' },
  brand: { label: 'Brand', cls: 'off' },
  competitor: { label: 'Competitor', cls: 'rot' },
  diy: { label: 'DIY', cls: 'warn' },
  other: { label: 'Other', cls: 'off' },
};

// ----- money clusters without landings (audit debt, per Aram's decision) ------
const MONEY_CLUSTERS = [
  { cluster: 'Энзимная паста', query_ru: 'ферментная зубная паста', query_en: 'enzyme toothpaste', sku: 'INNOWEISS' },
  { cluster: 'Пробиотическая паста', query_ru: 'пробиотическая зубная паста', query_en: 'probiotic toothpaste', sku: 'SYMBIOS' },
  { cluster: 'Charcoal', query_ru: 'угольная зубная паста', query_en: 'charcoal toothpaste', sku: 'SCHWARZ' },
  { cluster: 'Clean-label / без фтора', query_ru: 'зубная паста без фтора', query_en: 'fluoride-free toothpaste', sku: 'DETOX / BIO' },
  { cluster: 'Ершики для брекетов', query_ru: 'межзубные ершики для брекетов', query_en: 'interdental brushes braces', sku: 'MITTEL' },
];

export default function TrafficTab() {
  const [win, setWin] = useState<'90' | '30'>('30');
  const channels = useApi<Ga4Channels>('/api/ga4/channels?days=30');
  const pages = useApi<Ga4Pages>('/api/ga4/pages?days=30&limit=25');
  const sources = useApi<MetrikaSources>(`/api/metrika/sources?days=${win}`);
  const phrases = useApi<MetrikaPhrases>(`/api/metrika/phrases?days=${win}&limit=100`);

  return (
    <div className="space-y-4">
      {/* ============ GA4 — global contour ============ */}
      <Panel title="Channels — sessions & purchases" source="GA4 · dasexperten.com" pad={false}>
        <div className="wa-panel-body">
          <LoadState loading={channels.loading} error={channels.error} />
          {channels.data && channels.data.rows.length > 0 && (
            <div className="wa-chart">
              <ChartLegend items={[
                { label: 'sessions', color: 'var(--stone-500)' },
                { label: 'purchases', color: 'var(--brand-rot)' },
              ]} />
              <BarChart
                className="h-64"
                data={channels.data.rows.map((r) => ({ channel: r.channel, sessions: r.sessions, purchases: r.purchases }))}
                index="channel"
                categories={['sessions', 'purchases']}
                colors={['stone', 'red']}
                valueFormatter={fmtNum}
                showAnimation={false}
                showLegend={false}
                yAxisWidth={120}
                layout="vertical"
              />
            </div>
          )}
        </div>
        {channels.data && (
          <div className="wa-table-scroll">
            <table className="wa-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th className="right">Sessions</th>
                  <th className="right">Users</th>
                  <th className="right">Purchases</th>
                  <th className="right">Revenue</th>
                  <th className="right">CR</th>
                </tr>
              </thead>
              <tbody>
                {channels.data.rows.map((r) => (
                  <tr key={r.channel}>
                    <td style={{ fontWeight: 700 }}>{r.channel}</td>
                    <td className="num right">{fmtNum(r.sessions)}</td>
                    <td className="num right soft">{fmtNum(r.users)}</td>
                    <td className="num right">{fmtNum(r.purchases)}</td>
                    <td className="num right">{fmtMoney(r.revenue)}</td>
                    <td className="num right">{fmtPct(r.cr)}</td>
                  </tr>
                ))}
                <tr style={{ background: 'var(--paper-sunk)' }}>
                  <td style={{ fontWeight: 700 }}>TOTAL · {channels.data.window_days}d</td>
                  <td className="num right" style={{ fontWeight: 700 }}>{fmtNum(channels.data.totals.sessions)}</td>
                  <td className="num right soft">{fmtNum(channels.data.totals.users)}</td>
                  <td className="num right" style={{ fontWeight: 700 }}>{fmtNum(channels.data.totals.purchases)}</td>
                  <td className="num right">{fmtMoney(channels.data.totals.revenue)}</td>
                  <td className="num right">{fmtPct(channels.data.totals.cr)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Landing pages" source="GA4 · dasexperten.com" pad={false}>
        <div className="wa-table-scroll">
          <table className="wa-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Landing page</th>
                <th className="right">Sessions</th>
                <th className="right">Purchases</th>
                <th className="right">CR</th>
              </tr>
            </thead>
            <tbody>
              {(pages.data?.rows ?? []).slice(0, 25).map((r, i) => (
                <tr key={r.page + i}>
                  <td style={{ color: 'var(--fg-3)' }}>{i + 1}</td>
                  <td style={{ wordBreak: 'break-all', maxWidth: 420 }}>{r.page}</td>
                  <td className="num right">{fmtNum(r.sessions)}</td>
                  <td className="num right">{fmtNum(r.purchases)}</td>
                  <td className="num right">{fmtPct(r.cr)}</td>
                </tr>
              ))}
              {!pages.loading && (pages.data?.rows ?? []).length === 0 && (
                <tr><td colSpan={5} style={{ color: 'var(--fg-3)' }}>No landing-page data.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ============ Metrika — RU contour (kept, labelled) ============ */}
      <div className="wa-panel">
        <div className="wa-panel-head">
          <h3>Traffic sources — RU contour</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="wa-toggle" role="group" aria-label="Metrika window">
              {(['90', '30'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setWin(v)}
                  className={win === v ? 'active' : ''}
                  aria-pressed={win === v}
                >{v}d</button>
              ))}
            </div>
            <span className="wa-source"><span className="dot" />Yandex Metrika 107720199 · dasexperten.ru</span>
          </div>
        </div>
        <div className="wa-table-scroll">
          <table className="wa-table">
            <thead>
              <tr>
                <th>Source</th>
                <th className="right">Visits</th>
                <th className="right">Purchases</th>
                <th className="right">CR</th>
                <th className="right">% of total</th>
              </tr>
            </thead>
            <tbody>
              {(sources.data?.rows ?? []).map((r) => {
                const total = sources.data?.totals.visits || 1;
                return (
                  <tr key={r.source}>
                    <td style={{ fontWeight: 700 }}>{r.source}</td>
                    <td className="num right">{fmtNum(r.visits)}</td>
                    <td className="num right">{fmtNum(r.purchases)}</td>
                    <td className="num right">{fmtPct(r.cr)}</td>
                    <td className="num right soft">{((r.visits / total) * 100).toFixed(1)}%</td>
                  </tr>
                );
              })}
              {sources.data && (
                <tr style={{ background: 'var(--paper-sunk)' }}>
                  <td style={{ fontWeight: 700 }}>TOTAL · {sources.data.window_days}d</td>
                  <td className="num right" style={{ fontWeight: 700 }}>{fmtNum(sources.data.totals.visits)}</td>
                  <td className="num right" style={{ fontWeight: 700 }}>{fmtNum(sources.data.totals.purchases)}</td>
                  <td className="num right">{fmtPct(sources.data.totals.cr)}</td>
                  <td className="num right soft">100%</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="wa-panel-body">
          <div className="wa-note">
            RU contour = dasexperten.ru (~4 visits/day). The GA4 tables above are the .com global
            contour. Different counters, different consent + geo — numbers are never merged.
          </div>
        </div>
      </div>

      <Panel title={`Top organic search phrases — ${win}d`} source="Yandex Metrika · RU contour" pad={false}>
        <div className="wa-table-scroll">
          <table className="wa-table">
            <thead>
              <tr><th>#</th><th>Phrase</th><th className="right">Visits</th><th>Intent</th></tr>
            </thead>
            <tbody>
              {(phrases.data?.rows ?? []).slice(0, 30).map((r, i) => {
                const im = INTENT_META[classifyIntent(r.phrase)];
                return (
                  <tr key={r.phrase + i}>
                    <td style={{ color: 'var(--fg-3)' }}>{i + 1}</td>
                    <td style={{ maxWidth: 460, wordBreak: 'break-word' }}>{r.phrase}</td>
                    <td className="num right">{fmtNum(r.visits)}</td>
                    <td><span className={`wa-status ${im.cls}`}><span className="dot" />{im.label}</span></td>
                  </tr>
                );
              })}
              {!phrases.loading && (phrases.data?.rows ?? []).length === 0 && (
                <tr><td colSpan={4} style={{ color: 'var(--fg-3)' }}>No phrase data for this window.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {phrases.data && (
          <div className="wa-panel-body">
            <div className="wa-note">
              Metrika masks most referrers — only {fmtNum(phrases.data.total_visits_with_phrase)} organic
              visits carry a phrase. Synced {timeAgo(phrases.data.synced_at)}.
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Money clusters without landing pages" source="Audit 2026-06-11 → 2026-07-05" pad={false}>
        <div className="wa-table-scroll">
          <table className="wa-table">
            <thead>
              <tr><th>Cluster</th><th>Target query (RU)</th><th>Target query (EN)</th><th>SKU</th><th>Status</th></tr>
            </thead>
            <tbody>
              {MONEY_CLUSTERS.map((c) => (
                <tr key={c.cluster}>
                  <td style={{ fontWeight: 700 }}>{c.cluster}</td>
                  <td>{c.query_ru}</td>
                  <td style={{ color: 'var(--fg-2)' }}>{c.query_en}</td>
                  <td className="num soft">{c.sku}</td>
                  <td><span className="wa-status rot"><span className="dot" />no landing</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="wa-panel-body">
          <div className="wa-note">
            5 high-intent non-brand clusters already receive organic visits but have no dedicated
            landing (query = H1 = promise). Highest-leverage SEO action — doctrine: Jono Catliff method.
          </div>
        </div>
      </Panel>
    </div>
  );
}
