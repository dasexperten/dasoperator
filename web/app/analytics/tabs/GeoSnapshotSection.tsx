'use client';

// =============================================================================
// Nightly GEO snapshot — Julian Farah's own measurement, on the analytics page.
//
// Owner 2026-09-12: "why you do not add these last measurements in our analytics
// page in erp — do it". The snapshot writes six tables into the ORGANIZATION
// database every night at 00:45 UTC. The ERP has its own database, so those
// figures never reached this page: the tab below reads a KV drop and Ubersuggest.
//
// This section relays through the seat (/api/seo/geo-snapshot → julian-geo) and
// keeps NO copy in the ERP. A second set of the same numbers drifts from the
// first in silence, and then nobody knows which one is true.
//
// HARD: every block carries its OWN day — the edge series and Search Console
// ripen two to four days apart, and stamping them with one date would misreport
// both. An empty table shows its reason in words, never a zero: a zero is a
// measurement, and a missing measurement is not one.
// =============================================================================

import React from 'react';
import { useApi, fmtNum, Panel, LoadState, Kpi } from '../shared';

type Drift = { kind: 'pct'; pct: number; base: number } | { kind: 'small'; base: number } | null;

type Block = { day: string | null; reason?: string };

export type GeoSnapshot = {
  ok: boolean;
  source: string;
  computed_at: string;
  edge: Block & {
    requests?: number | null;
    err_4xx?: number | null;
    err_5xx?: number | null;
    err_5xx_pct?: number | null;
    requests_drift?: Drift;
    window_days?: number;
  };
  bots: Block & {
    families?: Array<{ family: string; label_ru: string; hits: number; hits_7d: number; ai: boolean }>;
  };
  answers: Block & {
    total?: number;
    ok?: number;
    moved?: number;
    failed?: number;
    failed_pct?: number | null;
  };
  /**
   * Дверь по-прежнему отдаёт битые адреса, а страница их не показывает
   * (Владелец 13.09.2026: «это надо решать»). Тип остаётся: утренний прогон
   * читает то же поле и закрывает каждый адрес — переездом на живого владельца
   * или ответом 410, если страницы больше нет.
   */
  broken: Block & {
    total_hits?: number;
    moved_hits?: number;
    paths?: Array<{ path: string; status: number; hits: number }>;
  };
  paths: Block & { window_days?: number; paths?: Array<{ path: string; hits: number }> };
  search: Block & {
    impressions?: number | null;
    clicks?: number | null;
    position?: number | null;
    ctr?: number | null;
    impressions_drift?: Drift;
    clicks_drift?: Drift;
    countries?: Array<{ key: string; impressions: number; clicks: number; position: number; ctr: number | null }>;
  };
  run: { last?: string | null; reason?: string; halves?: Array<{ half: string; ok: boolean; detail: string; at: string }> };
};

/** A drift the reader can act on. Below a base of 20 a percent lies loudly, so the base is named instead. */
function driftLabel(d: Drift, unit = ''): string {
  if (!d) return '';
  if (d.kind === 'pct') return `${d.pct > 0 ? '+' : ''}${d.pct}% vs ${fmtNum(d.base)}${unit} avg`;
  return `${fmtNum(d.base)}${unit} avg — too small for a percent`;
}

/** Blocks state their own day, so a stale half is visible instead of blending into a fresh one. */
function DayNote({ day, reason, extra }: { day: string | null; reason?: string; extra?: string }) {
  return (
    <p style={{ color: 'var(--fg-3)', marginTop: 8, fontSize: 12 }}>
      {day ? `Measured ${day}` : `Not measured — ${reason || 'no series'}`}
      {day && extra ? ` · ${extra}` : ''}
    </p>
  );
}

export default function GeoSnapshotSection() {
  const snap = useApi<GeoSnapshot>('/api/seo/geo-snapshot?limit=10');
  const d = snap.data;

  const nightOk = (d?.run?.halves ?? []).slice(0, 2).every((h) => h.ok);
  const families = d?.bots?.families ?? [];
  const crawled = d?.paths?.paths ?? [];
  const countries = d?.search?.countries ?? [];

  return (
    <div className="space-y-4">
      <LoadState loading={snap.loading} error={snap.error} />

      <div className="wa-note">
        Nightly snapshot, written 00:45 UTC into the organization database and read here on request —
        no copy is stored in the ERP. Cloudflare keeps only 8 days of edge data, so this series is the
        only long record of it. Search Console ripens 2–4 days later than the edge, so each block
        states its own day. Broken addresses are not listed here on purpose (Owner 2026-09-13): a
        repair list is work, not a view — each one is redirected to its live owner or answered 410
        when the page is gone, in the morning run.
      </div>

      {/* Владелец 13.09.2026: «этот OK... целый огромный блок ты даёшь под это —
          не нужно». Плитка снята. Строка остаётся ТОЛЬКО когда ночь не прошла:
          молчание — правильный отчёт спокойной ночи, а вот молчание о сорванном
          снимке превратило бы пустую страницу в спокойную.

          Форма — по решению Марики, второй заход приёмки. Плашка `wa-status`
          сюда не годится: она `nowrap` и капсом, то есть на два слова вроде OK,
          а тревога здесь — предложение с деталями половин, и на 390 px она уехала
          бы за край. Плита `wa-note` с тушью ошибки переносится и не капсит;
          прецедент на этой же странице — предупреждения FunnelTab, там та же плита
          с жёлтой тушью. Цвет только токеном (§4j): --status-error по --paper-sunk
          даёт 5.09:1 при пороге 4.5. Новых строк оформления 0.

          Условие смотрит на загруженный ответ, а не на наличие поля run: если поле
          пропадёт, блок обязан закричать, а не промолчать как в спокойную ночь. */}
      {d && !(d.run?.last && nightOk) && (
        <div className="wa-note" style={{ color: 'var(--status-error)', fontWeight: 700 }}>
          Snapshot did not complete —{' '}
          {d.run?.last
            ? (d.run.halves ?? []).filter((h) => !h.ok).map((h) => `${h.half}: ${h.detail}`).join(' · ')
            : d.run?.reason || 'no run log'}
        </div>
      )}

      {/* The edge: how much came, and how much of it we answered badly. */}
      {d?.edge && (
        <Panel title="Our edge · last measured day" source="Cloudflare zone analytics → D1">
          {d.edge.day ? (
            <>
              <div className="wa-kpis">
                <Kpi
                  label="Requests"
                  value={fmtNum(d.edge.requests ?? null)}
                  delta={driftLabel(d.edge.requests_drift ?? null)}
                />
                <Kpi label="4xx" value={fmtNum(d.edge.err_4xx ?? null)} delta="not found / gone" />
                <Kpi
                  label="5xx"
                  value={fmtNum(d.edge.err_5xx ?? null)}
                  delta={d.edge.err_5xx_pct != null ? `${d.edge.err_5xx_pct}% of requests` : ''}
                />
                <Kpi
                  label="AI bots refused"
                  value={d.answers?.failed != null ? fmtNum(d.answers.failed) : '—'}
                  delta={
                    d.answers?.failed_pct != null
                      ? `${d.answers.failed_pct}% of ${fmtNum(d.answers.total ?? 0)} · redirects excluded`
                      : ''
                  }
                />
              </div>
              <DayNote day={d.edge.day} extra={`drift against ${d.edge.window_days ?? 7} earlier days`} />
            </>
          ) : (
            <DayNote day={null} reason={d.edge.reason} />
          )}
        </Panel>
      )}

      {/* Who came. The families are the whole point of the seat: an assistant hit means a human asked now. */}
      <Panel title="Machines by family" source="julian-geo · geo_bot_daily">
        {families.length ? (
          <div className="wa-table-scroll">
            <table className="wa-table">
              <thead>
                <tr>
                  <th>Family</th>
                  <th>What it means</th>
                  <th className="right">Day</th>
                  <th className="right">7 days</th>
                </tr>
              </thead>
              <tbody>
                {families.map((f) => (
                  <tr key={f.family}>
                    <td style={{ fontWeight: f.ai ? 700 : 400 }}>{f.family}</td>
                    <td className="soft">{f.label_ru}</td>
                    <td className="num right">{fmtNum(f.hits)}</td>
                    <td className="num right soft">{fmtNum(f.hits_7d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <DayNote day={null} reason={d?.bots?.reason} />
        )}
        {d?.bots?.day && <DayNote day={d.bots.day} extra="bold = engines we are measured on" />}
      </Panel>

      {/* What they actually read. */}
      <Panel title="Pages AI engines pull · 7 days" source="julian-geo · geo_bot_paths">
        {crawled.length ? (
          <div className="wa-table-scroll">
            <table className="wa-table">
              <thead>
                <tr>
                  <th>Path</th>
                  <th className="right">Hits</th>
                </tr>
              </thead>
              <tbody>
                {crawled.map((p) => (
                  <tr key={p.path}>
                    <td>{p.path}</td>
                    <td className="num right">{fmtNum(p.hits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <DayNote day={null} reason={d?.paths?.reason} />
        )}
      </Panel>

      {/* Search, on its own day. */}
      {d?.search && (
        <Panel title="Search · last mature day" source="Search Console → D1">
          {d.search.day ? (
            <>
              <div className="wa-kpis">
                <Kpi
                  label="Impressions"
                  value={fmtNum(d.search.impressions ?? null)}
                  delta={driftLabel(d.search.impressions_drift ?? null)}
                />
                <Kpi
                  label="Clicks"
                  value={fmtNum(d.search.clicks ?? null)}
                  delta={driftLabel(d.search.clicks_drift ?? null)}
                />
                <Kpi label="Avg. position" value={d.search.position ?? '—'} delta="lower is better" />
                <Kpi label="CTR" value={d.search.ctr != null ? `${d.search.ctr}%` : '—'} delta="clicks per impression" />
              </div>
              {countries.length > 0 && (
                <div className="wa-table-scroll" style={{ marginTop: 12 }}>
                  <table className="wa-table">
                    <thead>
                      <tr>
                        <th>Market</th>
                        <th className="right">Impressions</th>
                        <th className="right">Clicks</th>
                        <th className="right">Position</th>
                        <th className="right">CTR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {countries.map((r) => (
                        <tr key={r.key}>
                          <td style={{ fontWeight: 700 }}>{r.key}</td>
                          <td className="num right">{fmtNum(r.impressions)}</td>
                          <td className="num right">{fmtNum(r.clicks)}</td>
                          <td className="num right soft">{r.position}</td>
                          {/* A market on page one with zero clicks is the seat's own standing finding:
                              the rank is there and the result is not chosen. It must stay visible. */}
                          <td className="num right">{r.ctr != null ? `${r.ctr}%` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <DayNote day={d.search.day} extra="markets over the last 7 days" />
            </>
          ) : (
            <DayNote day={null} reason={d.search.reason} />
          )}
        </Panel>
      )}
    </div>
  );
}
