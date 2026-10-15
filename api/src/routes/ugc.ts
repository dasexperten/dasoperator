import { Hono } from 'hono';
import type { Env } from '../types';
import { fail, ok } from '../lib/responses';
import { hasModuleAccess, validateSession, type AuthUser } from '../lib/auth';
import { runUgcLinkHealthBatch } from '../lib/ugc-link-health';
import { baseProductSku, identifyExplicitProducts, initialProductClassification, UGC_PRODUCTS } from '../lib/ugc-products.mjs';
import { annotateOverLimit, checkDailyLimit, checkDailyTotalLimit, compareByRecent, isFpsBankMemberId, isPayoutStatus, konsolPhone, latestActivityMs, maskPhone, maskPhoneWide, paidCounters, parsePayoutAmount, payoutDate, statusStampColumn } from '../lib/ugc-payouts.mjs';
import { executeUgcPayout, refreshUgcPayout, ugcPayoutEvening } from '../lib/ugc-payout-store';
import { profileAverages } from '../lib/ugc-profile-metrics.mjs';

// Diana's creator statuses (Owner 2026-10-15, DH-LAW-261015-02): one English
// word, at most 7 letters. Main path, then side statuses.
const UGC_STAGES = new Set([
  'new', 'sent', 'replied', 'agreed', 'cart', 'payout', 'paid', 'ordered', 'review', 'posted', 'gold',
  'silent', 'failed', 'fee', 'refused', 'unfit', 'rival', 'owner',
]);
// Who started: we invited (brown magnifier) or the creator came herself (green hand).
const UGC_ORIGINS = new Set(['invited', 'self']);

type ImportRow = {
  handle?: unknown;
  platform?: unknown;
  display_name?: unknown;
  followers?: unknown;
  engagement_rate?: unknown;
  metrics_as_of?: unknown;
  content_url?: unknown;
  content_type?: unknown;
  views?: unknown;
  comments?: unknown;
  product_codes?: unknown;
  usage_label?: unknown;
  source_rating?: unknown;
  source_valid?: unknown;
  audio_label?: unknown;
  download_url?: unknown;
  source_workbook?: unknown;
  source_sheet?: unknown;
  source_row?: unknown;
};

const ugc = new Hono<{ Bindings: Env }>();

function bearer(header: string | undefined): string | null {
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return match?.[1]?.trim() || null;
}

async function userFor(c: any): Promise<AuthUser | null> {
  const token = bearer(c.req.header('Authorization'));
  return token ? validateSession(c.env.DB, token) : null;
}

async function requireAccess(c: any, write = false): Promise<AuthUser | Response> {
  const user = await userFor(c);
  if (!user) return fail(c, 401, [{ code: 'unauthorized', message: 'Valid ERP session required' }]);
  if (!hasModuleAccess(user, '/ugc')) {
    return fail(c, 403, [{ code: 'forbidden', message: 'UGC module access required' }]);
  }
  const access = user.role === 'admin' ? 'full' : user.permissions?.['/ugc'];
  if (write && access !== 'full' && access !== 'rw') {
    return fail(c, 403, [{ code: 'read_only', message: 'UGC write access required' }]);
  }
  return user;
}

function textValue(value: unknown, max = 500): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function numberValue(value: unknown, integer = false): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return integer ? Math.round(number) : number;
}

function normalizeHandle(value: unknown): string {
  let handle = String(value ?? '').trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(handle)) {
      const url = new URL(handle);
      handle = url.pathname.split('/').filter(Boolean)[0] || '';
    }
  } catch { /* keep source text */ }
  return handle.replace(/^@+/, '').replace(/\s+/g, '').slice(0, 160);
}

function normalizePlatform(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[._-]+/g, ' ');
  if (!raw) return 'other';
  if (raw.includes('instagram')) return 'instagram';
  if (raw === 'tik tok' || raw.includes('tiktok')) return 'tiktok';
  if (raw === 'vk' || raw.includes('vkontakte')) return 'vk';
  if (raw.includes('shopee')) return 'shopee';
  if (raw.includes('lazada')) return 'lazada';
  if (raw.includes('facebook')) return 'facebook';
  if (raw.includes('telegram')) return 'telegram';
  if (raw.includes('youtube')) return 'youtube';
  return 'other';
}

async function stableId(prefix: string, input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex.slice(0, 24)}`;
}

ugc.get('/', async (c) => {
  const access = await requireAccess(c);
  if (access instanceof Response) return access;

  const platform = normalizePlatform(c.req.query('platform'));
  const usePlatform = c.req.query('platform') && c.req.query('platform') !== 'all' ? platform : null;
  const search = textValue(c.req.query('search'), 120)?.toLowerCase() ?? '';
  const stage = textValue(c.req.query('stage'), 80);
  const product = baseProductSku(c.req.query('product'));

  const profiles = await c.env.DB.prepare(
    `SELECT
       c.id creator_id, c.normalized_handle creator_handle, c.display_name,
       c.category, c.audience_market, c.audience_language, c.lifecycle_stage, c.origin,
       c.priority, c.owner, c.notes, c.updated_at creator_updated_at,
       p.id profile_id, p.platform, p.handle, p.profile_url, p.followers,
       p.engagement_rate, p.engagement_rate_method, p.avg_video_views,
       p.median_video_views, p.avg_comments, p.posting_cadence,
       p.commerce_clicks, p.commerce_orders, p.commerce_gmv_minor,
       p.commerce_currency, p.metrics_as_of, p.source, p.updated_at profile_updated_at
     FROM ugc_creators c
     JOIN ugc_creator_platforms p ON p.creator_id = c.id
     WHERE (?1 IS NULL OR p.platform = ?1)
       AND (?2 = '' OR LOWER(COALESCE(c.display_name, '') || ' ' || p.handle) LIKE '%' || ?2 || '%')
       AND (?3 IS NULL OR c.lifecycle_stage = ?3)
       AND (?4 IS NULL OR EXISTS (
         SELECT 1 FROM ugc_content uc
         WHERE uc.creator_platform_id = p.id AND UPPER(COALESCE(uc.product_codes, '')) LIKE '%"' || ?4 || '%'
       ))
     ORDER BY COALESCE(p.followers, -1) DESC, COALESCE(c.display_name, p.handle) ASC
     LIMIT 1500`
  ).bind(usePlatform, search, stage, product).all<Record<string, any>>();

  const metricRows = await c.env.DB.prepare(
    `SELECT id, creator_id, creator_platform_id, content_url, content_type,
            published_at, views, likes, comments, metrics_checked_at, product_codes, source_sheet,
            source_row, imported_at, link_status, link_checked_at,
            link_http_status, link_final_url, link_check_note,
            product_status, product_source, product_confidence,
            product_evidence, product_checked_at
     FROM ugc_content
     ORDER BY COALESCE(published_at, '') DESC, imported_at DESC,
              source_sheet DESC, source_row DESC`
  ).all<Record<string, any>>();

  const contentCounts = await c.env.DB.prepare(
    `SELECT creator_id, creator_platform_id, COUNT(*) content_count
     FROM ugc_content GROUP BY creator_id, creator_platform_id`
  ).all<{ creator_id: string; creator_platform_id: string; content_count: number }>();

  const collaborations = await c.env.DB.prepare(
    `SELECT * FROM ugc_collaborations ORDER BY updated_at DESC`
  ).all<Record<string, any>>();

  // ugc_payouts arrives with migration 0116; until it is applied the screen
  // must keep working, so a missing table reads as "no payouts".
  let payoutRows: Record<string, any>[] = [];
  try {
    const result = await c.env.DB.prepare(
      `SELECT p.id, p.creator_id, p.creator_platform_id, p.platform, p.handle, p.amount_minor,
              p.currency, p.status, p.payout_date, p.marketplace, p.bank_ref, p.note,
              p.approved_at, p.sent_at, p.paid_at, p.failed_at, p.execute_claimed_at, p.created_at, p.updated_at,
              p.konsol_payment_id, p.konsol_status, p.phone_masked, p.fps_bank_member_id,
              (CASE WHEN p.execute_claim IS NOT NULL THEN 'held' END) execute_claim,
              -- requisites received? (yes/no only; the phone and name never leave that table)
              (CASE WHEN EXISTS (SELECT 1 FROM ugc_payout_requisites r WHERE r.payout_id = p.id) THEN 1 ELSE 0 END) has_requisites
       FROM ugc_payouts p ORDER BY p.updated_at DESC`
    ).all<Record<string, any>>();
    payoutRows = annotateOverLimit(result.results ?? []);
  } catch { /* table not yet migrated */ }
  const payoutsByCreator = new Map<string, Record<string, any>[]>();
  for (const row of payoutRows) {
    const list = payoutsByCreator.get(String(row.creator_id)) ?? [];
    list.push(row);
    payoutsByCreator.set(String(row.creator_id), list);
  }
  const contentByCreator = new Map<string, Record<string, any>[]>();
  for (const row of metricRows.results ?? []) {
    const list = contentByCreator.get(String(row.creator_id)) ?? [];
    list.push({ imported_at: row.imported_at, published_at: row.published_at });
    contentByCreator.set(String(row.creator_id), list);
  }

  const byProfile = new Map<string, { views: number[]; comments: number[]; content_count: number; content: Record<string, unknown>[] }>();
  for (const row of metricRows.results ?? []) {
    const entry = byProfile.get(row.creator_platform_id) ?? { views: [], comments: [], content_count: 0, content: [] };
    if (row.views != null) entry.views.push(Number(row.views));
    if (row.comments != null) entry.comments.push(Number(row.comments));
    let productCodes: string[] = [];
    if (row.product_codes) {
      try {
        const parsed = JSON.parse(String(row.product_codes));
        if (Array.isArray(parsed)) productCodes = parsed.map(String);
      } catch { /* preserve an empty list for malformed legacy values */ }
    }
    const productIdentity = identifyExplicitProducts(productCodes);
    entry.content.push({
      id: row.id,
      content_url: row.content_url,
      content_type: row.content_type,
      published_at: row.published_at,
      views: row.views,
      likes: row.likes,
      metrics_checked_at: row.metrics_checked_at,
      comments: row.comments,
      product_codes: productCodes,
      products: productIdentity.matches,
      unknown_product_codes: productIdentity.unknown_codes,
      source_sheet: row.source_sheet,
      source_row: row.source_row,
      link_status: row.link_status,
      link_checked_at: row.link_checked_at,
      link_http_status: row.link_http_status,
      link_final_url: row.link_final_url,
      link_check_note: row.link_check_note,
      product_status: row.product_status,
      product_source: row.product_source,
      product_confidence: row.product_confidence,
      product_evidence: row.product_evidence,
      product_checked_at: row.product_checked_at,
    });
    byProfile.set(row.creator_platform_id, entry);
  }
  for (const row of contentCounts.results ?? []) {
    const entry = byProfile.get(row.creator_platform_id) ?? { views: [], comments: [], content_count: 0, content: [] };
    entry.content_count = Number(row.content_count || 0);
    byProfile.set(row.creator_platform_id, entry);
  }

  const latestCollaboration = new Map<string, Record<string, any>>();
  for (const row of collaborations.results ?? []) {
    if (!latestCollaboration.has(String(row.creator_id))) latestCollaboration.set(String(row.creator_id), row);
  }

  const creators = new Map<string, Record<string, any>>();
  for (const row of profiles.results ?? []) {
    const metrics = byProfile.get(String(row.profile_id)) ?? { views: [], comments: [], content_count: 0, content: [] };
    const profile = {
      id: row.profile_id,
      platform: row.platform,
      handle: row.handle,
      profile_url: row.profile_url,
      followers: row.followers,
      engagement_rate: row.engagement_rate,
      engagement_rate_method: row.engagement_rate_method,
      ...profileAverages(row, metrics),
      latest_observed_views: metrics.views.length === 1 ? metrics.views[0] : null,
      view_observations: metrics.views.length,
      posting_cadence: row.posting_cadence,
      commerce_clicks: row.commerce_clicks,
      commerce_orders: row.commerce_orders,
      commerce_gmv_minor: row.commerce_gmv_minor,
      commerce_currency: row.commerce_currency,
      metrics_as_of: row.metrics_as_of,
      source: row.source,
      content_count: metrics.content_count,
      content: metrics.content,
      updated_at: row.profile_updated_at,
    };
    const creatorId = String(row.creator_id);
    const creatorPayouts = payoutsByCreator.get(creatorId) ?? [];
    const creator = creators.get(creatorId) ?? {
      id: creatorId,
      normalized_handle: row.creator_handle,
      display_name: row.display_name,
      category: row.category,
      audience_market: row.audience_market,
      audience_language: row.audience_language,
      lifecycle_stage: row.lifecycle_stage,
      origin: row.origin ?? null,
      priority: row.priority,
      owner: row.owner,
      notes: row.notes,
      updated_at: row.creator_updated_at,
      profiles: [],
      collaboration: latestCollaboration.get(creatorId) ?? null,
      payout: creatorPayouts[0] ?? null,
      payouts: creatorPayouts.slice(0, 20),
      paid_total_minor: creatorPayouts.filter((item) => item.status === 'paid' && item.konsol_payment_id).reduce((sum, item) => sum + Number(item.amount_minor || 0), 0),
      last_activity_at: latestActivityMs({
        collaboration: latestCollaboration.get(creatorId) ?? null,
        payouts: creatorPayouts,
        content: contentByCreator.get(creatorId) ?? [],
      }),
    };
    creator.profiles.push(profile);
    creators.set(creatorId, creator);
  }

  const platformCounts = await c.env.DB.prepare(
    `SELECT platform, COUNT(DISTINCT creator_id) creator_count
     FROM ugc_creator_platforms GROUP BY platform ORDER BY creator_count DESC`
  ).all<{ platform: string; creator_count: number }>();
  const totals = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM ugc_creators) creators,
       (SELECT COUNT(*) FROM ugc_creator_platforms) profiles,
       (SELECT COUNT(*) FROM ugc_content) content_items,
       (SELECT COUNT(*) FROM ugc_content WHERE content_url IS NOT NULL AND TRIM(content_url) <> '') linked_content,
       (SELECT COUNT(*) FROM ugc_content WHERE link_status = 'active') links_active,
       (SELECT COUNT(*) FROM ugc_content WHERE link_status = 'missing') links_missing,
       (SELECT COUNT(*) FROM ugc_content WHERE link_status = 'restricted') links_restricted,
       (SELECT COUNT(*) FROM ugc_content WHERE link_status = 'unknown') links_unknown,
       (SELECT COUNT(*) FROM ugc_content WHERE link_status = 'invalid') links_invalid,
       (SELECT COUNT(*) FROM ugc_content WHERE content_url IS NOT NULL AND TRIM(content_url) <> '' AND link_checked_at IS NULL) links_unchecked,
       (SELECT COUNT(*) FROM ugc_content WHERE datetime(link_checked_at) > datetime('now', '-30 days')) links_checked_30d,
       (SELECT MAX(link_checked_at) FROM ugc_content) links_last_checked_at,
       (SELECT COUNT(*) FROM ugc_link_checks) link_check_history,
       (SELECT COUNT(*) FROM ugc_content WHERE product_status = 'identified') product_identified,
       (SELECT COUNT(*) FROM ugc_content WHERE product_status = 'queued') product_queued,
       (SELECT COUNT(*) FROM ugc_collaborations WHERE status IN ('sent','replied','agreed','cart','payout','paid','ordered','review')) active_outreach,
       (SELECT COUNT(*) FROM ugc_collaborations WHERE status IN ('posted','gold')) published
    `
  ).first<Record<string, any>>();
  const payoutSummary = {
    payouts_awaiting: payoutRows.filter((row) => row.status === 'awaiting_approval').length,
    payouts_open: payoutRows.filter((row) => row.status === 'approved' || row.status === 'sent').length,
    // Paid = executed in Konsol with its payment id (Owner 2026-10-15).
    payouts_paid: payoutRows.filter((row) => row.status === 'paid' && row.konsol_payment_id).length,
    payouts_paid_minor: payoutRows.filter((row) => row.status === 'paid' && row.konsol_payment_id).reduce((sum, row) => sum + Number(row.amount_minor || 0), 0),
    paid_konsol: paidCounters(payoutRows),
  };
  const productCounts = new Map<string, number>();
  for (const row of metricRows.results ?? []) {
    let codes: string[] = [];
    try { const parsed = JSON.parse(String(row.product_codes ?? '[]')); if (Array.isArray(parsed)) codes = parsed.map(String); } catch { /* raw evidence remains in DB */ }
    for (const match of identifyExplicitProducts(codes).matches) productCounts.set(match.sku, (productCounts.get(match.sku) ?? 0) + 1);
  }

  // Default order: most recent activity first (Owner 2026-10-14).
  const creatorList = Array.from(creators.values()).sort((a, b) => compareByRecent(
    { last_activity_at: a.last_activity_at, followers: Math.max(-1, ...a.profiles.map((p: any) => p.followers ?? -1)), name: a.display_name ?? a.normalized_handle },
    { last_activity_at: b.last_activity_at, followers: Math.max(-1, ...b.profiles.map((p: any) => p.followers ?? -1)), name: b.display_name ?? b.normalized_handle },
  ));

  return ok(c, {
    creators: creatorList,
    payout_summary: payoutSummary,
    summary: totals ?? {
      creators: 0, profiles: 0, content_items: 0, linked_content: 0,
      links_active: 0, links_missing: 0, links_restricted: 0, links_unknown: 0,
      links_invalid: 0, links_unchecked: 0, links_checked_30d: 0,
      links_last_checked_at: null, link_check_history: 0, product_identified: 0, product_queued: 0,
      active_outreach: 0, published: 0,
    },
    platforms: platformCounts.results ?? [],
    products: Array.from(productCounts, ([sku, content_count]) => ({ sku, name: UGC_PRODUCTS[sku] ?? sku, content_count }))
      .sort((a, b) => b.content_count - a.content_count || a.name.localeCompare(b.name)),
  });
});

ugc.post('/link-health/run', async (c) => {
  const access = await requireAccess(c, true);
  if (access instanceof Response) return access;
  let body: { limit?: unknown } = {};
  try { body = await c.req.json(); } catch { /* optional empty body */ }
  const limit = Math.max(1, Math.min(10, Math.trunc(Number(body.limit) || 5)));
  return ok(c, await runUgcLinkHealthBatch(c.env, limit));
});

// Diana 2026-10-16 (Owner: «check like and views one by one»): counts read from
// each publication on its platform. Only figures the platform showed are written;
// a missing figure leaves the stored one untouched.
ugc.post('/content/metrics', async (c) => {
  const access = await requireAccess(c, true);
  if (access instanceof Response) return access;
  let body: { items?: unknown };
  try { body = await c.req.json(); } catch { return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]); }
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 100) return fail(c, 413, [{ code: 'batch_size', message: 'Send 1 to 100 items per request' }]);
  const count = (value: unknown) => (value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : Math.round(Number(value)));
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const raw of items as Record<string, unknown>[]) {
    const id = typeof raw?.id === 'string' ? raw.id.slice(0, 80) : null;
    const checkedAt = typeof raw?.checked_at === 'string' && !Number.isNaN(Date.parse(raw.checked_at)) ? raw.checked_at : null;
    if (!id || !checkedAt) continue;
    statements.push(c.env.DB.prepare(
      `UPDATE ugc_content SET views = COALESCE(?, views), likes = COALESCE(?, likes), comments = COALESCE(?, comments),
              metrics_checked_at = ?, metrics_source = ?, updated_at = ? WHERE id = ?`
    ).bind(count(raw.views), count(raw.likes), count(raw.comments), checkedAt, typeof raw.source === 'string' ? raw.source.slice(0, 40) : 'platform', now, id));
  }
  if (!statements.length) return fail(c, 400, [{ code: 'no_valid_items', message: 'Each item needs id and checked_at' }]);
  const results = await c.env.DB.batch(statements);
  return ok(c, { updated: results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0), sent: items.length });
});

ugc.post('/import', async (c) => {
  const access = await requireAccess(c, true);
  if (access instanceof Response) return access;

  let body: { rows?: ImportRow[] };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]);
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length || rows.length > 30) {
    return fail(c, 413, [{ code: 'batch_size', message: 'Import 1 to 30 sanitized rows per request' }]);
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  let accepted = 0;
  let rejected = 0;
  for (const row of rows) {
    const normalizedHandle = normalizeHandle(row.handle);
    if (!normalizedHandle) { rejected += 1; continue; }
    const platform = normalizePlatform(row.platform);
    // A matching handle on two platforms is not proof of one person. Keep a
    // creator per platform profile until an explicit link is recorded.
    const creatorId = await stableId('ugc', `${platform}:${normalizedHandle}`);
    const profileId = await stableId('ugcp', `${platform}:${normalizedHandle}`);
    const handle = textValue(row.handle, 180) ?? normalizedHandle;
    const displayName = textValue(row.display_name, 180);
    const sourceWorkbook = textValue(row.source_workbook, 180) ?? 'Blooger Database.xlsx';
    const sourceSheet = textValue(row.source_sheet, 80) ?? 'unknown';
    const sourceRow = numberValue(row.source_row, true);

    statements.push(c.env.DB.prepare(
      `INSERT INTO ugc_creators
         (id, normalized_handle, display_name, lifecycle_stage, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'new', ?4, ?4)
       ON CONFLICT(id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, ugc_creators.display_name),
         updated_at = excluded.updated_at`
    ).bind(creatorId, normalizedHandle, displayName, now));

    statements.push(c.env.DB.prepare(
      `INSERT INTO ugc_creator_platforms
         (id, creator_id, platform, handle, normalized_handle, followers,
          engagement_rate, engagement_rate_method, metrics_as_of, source, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
       ON CONFLICT(platform, normalized_handle) DO UPDATE SET
         handle = excluded.handle,
         followers = COALESCE(excluded.followers, ugc_creator_platforms.followers),
         engagement_rate = COALESCE(excluded.engagement_rate, ugc_creator_platforms.engagement_rate),
         engagement_rate_method = COALESCE(excluded.engagement_rate_method, ugc_creator_platforms.engagement_rate_method),
         metrics_as_of = COALESCE(excluded.metrics_as_of, ugc_creator_platforms.metrics_as_of),
         source = excluded.source,
         updated_at = excluded.updated_at`
    ).bind(
      profileId, creatorId, platform, handle, normalizedHandle,
      numberValue(row.followers, true), numberValue(row.engagement_rate),
      row.engagement_rate != null ? 'source_reported' : null,
      textValue(row.metrics_as_of, 40), sourceWorkbook, now,
    ));

    const hasContent = row.content_url != null || row.views != null || row.comments != null
      || (Array.isArray(row.product_codes) && row.product_codes.length > 0)
      || row.usage_label != null || row.source_rating != null || row.audio_label != null;
    if (hasContent && sourceRow != null) {
      const contentId = await stableId('ugcc', `${sourceWorkbook}:${sourceSheet}:${sourceRow}`);
      const products = Array.isArray(row.product_codes)
        ? row.product_codes.map((value) => textValue(value, 60)).filter(Boolean)
        : [];
      const productClassification = initialProductClassification(products, Boolean(textValue(row.content_url, 1000)));
      statements.push(c.env.DB.prepare(
        `INSERT INTO ugc_content
           (id, creator_id, creator_platform_id, content_url, content_type, views,
            comments, product_codes, usage_label, source_rating, source_valid,
            audio_label, download_url, source_workbook, source_sheet, source_row,
            imported_at, updated_at, product_status, product_source,
            product_confidence, product_evidence, product_checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17, ?18, ?19, ?20, ?21, ?22)
         ON CONFLICT(source_workbook, source_sheet, source_row) DO UPDATE SET
           creator_id = excluded.creator_id,
           creator_platform_id = excluded.creator_platform_id,
           content_url = excluded.content_url,
           content_type = excluded.content_type,
           views = excluded.views,
           comments = excluded.comments,
           product_codes = excluded.product_codes,
           product_status = CASE WHEN excluded.product_source = 'explicit_import' OR ugc_content.product_source IS NULL THEN excluded.product_status ELSE ugc_content.product_status END,
           product_source = CASE WHEN excluded.product_source = 'explicit_import' OR ugc_content.product_source IS NULL THEN excluded.product_source ELSE ugc_content.product_source END,
           product_confidence = CASE WHEN excluded.product_source = 'explicit_import' OR ugc_content.product_source IS NULL THEN excluded.product_confidence ELSE ugc_content.product_confidence END,
           product_evidence = CASE WHEN excluded.product_source = 'explicit_import' OR ugc_content.product_source IS NULL THEN excluded.product_evidence ELSE ugc_content.product_evidence END,
           product_checked_at = CASE WHEN excluded.product_source = 'explicit_import' OR ugc_content.product_source IS NULL THEN excluded.product_checked_at ELSE ugc_content.product_checked_at END,
           usage_label = excluded.usage_label,
           source_rating = excluded.source_rating,
           source_valid = excluded.source_valid,
           audio_label = excluded.audio_label,
           download_url = excluded.download_url,
           link_status = CASE WHEN excluded.content_url IS ugc_content.content_url THEN ugc_content.link_status ELSE NULL END,
           link_checked_at = CASE WHEN excluded.content_url IS ugc_content.content_url THEN ugc_content.link_checked_at ELSE NULL END,
           link_http_status = CASE WHEN excluded.content_url IS ugc_content.content_url THEN ugc_content.link_http_status ELSE NULL END,
           link_final_url = CASE WHEN excluded.content_url IS ugc_content.content_url THEN ugc_content.link_final_url ELSE NULL END,
           link_check_note = CASE WHEN excluded.content_url IS ugc_content.content_url THEN ugc_content.link_check_note ELSE NULL END,
           updated_at = excluded.updated_at`
      ).bind(
        contentId, creatorId, profileId, textValue(row.content_url, 1000),
        textValue(row.content_type, 80), numberValue(row.views, true),
        numberValue(row.comments, true), products.length ? JSON.stringify(products) : null,
        textValue(row.usage_label, 160), numberValue(row.source_rating),
        textValue(row.source_valid, 80), textValue(row.audio_label, 160),
        textValue(row.download_url, 1000), sourceWorkbook, sourceSheet, sourceRow, now,
        productClassification.status, productClassification.source,
        productClassification.confidence, productClassification.evidence,
        productClassification.source ? new Date(now).toISOString() : null,
      ));
    }
    accepted += 1;
  }

  if (statements.length) await c.env.DB.batch(statements);
  return ok(c, { accepted, rejected, statements: statements.length });
});

ugc.patch('/creators/:id', async (c) => {
  const access = await requireAccess(c, true);
  if (access instanceof Response) return access;
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]);
  }
  const id = c.req.param('id');
  const current = await c.env.DB.prepare(`SELECT * FROM ugc_creators WHERE id = ?1`).bind(id).first<Record<string, any>>();
  if (!current) return fail(c, 404, [{ code: 'not_found', message: 'Creator not found' }]);
  const nextStage = textValue(body.lifecycle_stage, 40) ?? current.lifecycle_stage;
  if (!UGC_STAGES.has(nextStage)) return fail(c, 422, [{ code: 'invalid_stage', message: 'Unknown lifecycle stage' }]);
  const nextOrigin = body.origin === undefined ? (current.origin ?? null) : (body.origin === null || body.origin === '' ? null : textValue(body.origin, 10));
  if (nextOrigin !== null && !UGC_ORIGINS.has(nextOrigin)) return fail(c, 422, [{ code: 'invalid_origin', message: 'origin is invited or self' }]);
  const updatedAt = Date.now();
  await c.env.DB.prepare(
    `UPDATE ugc_creators SET
       display_name=?1, category=?2, audience_market=?3, audience_language=?4,
       lifecycle_stage=?5, priority=?6, owner=?7, notes=?8, updated_at=?9, origin=?11
     WHERE id=?10`
  ).bind(
    body.display_name === undefined ? current.display_name : textValue(body.display_name, 180),
    body.category === undefined ? current.category : textValue(body.category, 120),
    body.audience_market === undefined ? current.audience_market : textValue(body.audience_market, 120),
    body.audience_language === undefined ? current.audience_language : textValue(body.audience_language, 120),
    nextStage,
    body.priority === undefined ? current.priority : textValue(body.priority, 40),
    body.owner === undefined ? current.owner : textValue(body.owner, 120),
    body.notes === undefined ? current.notes : textValue(body.notes, 3000),
    updatedAt, id, nextOrigin,
  ).run();
  return ok(c, { id, updated_at: updatedAt });
});

ugc.post('/collaborations', async (c) => {
  const access = await requireAccess(c, true);
  if (access instanceof Response) return access;
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]);
  }
  const creatorId = textValue(body.creator_id, 80);
  if (!creatorId) return fail(c, 422, [{ code: 'creator_required', message: 'creator_id required' }]);
  const exists = await c.env.DB.prepare(`SELECT id FROM ugc_creators WHERE id=?1`).bind(creatorId).first();
  if (!exists) return fail(c, 404, [{ code: 'not_found', message: 'Creator not found' }]);
  const id = textValue(body.id, 80) ?? crypto.randomUUID();
  const current = body.id
    ? await c.env.DB.prepare(`SELECT * FROM ugc_collaborations WHERE id=?1`).bind(id).first<Record<string, any>>()
    : null;
  const field = (name: string, max: number): string | null => body[name] === undefined
    ? (current?.[name] ?? null)
    : textValue(body[name], max);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO ugc_collaborations
       (id, creator_id, platform, status, contact_channel, invited_at, accepted_at,
        last_contact_at, next_action, next_action_at, offer_type, deliverables,
        product_codes, sample_status, sample_sent_at, content_due_at, published_at,
        rights_scope, rights_expires_at, owner, notes, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?22)
     ON CONFLICT(id) DO UPDATE SET
       platform=excluded.platform, status=excluded.status, contact_channel=excluded.contact_channel,
       invited_at=excluded.invited_at, accepted_at=excluded.accepted_at,
       last_contact_at=excluded.last_contact_at, next_action=excluded.next_action,
       next_action_at=excluded.next_action_at, offer_type=excluded.offer_type,
       deliverables=excluded.deliverables,
       product_codes=excluded.product_codes, sample_status=excluded.sample_status,
       sample_sent_at=excluded.sample_sent_at, content_due_at=excluded.content_due_at,
       published_at=excluded.published_at, rights_scope=excluded.rights_scope,
       rights_expires_at=excluded.rights_expires_at, owner=excluded.owner,
       notes=excluded.notes, updated_at=excluded.updated_at`
  ).bind(
    id, creatorId, field('platform', 40), field('status', 40) ?? 'new',
    field('contact_channel', 80), field('invited_at', 40),
    field('accepted_at', 40), field('last_contact_at', 40),
    field('next_action', 500), field('next_action_at', 40),
    field('offer_type', 120), field('deliverables', 1000),
    field('product_codes', 500), field('sample_status', 80),
    field('sample_sent_at', 40), field('content_due_at', 40),
    field('published_at', 40), field('rights_scope', 500),
    field('rights_expires_at', 40), field('owner', 120),
    field('notes', 3000), now,
  ).run();
  return ok(c, { id, creator_id: creatorId, updated_at: now });
});

// ---------------------------------------------------------------------------
// Barter payouts (0116, Owner 2026-10-14). Status only — never raw phone or
// bank data. Ceiling: 999 ₽ per creator per payout per day, and 5 000 ₽ for
// all creators together per day (auto-approval cap, Owner 2026-10-14).
// ---------------------------------------------------------------------------

const PAYOUT_COLUMNS = `p.id, p.creator_id, p.creator_platform_id, p.platform, p.handle, p.amount_minor,
  p.currency, p.status, p.payout_date, p.marketplace, p.phone_masked, p.bank_ref, p.note,
  p.approved_at, p.approved_by, p.sent_at, p.paid_at, p.failed_at, p.created_by,
  p.created_at, p.updated_at, c.display_name creator_display_name, c.normalized_handle creator_handle`;

type PayoutCreator = { creatorId: string; profileId: string | null; platform: string | null; handle: string | null };

async function resolvePayoutCreator(c: any, body: Record<string, unknown>, now: number): Promise<PayoutCreator | Response> {
  const creatorId = textValue(body.creator_id, 80);
  if (creatorId) {
    const creator = await c.env.DB.prepare(`SELECT id FROM ugc_creators WHERE id=?1`).bind(creatorId).first();
    if (!creator) return fail(c, 404, [{ code: 'not_found', message: 'Creator not found' }]);
    const profile = await c.env.DB.prepare(
      `SELECT id, platform, handle FROM ugc_creator_platforms WHERE creator_id=?1 ORDER BY COALESCE(followers, -1) DESC LIMIT 1`
    ).bind(creatorId).first() as Record<string, any> | null;
    return { creatorId, profileId: profile?.id ?? null, platform: profile?.platform ?? null, handle: profile?.handle ?? null };
  }
  const normalizedHandle = normalizeHandle(body.handle);
  if (!normalizedHandle) return fail(c, 422, [{ code: 'creator_required', message: 'creator_id or handle required' }]);
  const platform = normalizePlatform(body.platform ?? 'instagram');
  const existing = await c.env.DB.prepare(
    `SELECT id, creator_id, handle FROM ugc_creator_platforms WHERE platform=?1 AND normalized_handle=?2`
  ).bind(platform, normalizedHandle).first() as Record<string, any> | null;
  if (existing) return { creatorId: String(existing.creator_id), profileId: String(existing.id), platform, handle: String(existing.handle) };
  // Minimal record with the same stable ids the XLSX import uses, so a later
  // import of the same handle lands on this creator instead of a twin.
  const newCreatorId = await stableId('ugc', `${platform}:${normalizedHandle}`);
  const profileId = await stableId('ugcp', `${platform}:${normalizedHandle}`);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO ugc_creators (id, normalized_handle, lifecycle_stage, created_at, updated_at)
       VALUES (?1, ?2, 'agreed', ?3, ?3) ON CONFLICT(id) DO NOTHING`
    ).bind(newCreatorId, normalizedHandle, now),
    c.env.DB.prepare(
      `INSERT INTO ugc_creator_platforms (id, creator_id, platform, handle, normalized_handle, profile_url, source, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, 'ugc_payout', ?6, ?6) ON CONFLICT(platform, normalized_handle) DO NOTHING`
    ).bind(profileId, newCreatorId, platform, normalizedHandle,
      platform === 'instagram' ? `https://www.instagram.com/${normalizedHandle}/` : null, now),
  ]);
  return { creatorId: newCreatorId, profileId, platform, handle: normalizedHandle };
}

async function sameDayPayoutMinor(c: any, creatorId: string, day: string, excludeId: string | null): Promise<number> {
  const row = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(amount_minor), 0) total FROM ugc_payouts
     WHERE creator_id=?1 AND payout_date=?2 AND status IN ('sent','paid') AND (?3 IS NULL OR id <> ?3)`
  ).bind(creatorId, day, excludeId).first() as { total: number } | null;
  return Number(row?.total ?? 0);
}

// Every creator's live payouts on that date; failed ones do not count.
async function dayTotalPayoutMinor(c: any, day: string, excludeId: string | null): Promise<number> {
  const row = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(amount_minor), 0) total FROM ugc_payouts
     WHERE payout_date=?1 AND status IN ('sent','paid') AND (?2 IS NULL OR id <> ?2)`
  ).bind(day, excludeId).first() as { total: number } | null;
  return Number(row?.total ?? 0);
}

function isoOrNull(value: unknown): string | null {
  const text = textValue(value, 40);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

ugc.get('/payouts', async (c) => {
  const access = await requireAccess(c);
  if (access instanceof Response) return access;
  const creatorId = textValue(c.req.query('creator_id'), 80);
  const status = textValue(c.req.query('status'), 40);
  if (status && !isPayoutStatus(status)) return fail(c, 422, [{ code: 'invalid_status', message: 'Unknown payout status' }]);
  const rows = await c.env.DB.prepare(
    `SELECT ${PAYOUT_COLUMNS} FROM ugc_payouts p JOIN ugc_creators c ON c.id = p.creator_id
     WHERE (?1 IS NULL OR p.creator_id = ?1) AND (?2 IS NULL OR p.status = ?2)
     ORDER BY p.updated_at DESC LIMIT 500`
  ).bind(creatorId, status).all<Record<string, any>>();
  return ok(c, { payouts: rows.results ?? [] });
});

ugc.post('/payouts', async (c) => {
  const access = await requireAccess(c, true);
  if (access instanceof Response) return access;
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]);
  }
  const amount = parsePayoutAmount(body);
  if (!amount.ok) return fail(c, 422, [{ code: amount.code, message: amount.message }]);
  const status = textValue(body.status, 40) ?? 'awaiting_approval';
  if (!isPayoutStatus(status)) return fail(c, 422, [{ code: 'invalid_status', message: 'Unknown payout status' }]);
  const now = Date.now();
  const day = payoutDate(body.payout_date, now);
  const creator = await resolvePayoutCreator(c, body, now);
  if (creator instanceof Response) return creator;
  // DH-LAW-261016-01: register every ready payout in one queue. Daily caps
  // apply when money is sent, never by moving waiting entries to another day.
  if (status === 'sent' || status === 'paid') {
    const daily = checkDailyLimit(await sameDayPayoutMinor(c, creator.creatorId, day, null), amount.amount_minor);
    if (!daily.ok) return fail(c, 422, [{ code: daily.code, message: daily.message }]);
    const total = checkDailyTotalLimit(await dayTotalPayoutMinor(c, day, null), amount.amount_minor);
    if (!total.ok) return fail(c, 422, [{ code: total.code, message: total.message }]);
  }
  const stampAt = isoOrNull(body.status_at) ?? new Date(now).toISOString();
  const stampColumn = statusStampColumn(status);
  const stamp = (column: string) => (stampColumn === column ? stampAt : isoOrNull(body[column]));
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO ugc_payouts
       (id, creator_id, creator_platform_id, platform, handle, amount_minor, currency, status,
        payout_date, marketplace, phone_masked, bank_ref, note, approved_at, approved_by,
        sent_at, paid_at, failed_at, created_by, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,'RUB',?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?19)`
  ).bind(
    id, creator.creatorId, creator.profileId, creator.platform, creator.handle, amount.amount_minor, status,
    day, textValue(body.marketplace, 40), maskPhone(body.phone ?? body.phone_masked),
    textValue(body.bank_ref, 200), textValue(body.note, 1000),
    stamp('approved_at'), stampColumn === 'approved_at' ? access.name ?? null : textValue(body.approved_by, 120),
    stamp('sent_at'), stamp('paid_at'), stamp('failed_at'), access.name ?? null, now,
  ).run();
  return ok(c, { id, creator_id: creator.creatorId, amount_minor: amount.amount_minor, status, payout_date: day, updated_at: now });
});

ugc.patch('/payouts/:id', async (c) => {
  const access = await requireAccess(c, true);
  if (access instanceof Response) return access;
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]);
  }
  const id = c.req.param('id');
  const current = await c.env.DB.prepare(`SELECT * FROM ugc_payouts WHERE id=?1`).bind(id).first<Record<string, any>>();
  if (!current) return fail(c, 404, [{ code: 'not_found', message: 'Payout not found' }]);
  let amountMinor = Number(current.amount_minor);
  if (body.amount_rub !== undefined || body.amount_minor !== undefined) {
    const amount = parsePayoutAmount(body);
    if (!amount.ok) return fail(c, 422, [{ code: amount.code, message: amount.message }]);
    amountMinor = amount.amount_minor;
  }
  const day = body.payout_date === undefined ? String(current.payout_date) : payoutDate(body.payout_date, Date.now());
  // Waiting payouts are not scheduled reservations. Keep checks on sent/paid records.
  const amountOrDate = body.amount_rub !== undefined || body.amount_minor !== undefined || body.payout_date !== undefined;
  if (amountOrDate && (current.status === 'sent' || current.status === 'paid')) {
    const daily = checkDailyLimit(await sameDayPayoutMinor(c, String(current.creator_id), day, id), amountMinor);
    if (!daily.ok) return fail(c, 422, [{ code: daily.code, message: daily.message }]);
    const total = checkDailyTotalLimit(await dayTotalPayoutMinor(c, day, id), amountMinor);
    if (!total.ok) return fail(c, 422, [{ code: total.code, message: total.message }]);
  }
  const keep = (name: string, max: number) => (body[name] === undefined ? current[name] : textValue(body[name], max));
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE ugc_payouts SET amount_minor=?1, payout_date=?2, marketplace=?3, phone_masked=?4,
       bank_ref=?5, note=?6, updated_at=?7 WHERE id=?8`
  ).bind(
    amountMinor, day, keep('marketplace', 40),
    body.phone === undefined && body.phone_masked === undefined ? current.phone_masked : maskPhone(body.phone ?? body.phone_masked),
    keep('bank_ref', 200), keep('note', 1000), now, id,
  ).run();
  return ok(c, { id, amount_minor: amountMinor, payout_date: day, updated_at: now });
});

ugc.post('/payouts/:id/status', async (c) => {
  const access = await requireAccess(c, true);
  if (access instanceof Response) return access;
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]);
  }
  const status = textValue(body.status, 40);
  if (!status || !isPayoutStatus(status)) return fail(c, 422, [{ code: 'invalid_status', message: 'status must be awaiting_approval, approved, sent, paid or failed' }]);
  const id = c.req.param('id');
  const current = await c.env.DB.prepare(`SELECT id FROM ugc_payouts WHERE id=?1`).bind(id).first();
  if (!current) return fail(c, 404, [{ code: 'not_found', message: 'Payout not found' }]);
  const now = Date.now();
  const at = isoOrNull(body.at) ?? new Date(now).toISOString();
  const column = statusStampColumn(status);
  // The column name comes from a fixed map, never from the request.
  const stampSql = column ? `, ${column}=?5` : '';
  const approvedBySql = column === 'approved_at' ? ', approved_by=?6' : '';
  await c.env.DB.prepare(
    `UPDATE ugc_payouts SET status=?1, updated_at=?2,
       bank_ref=COALESCE(?3, bank_ref), note=COALESCE(?4, note)${stampSql}${approvedBySql}
     WHERE id=?7`
  ).bind(status, now, textValue(body.bank_ref, 200), textValue(body.note, 1000), at, access.name ?? null, id).run();
  return ok(c, { id, status, at, updated_at: now });
});

// ---------------------------------------------------------------------------
// Konsol Payment Service (0119, Owner 2026-10-14). Execute = auto-approve within
// the limits, own-RUB check (overdraft never), one Konsol payment per row.
// ---------------------------------------------------------------------------

// The full phone goes to ugc_payout_requisites only; the payout row keeps a mask.
ugc.put('/payouts/:id/requisites', async (c) => {
  const access = await requireAccess(c, true);
  if (access instanceof Response) return access;
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]);
  }
  const id = c.req.param('id');
  const current = await c.env.DB.prepare(`SELECT id, konsol_payment_id FROM ugc_payouts WHERE id=?1`).bind(id).first<Record<string, any>>();
  if (!current) return fail(c, 404, [{ code: 'not_found', message: 'Payout not found' }]);
  if (current.konsol_payment_id) return fail(c, 409, [{ code: 'already_sent', message: 'Payout already handed to Konsol' }]);
  const phone = konsolPhone(body.phone ?? body.fps_mobile_phone);
  if (!phone) return fail(c, 422, [{ code: 'invalid_phone', message: 'Russian mobile number required (+79…)' }]);
  const bankId = textValue(body.fps_bank_member_id, 20);
  if (!isFpsBankMemberId(bankId)) return fail(c, 422, [{ code: 'invalid_bank', message: 'fps_bank_member_id must be the 12-digit SBP id' }]);
  const firstName = textValue(body.first_name, 120);
  const lastName = textValue(body.last_name, 120);
  if (!firstName || !lastName) return fail(c, 422, [{ code: 'name_required', message: 'first_name and last_name required by Konsol' }]);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO ugc_payout_requisites (payout_id, fps_mobile_phone, first_name, last_name, patronymic, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(payout_id) DO UPDATE SET fps_mobile_phone=excluded.fps_mobile_phone, first_name=excluded.first_name,
         last_name=excluded.last_name, patronymic=excluded.patronymic, updated_at=excluded.updated_at`
    ).bind(id, phone, firstName, lastName, textValue(body.patronymic, 120), now),
    c.env.DB.prepare(
      `UPDATE ugc_payouts SET phone_masked=?2, fps_bank_member_id=?3, bank_ref=COALESCE(?4, bank_ref), updated_at=?5 WHERE id=?1`
    ).bind(id, maskPhoneWide(phone), bankId, textValue(body.bank_ref, 200), now),
  ]);
  return ok(c, { id, phone_masked: maskPhoneWide(phone), fps_bank_member_id: bankId, updated_at: now });
});

ugc.post('/payouts/:id/execute', async (c) => {
  const access = await requireAccess(c, true);
  if (access instanceof Response) return access;
  // The Owner pays by hand (Owner 2026-10-15): only Admin may send money to Konsol.
  if (access.role !== 'admin') return fail(c, 403, [{ code: 'admin_only', message: 'Only the Owner (Admin) can pay' }]);
  const out = await executeUgcPayout(c.env, c.req.param('id'));
  if (!out.ok) return fail(c, out.http as 400, [{ code: out.code ?? 'failed', message: out.message ?? 'Payout not executed' }]);
  return c.json({ success: true, result: { already: out.already === true, payout: out.payout }, errors: [], messages: [] }, out.http as 200);
});

ugc.post('/payouts/:id/refresh', async (c) => {
  const access = await requireAccess(c, true);
  if (access instanceof Response) return access;
  const out = await refreshUgcPayout(c.env, c.req.param('id'));
  if (!out.ok) return fail(c, out.http as 400, [{ code: String(out.code ?? 'failed'), message: String((out as { message?: string }).message ?? 'Refresh failed') }]);
  return ok(c, out);
});

// Same job as the evening timer; once per Yerevan day unless force=1.
ugc.post('/payouts/summary', async (c) => {
  const access = await requireAccess(c, true);
  if (access instanceof Response) return access;
  try {
    return ok(c, { note: await ugcPayoutEvening(c.env, { force: c.req.query('force') === '1' }) });
  } catch (e) {
    return fail(c, 502, [{ code: 'summary_failed', message: e instanceof Error ? e.message : String(e) }]);
  }
});

export default ugc;
