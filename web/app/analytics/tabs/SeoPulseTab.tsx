'use client';

// =============================================================================
// Search & Sales RU tab — Jurgen's daily run, as the seat wrote it.
//   seo_daily_pulse   eight numbers per day: Yandex Webmaster (search) +
//                     Metrika 107720199 (purchases, revenue in RUBLES, not kopecks)
//   agent_questions   questions the seats put to the Owner, open until answered
// Owner 2026-09-23: the job wrote both tables from 2026-08-25, but no screen read
// them, so the ERP looked frozen (HARD_RULES §0i). Read-only: the ERP shows, the
// seat writes. HARD RULE 4: absent table or empty day = honest empty state.
// =============================================================================

import React from 'react';
import { useApi, fmtNum, fmtPct, Kpi, Panel, LoadState } from '../shared';

type D1Rows = {
  table_exists: boolean;
  columns: string[];
  rows: Array<Record<string, unknown>>;
};

const PULSE_COLUMNS: Array<{ key: string; label: string; kind: 'int' | 'pos' | 'rub' | 'pct' }> = [
  { key: 'wm_pages_in_search', label: 'Pages in Yandex', kind: 'int' },
  { key: 'wm_shows', label: 'Impressions', kind: 'int' },
  { key: 'wm_clicks', label: 'Clicks', kind: 'int' },
  { key: 'wm_avg_position', label: 'Avg position', kind: 'pos' },
  { key: 'mx_purchases', label: 'Purchases', kind: 'int' },
  { key: 'mx_revenue_rub', label: 'Revenue', kind: 'rub' },
  { key: 'mx_avg_check_rub', label: 'Avg check', kind: 'rub' },
  { key: 'mx_conversion_pct', label: 'Conversion', kind: 'pct' },
];

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtRub(n: number | null): string {
  if (n === null) return '—';
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n);
}

function fmtCell(v: unknown, kind: 'int' | 'pos' | 'rub' | 'pct'): string {
  const n = num(v);
  if (kind === 'rub') return fmtRub(n);
  if (kind === 'pct') return fmtPct(n);
  if (kind === 'pos') return n === null ? '—' : n.toFixed(1);
  return fmtNum(n);
}

function text(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function statusTone(status: string): string {
  if (status === 'open') return 'warn';
  if (status === 'answered') return 'ok';
  return 'off';
}

export default function SeoPulseTab() {
  const pulse = useApi<D1Rows>('/api/seo/daily-pulse?days=30');
  const questions = useApi<D1Rows>('/api/seo/agent-questions?limit=100');

  const rows = pulse.data?.rows ?? [];
  const latest = rows[0];
  const shown = PULSE_COLUMNS.filter((c) => pulse.data?.columns.includes(c.key));
  const qRows = [...(questions.data?.rows ?? [])].sort(
    (a, b) => Number(text(b.status) === 'open') - Number(text(a.status) === 'open'),
  );
  const openCount = qRows.filter((q) => text(q.status) === 'open').length;

  return (
    <div className="space-y-4">
      <Panel
        title="Search & sales — latest day"
        source="Jurgen daily run · Yandex Webmaster + Metrika 107720199"
      >
        <LoadState loading={pulse.loading} error={pulse.error} />
        {pulse.data && !pulse.data.table_exists && (
          <span className="wa-status rot"><span className="dot" />table seo_daily_pulse not found in ERP database</span>
        )}
        {pulse.data?.table_exists && !latest && (
          <p style={{ color: 'var(--fg-3)' }}>No day written yet.</p>
        )}
        {latest && (
          <>
            <p style={{ color: 'var(--fg-2)', marginBottom: 12 }}>
              Day <b>{text(latest.day)}</b>
              {latest.data_asof ? <> · numbers complete as of <b>{text(latest.data_asof)}</b></> : null}
            </p>
            <div className="wa-kpis">
              {shown.map((c, i) => (
                <Kpi key={c.key} label={c.label} value={fmtCell(latest[c.key], c.kind)} accent={i === 5} />
              ))}
            </div>
            {latest.note ? (
              <p style={{ color: 'var(--fg-2)', marginTop: 12 }}>{text(latest.note)}</p>
            ) : null}
          </>
        )}
      </Panel>

      <Panel title={`Daily pulse — last ${rows.length || 30} days`} source="D1 seo_daily_pulse" pad={false}>
        {rows.length > 0 ? (
          <div className="wa-table-scroll">
            <table className="wa-table">
              <thead>
                <tr>
                  <th>Day</th>
                  {shown.map((c) => <th key={c.key} className="right">{c.label}</th>)}
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={text(r.day)}>
                    <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{text(r.day)}</td>
                    {shown.map((c) => (
                      <td key={c.key} className="num right" style={{ whiteSpace: 'nowrap' }}>{fmtCell(r[c.key], c.kind)}</td>
                    ))}
                    <td style={{ color: 'var(--fg-2)', minWidth: 240 }}>{text(r.note)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="wa-panel-body"><LoadState loading={pulse.loading} error={pulse.error} /></div>
        )}
      </Panel>

      <Panel
        title="Questions to the Owner"
        source="D1 agent_questions"
        right={questions.data?.table_exists ? (
          <span className={`wa-status ${openCount ? 'warn' : 'ok'}`}><span className="dot" />{openCount} open</span>
        ) : undefined}
      >
        <LoadState loading={questions.loading} error={questions.error} />
        {questions.data && !questions.data.table_exists && (
          <span className="wa-status rot"><span className="dot" />table agent_questions not found in ERP database</span>
        )}
        {questions.data?.table_exists && qRows.length === 0 && (
          <p style={{ color: 'var(--fg-3)' }}>No questions written yet.</p>
        )}
        <div className="space-y-4">
          {qRows.map((q, i) => (
            <div key={text(q.id) || i} style={{ borderTop: i ? '1px solid var(--border-hairline)' : undefined, paddingTop: i ? 16 : 0 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                <span className={`wa-status ${statusTone(text(q.status))}`}><span className="dot" />{text(q.status) || 'unknown'}</span>
                <span style={{ color: 'var(--fg-3)' }}>{text(q.day)}{q.agent_slug ? ` · ${text(q.agent_slug)}` : ''}</span>
              </div>
              <p style={{ fontWeight: 700 }}>{text(q.question)}</p>
              {q.context ? <p style={{ color: 'var(--fg-2)', marginTop: 4 }}>{text(q.context)}</p> : null}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
