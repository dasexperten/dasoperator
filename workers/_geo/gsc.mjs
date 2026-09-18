/**
 * gsc.mjs — Search Console read for the fleet.
 *
 * The seat already held GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN as
 * Cloudflare secrets (stored 2026-07-28) but no code ever used them: the door was
 * bound, the handle was never fitted, so every GSC pull needed a human session.
 * This module is the handle. Read-only — it queries searchAnalytics and nothing else.
 *
 * Secrets stay inside the Worker. No value is ever returned in a response.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SC_BASE = "https://searchconsole.googleapis.com/webmasters/v3/sites";

/** Exchange the stored refresh token for a short-lived access token. */
export async function gscAccessToken(env) {
  if (!env.GSC_REFRESH_TOKEN) throw new Error("missing secret: GSC_REFRESH_TOKEN");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: env.GSC_REFRESH_TOKEN,
    client_id: env.GSC_CLIENT_ID,
    client_secret: env.GSC_CLIENT_SECRET,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    throw new Error(`gsc token ${r.status}: ${j.error_description || j.error || "no access_token"}`);
  }
  return j.access_token;
}

/**
 * One searchAnalytics query.
 * @param {string} site   property, e.g. "https://www.dasexperten.com/" or "sc-domain:dasexperten.com"
 * @param {object} q      { startDate, endDate, dimensions, rowLimit, dimensionFilterGroups }
 */
export async function gscQuery(env, site, q) {
  const token = await gscAccessToken(env);
  const r = await fetch(`${SC_BASE}/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(q),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`gsc query ${r.status}: ${j?.error?.message || "failed"}`);
  return j.rows || [];
}

/** Default 28-day window ending yesterday — GSC has no data for today. */
export function defaultWindow(days = 28) {
  const end = new Date(Date.now() - 86400000);
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end) };
}

/**
 * Per-market read: totals by country, and the queries + pages for one country
 * when `country` (ISO-3166-1 alpha-3, lower case, e.g. "vnm") is given.
 */
export async function gscMarkets(env, site, { startDate, endDate, country, rowLimit = 25, days = 28, pairs = false } = {}) {
  const win = startDate && endDate ? { startDate, endDate } : defaultWindow(days);
  const out = { site, ...win };

  out.countries = await gscQuery(env, site, {
    ...win,
    dimensions: ["country"],
    rowLimit: 250,
  });

  if (country) {
    const filter = {
      dimensionFilterGroups: [
        { filters: [{ dimension: "country", operator: "equals", expression: country }] },
      ],
    };
    out.country = country;
    out.queries = await gscQuery(env, site, { ...win, dimensions: ["query"], rowLimit, ...filter });
    out.pages = await gscQuery(env, site, { ...win, dimensions: ["page"], rowLimit, ...filter });
    if (pairs) {
      out.queryPages = await gscQuery(env, site, {
        ...win,
        dimensions: ["query", "page"],
        rowLimit,
        ...filter,
      });
    }
  }
  return out;
}

/**
 * The search half of the nightly measurement (Owner 2026-08-04).
 *
 * The Cloudflare half has been kept nightly since 2026-07-26 and now opens the
 * GEO day; `geo_gsc_daily` was created for the search half and stayed empty from
 * the start — nothing ever wrote to it. That is why a day could look at Search
 * Console and find "nothing meeting criteria": a single live window is a
 * snapshot, and a snapshot has no dynamics. Structure, trend and correlation —
 * which the session standard now asks for by name — need a series.
 *
 * Stored by DAY, not by window, so every later run reads real movement rather
 * than a re-averaged blur. The last `days` days are rewritten on every run
 * because Search Console keeps revising recent numbers for about three days,
 * exactly like the Cloudflare side.
 */
// `rowLimit` was removed from the signature on 2026-08-28: it multiplied into a
// single window-wide cap that starved the recent days (see the block below).
// Per-day budgets live in DAY_ROWS. A caller that still passes it gets no silent
// no-op — the name is simply gone.
export async function runGscSnapshot(env, { site = "https://www.dasexperten.com/", days = 5 } = {}) {
  if (!env.DB) return { skipped: "no DB binding" };
  const win = defaultWindow(days);
  const stamp = new Date().toISOString();
  const rows = [];

  const push = (day, scope, key, r) =>
    rows.push([
      day, scope, key,
      Math.round(r.impressions || 0), Math.round(r.clicks || 0),
      r.position ?? null, r.ctr ?? null, 1, "gsc", stamp,
    ]);

  // date alone -> the site total for each day; date + dimension -> the series
  // per country, per query and per page. Keys are '' for the total row.
  const totals = await gscQuery(env, site, { ...win, dimensions: ["date"], rowLimit: 500 });
  for (const r of totals) push(r.keys[0], "total", "", r);

  // One call PER DAY, not one call for the whole window.
  //
  // The window form (`dimensions: ["date", dim]` with a single rowLimit) looks
  // cheaper and is silently wrong: Search Console fills the row budget from the
  // oldest day forward, so the whole cap is spent before it reaches the recent
  // days. Measured live on 2026-08-28 over 19–26.08, dimension date+query:
  //
  //   rowLimit  200 -> 179 rows for 19.08 and 1..5 rows for every later day
  //   rowLimit 5000 -> 288..415 rows for every day of the window
  //
  // With `rowLimit * days` = 25 * 8 = 200 in production, the query and page
  // series for the last six days of every window were near-empty in D1 — not a
  // Search Console lag, the data was there and was never asked for. A per-day
  // call cannot skew: each day gets its own budget and the class of bug is gone.
  // `days` calls per dimension is 24 requests a night, far inside the quota.
  const DAY_ROWS = { country: 250, query: 500, page: 500 };
  for (const [dim, scope] of [
    ["country", "country"],
    ["query", "query"],
    ["page", "page"],
  ]) {
    for (const r0 of totals) {
      const day = r0.keys[0];
      let got = [];
      try {
        got = await gscQuery(env, site, {
          startDate: day,
          endDate: day,
          dimensions: [dim],
          rowLimit: DAY_ROWS[dim],
        });
      } catch {
        continue; // one day failing must not lose the rest of the dimension
      }
      for (const r of got) push(day, scope, String(r.keys[0] || ""), r);
    }
  }

  if (!rows.length) return { from: win.startDate, to: win.endDate, written: 0 };

  let written = 0;
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    await env.DB.batch(
      chunk.map((v) =>
        env.DB.prepare(
          `INSERT INTO geo_gsc_daily (day,scope,key,impressions,clicks,position,ctr,window_days,source,updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
           ON CONFLICT(day,scope,key) DO UPDATE SET
             impressions=excluded.impressions, clicks=excluded.clicks,
             position=excluded.position, ctr=excluded.ctr, updated_at=excluded.updated_at`,
        ).bind(...v),
      ),
    );
    written += chunk.length;
  }
  return { from: win.startDate, to: win.endDate, written, days: totals.length };
}
