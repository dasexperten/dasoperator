import { wbRead } from './wb-egress.mjs';

const DAY = 86400000;
const date = ms => new Date(ms).toISOString().slice(0, 10);

// WB fullstats: <=50 campaigns, <=31 inclusive calendar days, statuses 7/9/11.
// Read through the ERP gateway; failure must never become an advertising zero.
export async function fetchWbAdvertSpend(env, from, to) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    throw new Error('WB advertising: invalid date interval');
  async function read(path) {
    const response = await wbRead(env, `https://advert-api.wildberries.ru${path}`);
    if (!response.ok) throw new Error(`WB advertising ${path.split('?')[0]} HTTP ${response.status}`);
    return response.json();
  }
  const listed = await read('/adv/v1/promotion/count');
  if (!listed || (!Array.isArray(listed.adverts) && listed.all !== 0))
    throw new Error('WB advertising: malformed campaign list');
  const ids = new Set();
  for (const group of listed.adverts || []) {
    if (![7, 9, 11].includes(group.status)) continue;
    if (!Array.isArray(group.advert_list)) throw new Error('WB advertising: missing campaign IDs');
    for (const row of group.advert_list) {
      if (!Number.isSafeInteger(row.advertId) || row.advertId <= 0)
        throw new Error('WB advertising: invalid campaign ID');
      ids.add(row.advertId);
    }
  }
  const mappings = await env.ERP_DB.prepare(
    'SELECT nm_id, supplier_article FROM marketplace_stocks_wb'
  ).all();
  const articles = new Map((mappings.results || []).map(row =>
    [Number(row.nm_id), String(row.supplier_article || '').trim().toLowerCase()]));
  const spend = new Map();
  let emptyBatches = 0;
  const campaigns = [...ids];
  for (let i = 0; i < campaigns.length; i += 50) {
    const batch = campaigns.slice(i, i + 50);
    for (let first = start; first <= end; first += 31 * DAY) {
      const last = Math.min(end, first + 30 * DAY);
      const rows = await read(`/adv/v3/fullstats?ids=${batch.join(',')}&beginDate=${date(first)}&endDate=${date(last)}`);
      // WB answers 200 `null` when none of the campaigns has statistics for the period (seen live
      // 2026-10-05: 50 campaigns, 2026-09-29..2026-10-06). That is "no spend reported", not a failure —
      // but it is counted and surfaced, never silent.
      if (rows === null) { emptyBatches++; continue; }
      if (!Array.isArray(rows)) {
        // Say what WB actually sent: a bare label hid the cause for two nights (2026-10-03/04).
        const shape = rows === null ? 'null' : typeof rows === 'object' ? `object keys=${Object.keys(rows).slice(0, 8).join(',')}` : typeof rows;
        throw new Error(`WB advertising: malformed fullstats (${shape}; ${JSON.stringify(rows)?.slice(0, 160)}; ${batch.length} campaigns ${date(first)}..${date(last)})`);
      }
      for (const campaign of rows) {
        if (!batch.includes(campaign.advertId)) throw new Error('WB advertising: unexpected campaign');
        if (campaign.currency && campaign.currency !== 'RUB') throw new Error('WB advertising: non-RUB spend');
        if (!Array.isArray(campaign.days)) throw new Error('WB advertising: missing daily statistics');
        let nmRows = 0;
        for (const day of campaign.days) {
          const dayKey = String(day.date || '').slice(0, 10);
          if (dayKey < date(first) || dayKey > date(last)) throw new Error('WB advertising: unexpected statistics date');
          if (!Array.isArray(day.apps)) throw new Error('WB advertising: missing app statistics');
          for (const app of day.apps) {
            if (!Array.isArray(app.nms)) throw new Error('WB advertising: missing SKU statistics');
            for (const nm of app.nms) {
              nmRows++;
              if (typeof nm.sum !== 'number' || !Number.isFinite(nm.sum) || nm.sum < 0)
                throw new Error('WB advertising: invalid SKU spend');
              const kopecks = Math.round(nm.sum * 100);
              const article = articles.get(nm.nmId);
              if (kopecks > 0 && !article) throw new Error(`WB advertising: unmapped paid nmID ${nm.nmId}`);
              if (article) spend.set(article, (spend.get(article) || 0) + kopecks);
            }
          }
        }
        if (campaign.sum > 0 && nmRows === 0) throw new Error('WB advertising: paid campaign lacks SKU breakdown');
      }
    }
  }
  return { spend, campaigns: campaigns.length, emptyBatches };
}
