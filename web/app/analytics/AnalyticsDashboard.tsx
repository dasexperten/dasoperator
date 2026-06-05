'use client';

import { useState } from 'react';
import {
  PERIOD, UPDATED, PLATFORMS, OZON_CAMPAIGNS, WB_SKUS,
  BLEEDERS, WINNERS, ACTIONS,
} from './data';

// ---- helpers ----------------------------------------------------------------
const RED = '#E5202C';
const GREEN = '#0E7C66';
const AMBER = '#C2700C';
const INK = 'var(--fg-1)';
const MUTED = 'var(--fg-2)';
const FAINT = 'var(--fg-3)';

const rub = (n: number) => Math.round(n).toLocaleString('ru-RU');
const k = (n: number) => (n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n));

function drrColor(d: number) {
  if (d <= 8) return GREEN;
  if (d <= 15) return AMBER;
  return RED;
}

// ---- generic card -----------------------------------------------------------
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: 'var(--bg-surface)', borderRadius: 16,
      boxShadow: 'var(--shadow-card)', padding: 20, ...style,
    }}>{children}</div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div style={{ font: '600 12px/1 var(--font-mono)', letterSpacing: '.08em', textTransform: 'uppercase', color: FAINT, marginBottom: 10 }}>{children}</div>;
}

// ---- KPI tile ---------------------------------------------------------------
function Kpi({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ font: '600 12px/1 var(--font-mono)', color: FAINT, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ font: '800 30px/1.05 var(--font-display)', color: color || INK, marginTop: 10, fontFeatureSettings: "'tnum' 1" }}>{value}</div>
      {sub && <div style={{ font: '500 13px/1.3 var(--font-sans)', color: MUTED, marginTop: 6 }}>{sub}</div>}
    </Card>
  );
}

// ---- donut (SVG) ------------------------------------------------------------
function Donut({ slices, center, sub }: { slices: { label: string; value: number; color: string }[]; center: string; sub: string }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const R = 64, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width={160} height={160} viewBox="0 0 160 160" style={{ flexShrink: 0 }}>
        <g transform="rotate(-90 80 80)">
          {slices.map((s, i) => {
            const frac = s.value / total;
            const dash = frac * C;
            const el = (
              <circle key={i} cx={80} cy={80} r={R} fill="none" stroke={s.color}
                strokeWidth={20} strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-acc} />
            );
            acc += dash;
            return el;
          })}
        </g>
        <text x={80} y={76} textAnchor="middle" style={{ font: '800 24px var(--font-display)', fill: INK }}>{center}</text>
        <text x={80} y={96} textAnchor="middle" style={{ font: '500 11px var(--font-mono)', fill: FAINT }}>{sub}</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 150 }}>
        {slices.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
            <span style={{ color: INK, flex: 1 }}>{s.label}</span>
            <span style={{ color: MUTED, fontFeatureSettings: "'tnum' 1" }}>{Math.round((s.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- horizontal bar row (spend) with ДРР badge ------------------------------
function BarRow({ name, spend, drr, max, orders }: { name: string; spend: number; drr: number; max: number; orders?: number }) {
  const w = Math.max(2, (spend / max) * 100);
  const col = drrColor(drr);
  return (
    <div style={{ marginBottom: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
        <span style={{ font: '600 13.5px var(--font-sans)', color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '64%' }}>{name}</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontFeatureSettings: "'tnum' 1" }}>
          <span style={{ font: '600 13px var(--font-mono)', color: MUTED }}>{rub(spend)} ₽</span>
          <span style={{ font: '700 12px var(--font-mono)', color: col, background: col + '18', padding: '2px 7px', borderRadius: 6, minWidth: 46, textAlign: 'center' }}>{drr}%</span>
        </span>
      </div>
      <div style={{ height: 9, background: 'var(--bg-sunk)', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ width: `${w}%`, height: '100%', background: col, borderRadius: 6, transition: 'width .6s' }} />
      </div>
    </div>
  );
}

// ---- insight table ----------------------------------------------------------
function InsightList({ items, tone }: { items: typeof BLEEDERS; tone: 'bad' | 'good' }) {
  const col = tone === 'bad' ? RED : GREEN;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, paddingBottom: 12, borderBottom: '1px solid var(--border-hairline)' }}>
          <div style={{ width: 4, borderRadius: 3, background: col, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <span style={{ font: '700 14px var(--font-sans)', color: INK }}>{it.sku}</span>
              <span style={{ font: '700 13px var(--font-mono)', color: col, flexShrink: 0, fontFeatureSettings: "'tnum' 1" }}>ДРР {it.drr}%</span>
            </div>
            <div style={{ display: 'flex', gap: 10, margin: '4px 0 5px', flexWrap: 'wrap' }}>
              <Tag>{it.plat}</Tag>
              <Tag>{rub(it.spend)} ₽</Tag>
              <Tag>CR {it.cr}%</Tag>
            </div>
            <div style={{ font: '400 13px/1.45 var(--font-sans)', color: MUTED }}>{it.note}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span style={{ font: '600 11px var(--font-mono)', color: FAINT, background: 'var(--bg-sunk)', padding: '2px 7px', borderRadius: 5, fontFeatureSettings: "'tnum' 1" }}>{children}</span>;
}

// ---- platform comparison hero card ------------------------------------------
function PlatformCard({ p }: { p: typeof PLATFORMS.ozon }) {
  const col = drrColor(p.drr);
  return (
    <Card style={{ padding: 22, position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, width: 4, height: '100%', background: p.accent }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ font: '800 19px var(--font-display)', color: INK }}>{p.name}</span>
        <span style={{ font: '600 12px var(--font-mono)', color: p.accent, background: p.accent + '14', padding: '4px 10px', borderRadius: 20 }}>реклама · 30 дней</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, marginBottom: 4 }}>
        <span style={{ font: '900 46px/0.9 var(--font-display)', color: col, fontFeatureSettings: "'tnum' 1" }}>{p.drr}%</span>
        <span style={{ font: '600 14px var(--font-sans)', color: MUTED, marginBottom: 7 }}>ДРР</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 16 }}>
        <Mini label="Расход" value={`${rub(p.spend)} ₽`} />
        <Mini label="Выручка" value={`${(p.revenue / 1e6).toFixed(2)} млн`} />
        <Mini label="Заказы" value={rub(p.orders)} />
      </div>
    </Card>
  );
}
function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ font: '600 11px var(--font-mono)', color: FAINT, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ font: '700 16px var(--font-sans)', color: INK, marginTop: 3, fontFeatureSettings: "'tnum' 1" }}>{value}</div>
    </div>
  );
}

// ---- action card ------------------------------------------------------------
const TONE: Record<string, { c: string; t: string }> = {
  stop: { c: RED, t: 'Выключить' },
  cut: { c: AMBER, t: 'Срезать' },
  scale: { c: GREEN, t: 'Масштабировать' },
};
function ActionCard({ a }: { a: typeof ACTIONS[number] }) {
  const tone = TONE[a.tone];
  return (
    <Card style={{ padding: 18, borderTop: `3px solid ${tone.c}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ font: '700 11px var(--font-mono)', color: tone.c, textTransform: 'uppercase', letterSpacing: '.06em' }}>{tone.t}</span>
        <span style={{ font: '700 13px var(--font-mono)', color: INK, background: tone.c + '14', padding: '3px 9px', borderRadius: 6 }}>{a.impact}</span>
      </div>
      <div style={{ font: '700 15px var(--font-sans)', color: INK, marginBottom: 6 }}>{a.title}</div>
      <div style={{ font: '400 13px/1.5 var(--font-sans)', color: MUTED }}>{a.body}</div>
    </Card>
  );
}

// ============================================================================
export default function AnalyticsDashboard() {
  const [tab, setTab] = useState<'ozon' | 'wb'>('ozon');
  const ozon = PLATFORMS.ozon, wb = PLATFORMS.wb;
  const totalSpend = ozon.spend + wb.spend;
  const totalRev = ozon.revenue + wb.revenue;
  const blendedDrr = (totalSpend / totalRev) * 100;

  const ozonMax = Math.max(...OZON_CAMPAIGNS.map(c => c.spend));
  const wbTop = WB_SKUS.slice(0, 12);
  const wbMax = Math.max(...wbTop.map(s => s.spend));

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 26 }}>
      {/* header */}
      <div>
        <div className="dx-eyebrow dx-eyebrow-rot" style={{ marginBottom: 6 }}>Маркетинговая аналитика</div>
        <h1 style={{ font: '900 var(--fs-display-md)/1 var(--font-display)', color: INK, margin: 0 }}>Реклама маркетплейсов</h1>
        <p style={{ font: '500 15px var(--font-sans)', color: MUTED, marginTop: 8 }}>
          Ozon Performance + WB Advert · период {PERIOD} · обновлено {UPDATED}
        </p>
      </div>

      {/* platform comparison + blended */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <PlatformCard p={ozon} />
        <PlatformCard p={wb} />
        <Card style={{ padding: 22, background: 'var(--bg-inverse)' }}>
          <div style={{ font: '600 12px var(--font-mono)', color: 'rgba(255,255,255,.55)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Суммарно · 2 площадки</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, margin: '10px 0 2px' }}>
            <span style={{ font: '900 46px/0.9 var(--font-display)', color: '#fff', fontFeatureSettings: "'tnum' 1" }}>{blendedDrr.toFixed(1)}%</span>
            <span style={{ font: '600 14px var(--font-sans)', color: 'rgba(255,255,255,.6)', marginBottom: 7 }}>сводный ДРР</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 16 }}>
            <div>
              <div style={{ font: '600 11px var(--font-mono)', color: 'rgba(255,255,255,.5)', textTransform: 'uppercase' }}>Расход</div>
              <div style={{ font: '700 16px var(--font-sans)', color: '#fff', marginTop: 3, fontFeatureSettings: "'tnum' 1" }}>{rub(totalSpend)} ₽</div>
            </div>
            <div>
              <div style={{ font: '600 11px var(--font-mono)', color: 'rgba(255,255,255,.5)', textTransform: 'uppercase' }}>Выручка</div>
              <div style={{ font: '700 16px var(--font-sans)', color: '#fff', marginTop: 3, fontFeatureSettings: "'tnum' 1" }}>{(totalRev / 1e6).toFixed(2)} млн ₽</div>
            </div>
          </div>
        </Card>
      </div>

      {/* key takeaway banner */}
      <Card style={{ padding: '16px 20px', background: 'linear-gradient(90deg, var(--bg-surface), var(--bg-sunk))', display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 22, lineHeight: 1 }}>💡</span>
        <div style={{ font: '500 14.5px/1.55 var(--font-sans)', color: INK }}>
          <b>Бюджет перевёрнут.</b> Пасты и нити конвертят на 12–54% при ДРР 4–13%, а часть щёток — на 0,4–10% при ДРР 20–141%.
          При этом самые дорогие кампании — именно щётки. Платим больше всего за то, что продаётся хуже всего.
          WB-реклама (ДРР 15%) почти вдвое дороже Ozon (8,6%).
        </div>
      </Card>

      {/* tabs */}
      <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--border-hairline)' }}>
        {([['ozon', 'Ozon'], ['wb', 'Wildberries']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{
              appearance: 'none', border: 'none', background: 'none', cursor: 'pointer',
              padding: '10px 16px', font: '700 15px var(--font-sans)',
              color: tab === key ? INK : FAINT,
              borderBottom: tab === key ? `2px solid ${RED}` : '2px solid transparent',
              marginBottom: -1,
            }}>{label}</button>
        ))}
      </div>

      {/* per-platform body */}
      {tab === 'ozon' ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: 14 }}>
            <Kpi label="Расход" value={`${rub(ozon.spend)} ₽`} />
            <Kpi label="Выручка с рекламы" value={`${(ozon.revenue / 1e6).toFixed(2)} млн ₽`} />
            <Kpi label="ДРР" value={`${ozon.drr}%`} color={drrColor(ozon.drr)} sub="здоровый уровень" />
            <Kpi label="Заказы" value={rub(ozon.orders)} sub="8 активных кампаний из 178" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.55fr) minmax(0,1fr)', gap: 16 }}>
            <Card>
              <Eyebrow>Расход и ДРР по кампаниям</Eyebrow>
              {OZON_CAMPAIGNS.map((c, i) => <BarRow key={i} name={c.name} spend={c.spend} drr={c.drr} max={ozonMax} />)}
            </Card>
            <Card>
              <Eyebrow>Распределение расхода</Eyebrow>
              <Donut center={`${k(ozon.spend)}`} sub="₽ / 30 дн"
                slices={[
                  { label: 'Щётки (трафареты)', value: 92956, color: RED },
                  { label: 'Четвёрки ТОП', value: 64808, color: AMBER },
                  { label: 'Пасты', value: 199620, color: GREEN },
                  { label: 'Нити / прочее', value: 34383, color: '#0B7BC4' },
                ]} />
              <p style={{ font: '400 13px/1.5 var(--font-sans)', color: MUTED, marginTop: 16 }}>
                «Трафареты Щётки» — самая дорогая кампания (24% расхода) и худший ДРР 15,5%. Пасты в сумме дают вдвое больше выручки при ДРР 6–7%.
              </p>
            </Card>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: 14 }}>
            <Kpi label="Расход" value={`${rub(wb.spend)} ₽`} />
            <Kpi label="Выручка с рекламы" value={`${(wb.revenue / 1e6).toFixed(2)} млн ₽`} />
            <Kpi label="ДРР" value={`${wb.drr}%`} color={drrColor(wb.drr)} sub="дорого — почти ×2 к Ozon" />
            <Kpi label="Заказы" value={rub(wb.orders)} sub={`${rub(wb.clicks)} кликов`} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.55fr) minmax(0,1fr)', gap: 16 }}>
            <Card>
              <Eyebrow>Топ-12 SKU по расходу · ДРР</Eyebrow>
              {wbTop.map((s, i) => <BarRow key={i} name={s.name} spend={s.spend} drr={s.drr} max={wbMax} />)}
            </Card>
            <Card>
              <Eyebrow>Расход: щётки vs пасты/нити</Eyebrow>
              <Donut center={`${k(wb.spend)}`} sub="₽ / 30 дн"
                slices={[
                  { label: 'Щётки', value: 161403, color: RED },
                  { label: 'Пасты', value: 131177, color: GREEN },
                  { label: 'Нити / ёршики', value: 49321, color: '#0B7BC4' },
                  { label: 'Прочее', value: 29840, color: AMBER },
                ]} />
              <p style={{ font: '400 13px/1.5 var(--font-sans)', color: MUTED, marginTop: 16 }}>
                Щётки — 43% бюджета WB и почти все аутсайдеры по ДРР (AKTIV 141%, KINDER 60%, MITTEL 21%). Пасты и нити держат ДРР 5–13%.
              </p>
            </Card>
          </div>
        </>
      )}

      {/* cross-platform insights */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px,1fr))', gap: 16 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: RED }} />
            <span style={{ font: '800 16px var(--font-display)', color: INK }}>Где горит — резать</span>
          </div>
          <InsightList items={BLEEDERS} tone="bad" />
        </Card>
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: GREEN }} />
            <span style={{ font: '800 16px var(--font-display)', color: INK }}>Где недоливаем — масштабировать</span>
          </div>
          <InsightList items={WINNERS} tone="good" />
        </Card>
      </div>

      {/* action plan */}
      <div>
        <h2 style={{ font: '900 var(--fs-h2)/1 var(--font-display)', color: INK, margin: '0 0 4px' }}>План действий</h2>
        <p style={{ font: '500 14px var(--font-sans)', color: MUTED, margin: '0 0 16px' }}>Порядок = по отдаче. Цель: ДРР Ozon 8,6→~7%, WB 15→~11%, выручка растёт.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px,1fr))', gap: 14 }}>
          {ACTIONS.map((a, i) => <ActionCard key={i} a={a} />)}
        </div>
      </div>

      <div style={{ font: '500 12px var(--font-mono)', color: FAINT, textAlign: 'center', padding: '8px 0 4px' }}>
        Источник: Ozon Performance API · WB Advert API (v3 fullstats) · окно 30 дней · ДРР = расход / выручка с рекламы
      </div>
    </div>
  );
}
