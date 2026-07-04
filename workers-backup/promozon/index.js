var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var PERF_BASE = "https://api-performance.ozon.ru";
var SELLER_BASE = "https://api-seller.ozon.ru";
async function perfToken(env) {
  const r = await fetch(`${PERF_BASE}/api/client/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.OZON_PERF_CLIENT_ID,
      client_secret: env.OZON_PERF_CLIENT_SECRET,
      grant_type: "client_credentials"
    })
  });
  if (!r.ok) throw new Error(`perf token ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}
__name(perfToken, "perfToken");
async function perfListProducts(token) {
  const all = [];
  let page = 1;
  for (; ; ) {
    const r = await fetch(`${PERF_BASE}/api/client/campaign/search_promo/v2/products`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ page, pageSize: 100 })
    });
    if (!r.ok) throw new Error(`perf products p${page} ${r.status}: ${await r.text()}`);
    const d = await r.json();
    const prods = d.products || [];
    all.push(...prods);
    if (all.length >= Number(d.total || 0) || prods.length === 0 || page > 50) break;
    page += 1;
  }
  return all;
}
__name(perfListProducts, "perfListProducts");
async function perfSetBids(token, bids) {
  const r = await fetch(`${PERF_BASE}/api/client/campaign/search_promo/v2/bids/set`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ bids })
  });
  if (!r.ok) throw new Error(`perf bids/set ${r.status}: ${await r.text()}`);
  return (await r.json()).response || [];
}
__name(perfSetBids, "perfSetBids");
function sellerHeaders(env) {
  return {
    "Client-Id": env.OZON_SELLER_CLIENT_ID,
    "Api-Key": env.OZON_SELLER_API_KEY,
    "Content-Type": "application/json"
  };
}
__name(sellerHeaders, "sellerHeaders");
async function sellerListPromoActions(env, scope) {
  const r = await fetch(`${SELLER_BASE}/v1/actions`, { method: "GET", headers: sellerHeaders(env) });
  if (!r.ok) throw new Error(`actions list ${r.status}: ${await r.text()}`);
  const list = (await r.json()).result || [];
  return list.filter((a) => scope === "all" || String(a.title || "").toLowerCase().includes("\u0431\u0443\u0441\u0442\u0438\u043D\u0433")).map((a) => ({ id: a.id, title: String(a.title || "").trim() }));
}
__name(sellerListPromoActions, "sellerListPromoActions");
async function sellerActionProducts(env, actionId) {
  const all = [];
  let offset = 0;
  for (; ; ) {
    const r = await fetch(`${SELLER_BASE}/v1/actions/products`, {
      method: "POST",
      headers: sellerHeaders(env),
      body: JSON.stringify({ action_id: actionId, limit: 100, offset })
    });
    if (!r.ok) throw new Error(`actions/products ${r.status}: ${await r.text()}`);
    const res = (await r.json()).result || {};
    const prods = res.products || [];
    all.push(...prods);
    if (all.length >= Number(res.total || 0) || prods.length === 0 || offset > 5e3) break;
    offset += prods.length;
  }
  return all;
}
__name(sellerActionProducts, "sellerActionProducts");
async function sellerActionCandidates(env, actionId) {
  const all = [];
  let offset = 0;
  for (; ; ) {
    const r = await fetch(`${SELLER_BASE}/v1/actions/candidates`, {
      method: "POST",
      headers: sellerHeaders(env),
      body: JSON.stringify({ action_id: actionId, limit: 100, offset })
    });
    if (!r.ok) throw new Error(`actions/candidates ${r.status}: ${await r.text()}`);
    const res = (await r.json()).result || {};
    const prods = res.products || [];
    all.push(...prods);
    if (all.length >= Number(res.total || 0) || prods.length === 0 || offset > 5e3) break;
    offset += prods.length;
  }
  return all;
}
__name(sellerActionCandidates, "sellerActionCandidates");
async function sellerProductNames(env, productIds) {
  const map = /* @__PURE__ */ new Map();
  if (productIds.length === 0) return map;
  try {
    const r = await fetch(`${SELLER_BASE}/v3/product/info/list`, {
      method: "POST",
      headers: sellerHeaders(env),
      body: JSON.stringify({ product_id: productIds.map(String) })
    });
    if (r.ok) {
      const d = await r.json();
      const items = d.items || d.result?.items || [];
      for (const it of items) map.set(String(it.id), { offerId: it.offer_id || "", name: it.name || "" });
    }
  } catch (_) {
  }
  return map;
}
__name(sellerProductNames, "sellerProductNames");
async function sellerActivate(env, actionId, products) {
  const r = await fetch(`${SELLER_BASE}/v1/actions/products/activate`, {
    method: "POST",
    headers: sellerHeaders(env),
    body: JSON.stringify({ action_id: actionId, products })
  });
  if (!r.ok) throw new Error(`activate ${r.status}: ${await r.text()}`);
  return (await r.json()).result || {};
}
__name(sellerActivate, "sellerActivate");
async function getConfig(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM config").all();
  const c = {};
  for (const row of results) c[row.key] = row.value;
  return {
    dryRun: c.dry_run !== "0",
    enabled: c.enabled !== "0",
    // elastic-stock-guard
    stockGuardEnabled: c.stock_guard_enabled !== "0",
    candidateRestoreEnabled: c.candidate_restore_enabled !== "0",
    actionId: Number(c.action_id ?? 1977747),
    // empty = auto-discover; or pin a CSV list e.g. "1977747,3876484"
    actionIds: String(c.action_ids ?? "").split(",").map((s) => Number(s.trim())).filter(Boolean),
    // "all" = scan every active promo (incl. clearance); "boost" = only бустинг actions
    promoScope: c.promo_scope === "boost" ? "boost" : "all",
    targetStock: Number(c.target_stock ?? 29),
    // zero-bid-restore (Performance)
    bidRestoreEnabled: c.bid_restore_enabled === "1",
    targetBid: Number(c.target_bid ?? 29)
  };
}
__name(getConfig, "getConfig");
function activationPrice(p) {
  const cand = [Number(p.action_price), Number(p.max_action_price), Number(p.price_min_elastic)];
  for (const v of cand) if (Number.isFinite(v) && v > 0) return v;
  return 0;
}
__name(activationPrice, "activationPrice");
async function scenarioElasticStockGuard(env, cfg, runId) {
  const boostActions = cfg.actionIds.length ? cfg.actionIds.map((id) => ({ id, title: String(id) })) : await sellerListPromoActions(env, cfg.promoScope);
  let productsChecked = 0, activeZeros = 0, finishedCandidates = 0, actionsTaken = 0;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const stmt = env.DB.prepare(
    "INSERT INTO actions(run_id, scenario, sku, source_sku, title, old_bid, new_bid, dry_run, result, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  );
  const allRows = [];
  for (const act of boostActions) {
    const active = await sellerActionProducts(env, act.id);
    productsChecked += active.length;
    const targets = active.filter((p) => Number(p.stock) === 0).map((p) => ({ ...p, _src: "active" }));
    activeZeros += targets.length;
    if (cfg.candidateRestoreEnabled) {
      const cands = (await sellerActionCandidates(env, act.id)).filter((p) => Number(p.stock) === 0).map((p) => ({ ...p, _src: "candidate" }));
      productsChecked += cands.length;
      finishedCandidates += cands.length;
      targets.push(...cands);
    }
    if (targets.length === 0) continue;
    const names = await sellerProductNames(env, targets.map((p) => p.id));
    let activated = { product_ids: [] };
    if (!cfg.dryRun) {
      activated = await sellerActivate(
        env,
        act.id,
        targets.map((p) => ({ product_id: p.id, action_price: activationPrice(p), stock: cfg.targetStock }))
      );
    }
    const okSet = new Set((activated.product_ids || []).map(String));
    actionsTaken += cfg.dryRun ? 0 : okSet.size;
    for (const p of targets) {
      const n = names.get(String(p.id)) || {};
      const tag = p._src === "candidate" ? "FINISHED-CANDIDATE" : "ACTIVE";
      const res = cfg.dryRun ? `DRY_RUN[${tag} @${act.title}]: would set stock ${cfg.targetStock}` : okSet.has(String(p.id)) ? `activated[${tag} @${act.id}]` : `rejected[${tag} @${act.id}]`;
      allRows.push(stmt.bind(runId, "elastic-stock-guard", String(p.id), n.offerId || "", n.name || "", 0, cfg.targetStock, cfg.dryRun ? 1 : 0, res, now));
    }
  }
  if (allRows.length) await env.DB.batch(allRows);
  return {
    scenario: "elastic-stock-guard",
    boostActions: boostActions.length,
    productsChecked,
    activeZeros,
    finishedCandidates,
    zeros: activeZeros + finishedCandidates,
    actionsTaken
  };
}
__name(scenarioElasticStockGuard, "scenarioElasticStockGuard");
async function scenarioZeroBidRestore(env, cfg, runId) {
  const token = await perfToken(env);
  const products = await perfListProducts(token);
  const zeros = products.filter((p) => Number(p.bid) === 0 && p.isSearchPromoAvailable);
  let actionsTaken = 0;
  if (zeros.length > 0) {
    let setResults = /* @__PURE__ */ new Map();
    if (!cfg.dryRun) {
      const resp = await perfSetBids(token, zeros.map((p) => ({ sku: String(p.sku), bid: cfg.targetBid })));
      for (const r of resp) setResults.set(String(r.sku), r);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const stmt = env.DB.prepare(
      "INSERT INTO actions(run_id, scenario, sku, source_sku, title, old_bid, new_bid, dry_run, result, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    );
    const batch = zeros.map((p) => {
      const res = cfg.dryRun ? "DRY_RUN: would set bid" : JSON.stringify(setResults.get(String(p.sku)) ?? { updated: "unknown" });
      const prevBid = Number(p.previousBid?.bid ?? 0);
      return stmt.bind(runId, "zero-bid-restore", String(p.sku), p.sourceSku || "", p.title || "", prevBid, cfg.targetBid, cfg.dryRun ? 1 : 0, res, now);
    });
    await env.DB.batch(batch);
    actionsTaken = cfg.dryRun ? 0 : zeros.filter((p) => setResults.get(String(p.sku))?.updated).length;
  }
  return { scenario: "zero-bid-restore", productsChecked: products.length, zeros: zeros.length, actionsTaken };
}
__name(scenarioZeroBidRestore, "scenarioZeroBidRestore");
async function runCheck(env, triggerSrc) {
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const cfg = await getConfig(env);
  const ins = await env.DB.prepare(
    "INSERT INTO runs(started_at, trigger_src, dry_run, status) VALUES (?,?,?,?) RETURNING id"
  ).bind(startedAt, triggerSrc, cfg.dryRun ? 1 : 0, "running").first();
  const runId = ins.id;
  try {
    if (!cfg.enabled) {
      await env.DB.prepare("UPDATE runs SET finished_at=?, status=? WHERE id=?").bind((/* @__PURE__ */ new Date()).toISOString(), "skipped: disabled", runId).run();
      return { runId, skipped: true };
    }
    const results = [];
    if (cfg.stockGuardEnabled) results.push(await scenarioElasticStockGuard(env, cfg, runId));
    if (cfg.bidRestoreEnabled) results.push(await scenarioZeroBidRestore(env, cfg, runId));
    const sum = /* @__PURE__ */ __name((k) => results.reduce((a, r) => a + (r[k] || 0), 0), "sum");
    await env.DB.prepare(
      "UPDATE runs SET finished_at=?, products_checked=?, zero_bids=?, actions_taken=?, status=? WHERE id=?"
    ).bind((/* @__PURE__ */ new Date()).toISOString(), sum("productsChecked"), sum("zeros"), sum("actionsTaken"), "ok", runId).run();
    return { runId, dryRun: cfg.dryRun, scenarios: results };
  } catch (e) {
    await env.DB.prepare("UPDATE runs SET finished_at=?, status=?, error=? WHERE id=?").bind((/* @__PURE__ */ new Date()).toISOString(), "error", String(e.message || e).slice(0, 500), runId).run();
    throw e;
  }
}
__name(runCheck, "runCheck");
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
__name(json, "json");
function authorized(req, env) {
  return (req.headers.get("Authorization") || "") === `Bearer ${env.PROMOZON_AUTH}`;
}
__name(authorized, "authorized");
var index_default = {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env, "cron").catch(() => {
    }));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return json({ service: "promozon", scenarios: ["elastic-stock-guard", "zero-bid-restore"], cron: "every 4h" });
    }
    if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/status" && req.method === "GET") {
      const cfg = await getConfig(env);
      const last = await env.DB.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 5").all();
      return json({ config: cfg, lastRuns: last.results });
    }
    if (url.pathname === "/actions" && req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 500);
      const rows = await env.DB.prepare("SELECT * FROM actions ORDER BY id DESC LIMIT ?").bind(limit).all();
      return json({ actions: rows.results });
    }
    if (url.pathname === "/run" && req.method === "POST") {
      try {
        return json(await runCheck(env, "manual"));
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }
    if (url.pathname === "/config" && req.method === "POST") {
      const body = await req.json();
      const allowed = ["dry_run", "enabled", "stock_guard_enabled", "candidate_restore_enabled", "action_id", "action_ids", "promo_scope", "target_stock", "bid_restore_enabled", "target_bid"];
      const updated = {};
      for (const k of allowed) {
        if (body[k] !== void 0) {
          await env.DB.prepare(
            "INSERT INTO config(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
          ).bind(k, String(body[k])).run();
          updated[k] = String(body[k]);
        }
      }
      return json({ updated, config: await getConfig(env) });
    }
    return json({ error: "not found" }, 404);
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
