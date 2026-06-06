// =============================================================================
// Marketplace ad analytics ETL — Ozon Performance + WB Advert → analytics.json
// Run daily in CI. Reads credentials from env (never hardcoded):
//   OZON_PERF_CLIENT_ID, OZON_PERF_CLIENT_SECRET   (Ozon Performance OAuth)
//   WB_API_TOKEN                                    (WB Advert JWT)
// Output: analytics.json (rolling 30-day window ending yesterday).
// Fails loud on auth/HTTP errors so the cron never publishes partial data.
// =============================================================================
import fs from 'fs';

const OUT = process.argv[2] || 'analytics.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => (typeof s === 'number' ? s : parseFloat(String(s ?? '0').replace(/\s/g, '').replace(',', '.')) || 0);

// ---- date window: last 30 full days ----------------------------------------
function isoDay(d) { return d.toISOString().slice(0, 10); }
const today = new Date();
const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
const begin = new Date(end); begin.setUTCDate(end.getUTCDate() - 29);
const DATE_FROM = isoDay(begin), DATE_TO = isoDay(end);
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const ruDate = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

// ---- classification by product name ----------------------------------------
function category(name) {
  const n = (name || '').toLowerCase();
  if (/нить|нит|ёршик|ершик|ерш|interdental|floss|expanding/.test(n)) return 'Нити / ёршики';
  if (/щётк|щетк|brush|zunger|скреб|zero|grosse|schwarz|etalon|nano|kinder|mittel|kraft|aktiv|intensiv|bio/.test(n)) return 'Щётки';
  if (/паст|paste|gel|гел|symbios|detox|innoweiss|ginger|термо|termo|ополаск/.test(n)) return 'Пасты';
  return 'Прочее';
}
const CAT_COLOR = { 'Щётки': '#E5202C', 'Пасты': '#0E7C66', 'Нити / ёршики': '#0B7BC4', 'Прочее': '#C2700C' };

// =============================================================================
// OZON
// =============================================================================
async function ozon() {
  const cid = process.env.OZON_PERF_CLIENT_ID, csec = process.env.OZON_PERF_CLIENT_SECRET;
  if (!cid || !csec) throw new Error('Ozon Performance creds missing in env');
  const base = 'https://api-performance.ozon.ru';
  const tr = await fetch(base + '/api/client/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cid, client_secret: csec, grant_type: 'client_credentials' }),
  });
  const td = await tr.json();
  if (!td.access_token) throw new Error('Ozon token failed: ' + JSON.stringify(td).slice(0, 200));
  const H = { Authorization: 'Bearer ' + td.access_token, 'Content-Type': 'application/json' };

  // campaign-level daily stats (instant). Returns rows for all campaigns.
  const dr = await fetch(`${base}/api/client/statistics/daily/json?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`, { headers: H });
  if (dr.status !== 200) throw new Error('Ozon daily/json ' + dr.status);
  const drows = (await dr.json()).rows || [];
  const byC = {};
  for (const x of drows) {
    const c = (byC[x.id] ||= { id: x.id, title: x.title, spend: 0, rev: 0, orders: 0 });
    c.spend += num(x.moneySpent); c.rev += num(x.ordersMoney); c.orders += num(x.orders);
  }
  const camps = Object.values(byC).filter((c) => c.spend > 1).sort((a, b) => b.spend - a.spend);
  const totSpend = camps.reduce((s, c) => s + c.spend, 0);
  const totRev = camps.reduce((s, c) => s + c.rev, 0);
  const totOrd = camps.reduce((s, c) => s + c.orders, 0);

  const ozonCampaigns = camps.map((c) => ({
    name: (c.title || '').replace(/Кампания.*?№\s*\d+/i, '').trim() || `#${c.id}`,
    spend: Math.round(c.spend), drr: totDrr(c.spend, c.rev), orders: Math.round(c.orders),
  }));

  // per-SKU async report for spending campaigns (bleeders/winners + donut)
  let skuRows = [];
  try { skuRows = await ozonSkuReport(base, H, camps.map((c) => String(c.id))); }
  catch (e) { console.error('Ozon SKU report skipped:', e.message); }

  return {
    platform: { spend: Math.round(totSpend), revenue: Math.round(totRev), drr: totDrr(totSpend, totRev), orders: Math.round(totOrd), clicks: 0 },
    ozonCampaigns, skuRows,
  };
}

async function ozonSkuReport(base, H, ids) {
  const body = { campaigns: ids, from: `${DATE_FROM}T00:00:00.000Z`, to: `${DATE_TO}T23:59:59.000Z`, groupBy: 'NO_GROUP_BY' };
  const sub = await fetch(base + '/api/client/statistics/json', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const uuid = (await sub.json()).UUID;
  if (!uuid) throw new Error('no report UUID');
  for (let i = 0; i < 50; i++) {
    await sleep(8000);
    const st = await (await fetch(`${base}/api/client/statistics/${uuid}`, { headers: H })).json();
    if (st.state === 'OK') break;
    if (st.state === 'ERROR') throw new Error('report ERROR');
    if (i === 49) throw new Error('report timeout');
  }
  const rep = await (await fetch(`${base}/api/client/statistics/report?UUID=${uuid}`, { headers: H })).text();
  const j = JSON.parse(rep);
  const sku = {};
  for (const cid of Object.keys(j)) {
    for (const r of (j[cid].report?.rows || [])) {
      const k = r.sku; const s = (sku[k] ||= { title: r.title, spend: 0, rev: 0, clicks: 0, orders: 0 });
      s.spend += num(r.moneySpent); s.rev += num(r.ordersMoney); s.clicks += num(r.clicks); s.orders += num(r.orders);
      if (r.title && !s.title) s.title = r.title;
    }
  }
  return Object.values(sku);
}

// =============================================================================
// WILDBERRIES
// =============================================================================
async function wb() {
  const T = process.env.WB_API_TOKEN;
  if (!T) throw new Error('WB_API_TOKEN missing in env');
  const cnt = await fetch('https://advert-api.wildberries.ru/adv/v1/promotion/count', { headers: { Authorization: T } });
  if (cnt.status !== 200) throw new Error('WB count ' + cnt.status);
  const ids = [];
  for (const g of ((await cnt.json()).adverts || [])) for (const a of (g.advert_list || [])) ids.push(a.advertId);

  const res = [];
  const batches = []; for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));
  for (let b = 0; b < batches.length; b++) {
    if (b > 0) await sleep(65000); // WB fullstats: ~1 req/min
    const qs = `ids=${batches[b].join(',')}&beginDate=${DATE_FROM}&endDate=${DATE_TO}`;
    let ok = false;
    for (let attempt = 0; attempt < 6 && !ok; attempt++) {
      const r = await fetch('https://advert-api.wildberries.ru/adv/v3/fullstats?' + qs, { headers: { Authorization: T } });
      if (r.status === 429) { await sleep(65000); continue; }
      if (r.status !== 200) throw new Error('WB fullstats ' + r.status);
      res.push(...((await r.json()) || [])); ok = true;
    }
  }
  let TS = 0, TR = 0, TC = 0, TO = 0;
  const sku = {};
  for (const c of res) {
    TS += c.sum || 0; TR += c.sum_price || 0; TC += c.clicks || 0; TO += c.orders || 0;
    for (const d of (c.days || [])) for (const a of (d.apps || [])) for (const m of (a.nms || [])) {
      const s = (sku[m.nmId] ||= { name: m.name || '', views: 0, clicks: 0, sum: 0, orders: 0, sum_price: 0 });
      s.views += m.views || 0; s.clicks += m.clicks || 0; s.sum += m.sum || 0; s.orders += m.orders || 0; s.sum_price += m.sum_price || 0;
      if (m.name && !s.name) s.name = m.name;
    }
  }
  const wbSkus = Object.values(sku).filter((s) => s.sum > 1).map((s) => ({
    name: shorten(s.name), spend: Math.round(s.sum), revenue: Math.round(s.sum_price),
    drr: totDrr(s.sum, s.sum_price), cr: s.clicks ? +(s.orders / s.clicks * 100).toFixed(1) : 0,
    cpc: s.clicks ? Math.round(s.sum / s.clicks) : 0, orders: Math.round(s.orders),
  })).sort((a, b) => b.spend - a.spend);

  return { platform: { spend: Math.round(TS), revenue: Math.round(TR), drr: totDrr(TS, TR), orders: Math.round(TO), clicks: Math.round(TC) }, wbSkus };
}

// ---- helpers ----------------------------------------------------------------
function totDrr(spend, rev) { return rev > 0 ? +(spend / rev * 100).toFixed(1) : null; }
function shorten(name) { return (name || '').replace(/\s+/g, ' ').trim().slice(0, 44); }

function donutFromSpend(items, getName, getSpend) {
  const by = {};
  for (const it of items) { const cat = category(getName(it)); by[cat] = (by[cat] || 0) + getSpend(it); }
  return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value: Math.round(value), color: CAT_COLOR[label] }));
}

function pickInsights(rows) {
  // rows: {name, plat, spend, drr, cr}
  const valid = rows.filter((r) => r.drr != null && r.spend >= 2000);
  const bleeders = valid.filter((r) => r.drr >= 18).sort((a, b) => b.spend * b.drr - a.spend * a.drr).slice(0, 8)
    .map((r) => ({ ...r, note: bleedNote(r) }));
  const winners = valid.filter((r) => r.drr <= 13 && r.cr >= 9).sort((a, b) => b.cr - a.cr).slice(0, 8)
    .map((r) => ({ ...r, note: winNote(r) }));
  return { bleeders, winners };
}
const bleedNote = (r) => r.drr >= 100 ? 'Реклама дороже продаж — стоп.'
  : r.drr >= 40 ? `ДРР ${r.drr}% — съедает выручку, срезать ставку вдвое.`
  : `ДРР ${r.drr}%, CR ${r.cr}% — слабая конверсия, чинить карточку и ставку.`;
const winNote = (r) => `ДРР ${r.drr}%, CR ${r.cr}% — есть запас, поднять ставку.`;

// =============================================================================
(async () => {
  const [oz, w] = [await ozon(), await wb()];

  // cross-platform insight pool
  const pool = [];
  for (const s of oz.skuRows) pool.push({ name: shorten(s.title), plat: 'Ozon', spend: Math.round(s.spend), drr: totDrr(s.spend, s.rev), cr: s.clicks ? +(s.orders / s.clicks * 100).toFixed(1) : 0 });
  for (const s of w.wbSkus) pool.push({ name: s.name, plat: 'WB', spend: s.spend, drr: s.drr, cr: s.cr });
  const { bleeders, winners } = pickInsights(pool);

  const out = {
    period: `${ruDate(begin)} — ${ruDate(end)}`,
    updated: ruDate(new Date()),
    generatedAt: new Date().toISOString(),
    platforms: { ozon: oz.platform, wb: w.platform },
    ozonCampaigns: oz.ozonCampaigns,
    wbSkus: w.wbSkus,
    ozonDonut: donutFromSpend(oz.ozonCampaigns, (c) => c.name, (c) => c.spend),
    wbDonut: donutFromSpend(w.wbSkus, (s) => s.name, (s) => s.spend),
    bleeders, winners,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('Wrote', OUT, '| period', out.period,
    '| Ozon ДРР', out.platforms.ozon.drr, '| WB ДРР', out.platforms.wb.drr,
    '| bleeders', bleeders.length, '| winners', winners.length);
})().catch((e) => { console.error('ETL FAILED:', e.message); process.exit(1); });
