/**
 * geo-snapshot.mjs — daily Cloudflare snapshot for the GEO seat.
 *
 * Why this exists: the zone's adaptive dataset holds **8 days and no more**
 * (verified 2026-08-02 — a query one day past the window is rejected outright).
 * Every measurement older than that is gone for good unless something writes it
 * down. This module is the something. It reads Cloudflare and writes D1. It does
 * not interpret, does not decide, does not alert — a snapshot that argues is a
 * snapshot you stop trusting. Conclusions belong to the read side.
 *
 * Credentials: CF_ANALYTICS_TOKEN is a dedicated token scoped to Analytics Read
 * on one zone only (verified: other zones denied, writes denied). The account
 * master token must never be bound to an agent seat.
 *
 * Late data: Cloudflare backfills for a short while, so the default run re-writes
 * the last few days rather than yesterday alone. Upsert, never insert-only.
 */

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const DEFAULT_ZONE = "8754d20d716a017b21d6179a53133247"; // dasexperten.com

/** Cloudflare bot categories → the families GEO actually reasons about. */
export const FAMILY = {
  "AI Crawler": "train",              // harvesting for model training
  "AI Search": "search",              // indexing for answer engines
  "AI Assistant": "agent",            // a human asked right now — the money row
  "Search Engine Crawler": "classic",
  "Search Engine Optimization": "seo",
  "Page Preview": "preview",
  "Advertising & Marketing": "ads",
  Security: "security",
  Accessibility: "other",
  Aggregator: "other",
  Archiver: "other",
};

/**
 * Content buckets.
 *
 * Four, not two. The first cut of this module wrote html-or-asset, and that binary hid the
 * machine-readable files entirely: robots.txt, sitemap.xml and llms.txt are text/plain and xml,
 * so every fetch of them landed in "asset" beside a stylesheet and was never looked at again.
 * That is how 34 weekly reads of /robots.txt by live AI assistants — a model checking our crawl
 * policy mid-answer, the moment the citation decision is made — stayed invisible.
 */
function contentBucket(name) {
  if (name === "html") return "html";
  if (name === "txt" || name === "xml" || name === "json" || name === "md") return "text";
  if (["svg", "webp", "png", "jpeg", "jpg", "gif", "avif", "ico"].includes(name)) return "image";
  return "other";
}

/** Families whose per-URL detail is worth storing. The rest is noise at URL level. */
const PATH_FAMILIES = ["AI Crawler", "AI Search", "AI Assistant", "Search Engine Crawler"];

// Per-URL rows are html + text only. Images are counted in geo_bot_daily as a bucket and never
// written per asset: ~2,900 image fetches a week across hundreds of asset URLs would outnumber
// the content rows and drown the signal — the first report this seat produced had styles.css and
// app.js at the top of the crawl table, which said nothing about what bots actually read.

const iso = (d) => d.toISOString().slice(0, 10);
const nowStamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** One GraphQL call. Throws with the Cloudflare message intact — never a generic failure. */
async function cfGraphQL(env, query) {
  const token = env.CF_ANALYTICS_TOKEN;
  if (!token) throw new Error("CF_ANALYTICS_TOKEN not bound on this seat");
  const r = await fetch(GRAPHQL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors?.length) throw new Error(`cf graphql: ${j.errors[0].message}`);
  return j.data?.viewer?.zones?.[0] || {};
}

/** D1 has a 100-variable ceiling per statement — chunk or the whole write fails. */
async function upsert(env, sql, rows, width) {
  if (!rows.length) return 0;
  const per = Math.max(1, Math.floor(90 / width));
  let written = 0;
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const holes = chunk.map(() => `(${new Array(width).fill("?").join(",")})`).join(",");
    await env.DB.prepare(sql.replace("__VALUES__", holes))
      .bind(...chunk.flat())
      .run();
    written += chunk.length;
  }
  return written;
}

/**
 * Snapshot one window into D1.
 * @param {object} env  needs DB (d1) and CF_ANALYTICS_TOKEN; CF_ZONE_ID optional
 * @param {object} opts { days = 3 } — how far back to re-write, to absorb late data
 */
export async function runGeoSnapshot(env, { days = 3 } = {}) {
  const zone = env.CF_ZONE_ID || DEFAULT_ZONE;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const lo = iso(start);
  const hi = iso(end);
  const win = `date_geq:"${lo}", date_lt:"${hi}"`;
  const stamp = nowStamp();
  const out = { zone, from: lo, to: hi, at: stamp };

  // 1 — bot category × content type (html vs everything else)
  const byContent = await cfGraphQL(
    env,
    `query { viewer { zones(filter:{zoneTag:"${zone}"}) {
      httpRequestsAdaptiveGroups(limit:10000, filter:{${win}}, orderBy:[date_ASC]) {
        count dimensions { date verifiedBotCategory edgeResponseContentTypeName } } } } }`,
  );
  const contentAgg = new Map();
  for (const r of byContent.httpRequestsAdaptiveGroups || []) {
    const cat = r.dimensions.verifiedBotCategory;
    if (!FAMILY[cat]) continue;
    const kind = contentBucket(r.dimensions.edgeResponseContentTypeName);
    const k = `${r.dimensions.date}|${cat}|${kind}`;
    contentAgg.set(k, (contentAgg.get(k) || 0) + r.count);
  }
  out.daily = await upsert(
    env,
    `INSERT INTO geo_bot_daily (day,category,family,content,hits,source,updated_at)
     VALUES __VALUES__
     ON CONFLICT(day,category,content) DO UPDATE SET hits=excluded.hits, updated_at=excluded.updated_at`,
    [...contentAgg].map(([k, hits]) => {
      const [day, cat, kind] = k.split("|");
      return [day, cat, FAMILY[cat], kind, hits, "cf-graphql", stamp];
    }),
    7,
  );

  // 2 — bot category × HTTP status. This is the row that catches an outage:
  //     a rising 522 against AI Assistant means live questions are timing out.
  const byStatus = await cfGraphQL(
    env,
    `query { viewer { zones(filter:{zoneTag:"${zone}"}) {
      httpRequestsAdaptiveGroups(limit:10000, filter:{${win}}, orderBy:[date_ASC]) {
        count dimensions { date verifiedBotCategory edgeResponseStatus } } } } }`,
  );
  const statusRows = [];
  const statusAgg = new Map();
  for (const r of byStatus.httpRequestsAdaptiveGroups || []) {
    const cat = r.dimensions.verifiedBotCategory;
    if (!FAMILY[cat]) continue;
    const k = `${r.dimensions.date}|${cat}|${r.dimensions.edgeResponseStatus}`;
    statusAgg.set(k, (statusAgg.get(k) || 0) + r.count);
  }
  for (const [k, hits] of statusAgg) {
    const [day, cat, status] = k.split("|");
    statusRows.push([day, cat, FAMILY[cat], Number(status), hits, "cf-graphql", stamp]);
  }
  out.status = await upsert(
    env,
    `INSERT INTO geo_bot_status (day,category,family,status,hits,source,updated_at)
     VALUES __VALUES__
     ON CONFLICT(day,category,status) DO UPDATE SET hits=excluded.hits, updated_at=excluded.updated_at`,
    statusRows,
    7,
  );

  // 3 — per-URL detail, html only, for the four families worth tracking by page
  const pathRows = [];
  for (const cat of PATH_FAMILIES) {
    const d = await cfGraphQL(
      env,
      `query { viewer { zones(filter:{zoneTag:"${zone}"}) {
        httpRequestsAdaptiveGroups(limit:2000, filter:{${win}, verifiedBotCategory:"${cat}", edgeResponseContentTypeName_in:["html","txt","xml"]}, orderBy:[count_DESC]) {
          count dimensions { date clientRequestPath } } } } }`,
    );
    for (const r of d.httpRequestsAdaptiveGroups || []) {
      pathRows.push([
        r.dimensions.date, cat, FAMILY[cat],
        String(r.dimensions.clientRequestPath).slice(0, 200),
        r.count, "cf-graphql", stamp,
      ]);
    }
  }
  out.paths = await upsert(
    env,
    `INSERT INTO geo_bot_paths (day,category,family,path,hits,source,updated_at)
     VALUES __VALUES__
     ON CONFLICT(day,category,path) DO UPDATE SET hits=excluded.hits, updated_at=excluded.updated_at`,
    pathRows,
    7,
  );

  // 3b — the same detail crossed with the response code (Owner 2026-08-04).
  //
  // Until now the two facts lived apart: geo_bot_status knew that 69 requests
  // ended in an error, geo_bot_paths knew which pages were pulled, and nothing
  // joined them. So a seat could see "69 errors" and never name a single broken
  // address — and the session law asks for an address a finger can be put on.
  // The result was an honest but empty day: no invented paths, and no work.
  //
  // Only non-200 rows are stored. A successful fetch is already covered by the
  // table above, and keeping every 200 here would multiply the write for no
  // reading anyone does.
  const brokenRows = [];
  for (const cat of PATH_FAMILIES) {
    let d;
    try {
      d = await cfGraphQL(
        env,
        `query { viewer { zones(filter:{zoneTag:"${zone}"}) {
          httpRequestsAdaptiveGroups(limit:2000, filter:{${win}, verifiedBotCategory:"${cat}", edgeResponseStatus_geq:300}, orderBy:[count_DESC]) {
            count dimensions { date clientRequestPath edgeResponseStatus } } } } }`,
      );
    } catch {
      continue; // one family failing must not lose the others
    }
    for (const r of d.httpRequestsAdaptiveGroups || []) {
      brokenRows.push([
        r.dimensions.date, cat, FAMILY[cat],
        String(r.dimensions.clientRequestPath).slice(0, 200),
        Number(r.dimensions.edgeResponseStatus),
        r.count, "cf-graphql", stamp,
      ]);
    }
  }
  out.broken = await upsert(
    env,
    `INSERT INTO geo_bot_broken (day,category,family,path,status,hits,source,updated_at)
     VALUES __VALUES__
     ON CONFLICT(day,category,path,status) DO UPDATE SET hits=excluded.hits, updated_at=excluded.updated_at`,
    brokenRows,
    8,
  );

  // 4 — site health. Not GEO-specific on its face, but an origin that times out
  //     is invisible to answer engines, so it belongs in the same table set.
  const totals = await cfGraphQL(
    env,
    `query { viewer { zones(filter:{zoneTag:"${zone}"}) {
      all: httpRequestsAdaptiveGroups(limit:100, filter:{${win}}, orderBy:[date_ASC]) { count dimensions { date } }
      e5: httpRequestsAdaptiveGroups(limit:100, filter:{${win}, edgeResponseStatus_geq:500}, orderBy:[date_ASC]) { count dimensions { date } }
      e4: httpRequestsAdaptiveGroups(limit:100, filter:{${win}, edgeResponseStatus_geq:400, edgeResponseStatus_lt:500}, orderBy:[date_ASC]) { count dimensions { date } }
    } } }`,
  );
  const pick = (k) => new Map((totals[k] || []).map((r) => [r.dimensions.date, r.count]));
  const all = pick("all"), e5 = pick("e5"), e4 = pick("e4");
  const siteRows = [...all].map(([day, req]) => {
    const bad = e5.get(day) || 0;
    return [day, req, bad, e4.get(day) || 0, req ? Number(((100 * bad) / req).toFixed(2)) : 0, "cf-graphql", stamp];
  });
  out.site = await upsert(
    env,
    `INSERT INTO geo_site_daily (day,requests,err_5xx,err_4xx,err_5xx_pct,source,updated_at)
     VALUES __VALUES__
     ON CONFLICT(day) DO UPDATE SET requests=excluded.requests, err_5xx=excluded.err_5xx,
       err_4xx=excluded.err_4xx, err_5xx_pct=excluded.err_5xx_pct, updated_at=excluded.updated_at`,
    siteRows,
    7,
  );

  // 4b — тот же счёт, разрезанный по хосту (Джулиан 13.09.2026).
  //
  // Владелец спросил, почему запросы упали втрое, и ответить было нечем: число
  // считалось по всей зоне, а в зоне живут витрина, ERP, страница входа и служебные
  // адреса. Зонное число говорит «упало», но никогда — «упало у кого», а лечится
  // это по-разному. Разрез по хосту стоит копейки: один запрос той же формы.
  //
  // Таблица заводится здесь же: у остальных таблиц снимка схема лежит в базе, а эта
  // новая, и прогон, который её не создаст, тихо потеряет первую ночь.
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS geo_site_host_daily (
         day TEXT NOT NULL, host TEXT NOT NULL, requests INTEGER NOT NULL,
         err_4xx INTEGER NOT NULL DEFAULT 0, err_5xx INTEGER NOT NULL DEFAULT 0,
         source TEXT, updated_at TEXT,
         PRIMARY KEY (day, host)
       )`,
    ).run();
    const byHost = await cfGraphQL(
      env,
      `query { viewer { zones(filter:{zoneTag:"${zone}"}) {
        all: httpRequestsAdaptiveGroups(limit:500, filter:{${win}}, orderBy:[date_ASC]) { count dimensions { date clientRequestHTTPHost } }
        e5: httpRequestsAdaptiveGroups(limit:500, filter:{${win}, edgeResponseStatus_geq:500}, orderBy:[date_ASC]) { count dimensions { date clientRequestHTTPHost } }
        e4: httpRequestsAdaptiveGroups(limit:500, filter:{${win}, edgeResponseStatus_geq:400, edgeResponseStatus_lt:500}, orderBy:[date_ASC]) { count dimensions { date clientRequestHTTPHost } }
      } } }`,
    );
    const key = (r) => `${r.dimensions.date}|${String(r.dimensions.clientRequestHTTPHost || "").slice(0, 120)}`;
    const pickHost = (k) => new Map((byHost[k] || []).map((r) => [key(r), r.count]));
    const hAll = pickHost("all"), h5 = pickHost("e5"), h4 = pickHost("e4");
    const hostRows = [...hAll].map(([k, req]) => {
      const [day, host] = k.split("|");
      return [day, host, req, h4.get(k) || 0, h5.get(k) || 0, "cf-graphql", stamp];
    });
    out.hosts = await upsert(
      env,
      `INSERT INTO geo_site_host_daily (day,host,requests,err_4xx,err_5xx,source,updated_at)
       VALUES __VALUES__
       ON CONFLICT(day,host) DO UPDATE SET requests=excluded.requests, err_4xx=excluded.err_4xx,
         err_5xx=excluded.err_5xx, updated_at=excluded.updated_at`,
      hostRows,
      7,
    );
  } catch (err) {
    // Новый разрез не имеет права уронить старый ряд: зонное число писалось
    // задолго до него и остаётся правдой, даже если разрез не снялся.
    console.log(`geo-snapshot · host split unavailable · ${String(err?.message || err).slice(0, 160)}`);
    out.hosts = 0;
  }

  // Returned as measurement, not as a verdict. The caller decides what is alarming.
  out.worstErrPct = siteRows.reduce((m, r) => Math.max(m, r[4]), 0);
  return out;
}
