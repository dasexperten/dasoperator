import { Hono } from 'hono';
import type { Env } from '../types';
import { fail, ok } from '../lib/responses';
import { hasModuleAccess, validateSession, type AuthUser } from '../lib/auth';

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

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

ugc.get('/', async (c) => {
  const access = await requireAccess(c);
  if (access instanceof Response) return access;

  const platform = normalizePlatform(c.req.query('platform'));
  const usePlatform = c.req.query('platform') && c.req.query('platform') !== 'all' ? platform : null;
  const search = textValue(c.req.query('search'), 120)?.toLowerCase() ?? '';
  const stage = textValue(c.req.query('stage'), 80);

  const profiles = await c.env.DB.prepare(
    `SELECT
       c.id creator_id, c.normalized_handle creator_handle, c.display_name,
       c.category, c.audience_market, c.audience_language, c.lifecycle_stage,
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
     ORDER BY COALESCE(p.followers, -1) DESC, COALESCE(c.display_name, p.handle) ASC
     LIMIT 1500`
  ).bind(usePlatform, search, stage).all<Record<string, any>>();

  const metricRows = await c.env.DB.prepare(
    `SELECT creator_id, creator_platform_id, views, comments
     FROM ugc_content
     WHERE views IS NOT NULL OR comments IS NOT NULL
     ORDER BY source_sheet, source_row`
  ).all<{ creator_id: string; creator_platform_id: string; views: number | null; comments: number | null }>();

  const contentCounts = await c.env.DB.prepare(
    `SELECT creator_id, creator_platform_id, COUNT(*) content_count
     FROM ugc_content GROUP BY creator_id, creator_platform_id`
  ).all<{ creator_id: string; creator_platform_id: string; content_count: number }>();

  const collaborations = await c.env.DB.prepare(
    `SELECT * FROM ugc_collaborations ORDER BY updated_at DESC`
  ).all<Record<string, any>>();

  const byProfile = new Map<string, { views: number[]; comments: number[]; content_count: number }>();
  for (const row of metricRows.results ?? []) {
    const entry = byProfile.get(row.creator_platform_id) ?? { views: [], comments: [], content_count: 0 };
    if (row.views != null) entry.views.push(Number(row.views));
    if (row.comments != null) entry.comments.push(Number(row.comments));
    byProfile.set(row.creator_platform_id, entry);
  }
  for (const row of contentCounts.results ?? []) {
    const entry = byProfile.get(row.creator_platform_id) ?? { views: [], comments: [], content_count: 0 };
    entry.content_count = Number(row.content_count || 0);
    byProfile.set(row.creator_platform_id, entry);
  }

  const latestCollaboration = new Map<string, Record<string, any>>();
  for (const row of collaborations.results ?? []) {
    if (!latestCollaboration.has(String(row.creator_id))) latestCollaboration.set(String(row.creator_id), row);
  }

  const creators = new Map<string, Record<string, any>>();
  for (const row of profiles.results ?? []) {
    const metrics = byProfile.get(String(row.profile_id)) ?? { views: [], comments: [], content_count: 0 };
    const profile = {
      id: row.profile_id,
      platform: row.platform,
      handle: row.handle,
      profile_url: row.profile_url,
      followers: row.followers,
      engagement_rate: row.engagement_rate,
      engagement_rate_method: row.engagement_rate_method,
      avg_video_views: metrics.views.length >= 2
        ? metrics.views.reduce((sum, value) => sum + value, 0) / metrics.views.length
        : row.avg_video_views,
      median_video_views: metrics.views.length >= 2 ? median(metrics.views) : row.median_video_views,
      latest_observed_views: metrics.views.length === 1 ? metrics.views[0] : null,
      view_observations: metrics.views.length,
      avg_comments: metrics.comments.length >= 2
        ? metrics.comments.reduce((sum, value) => sum + value, 0) / metrics.comments.length
        : row.avg_comments,
      posting_cadence: row.posting_cadence,
      commerce_clicks: row.commerce_clicks,
      commerce_orders: row.commerce_orders,
      commerce_gmv_minor: row.commerce_gmv_minor,
      commerce_currency: row.commerce_currency,
      metrics_as_of: row.metrics_as_of,
      source: row.source,
      content_count: metrics.content_count,
      updated_at: row.profile_updated_at,
    };
    const creatorId = String(row.creator_id);
    const creator = creators.get(creatorId) ?? {
      id: creatorId,
      normalized_handle: row.creator_handle,
      display_name: row.display_name,
      category: row.category,
      audience_market: row.audience_market,
      audience_language: row.audience_language,
      lifecycle_stage: row.lifecycle_stage,
      priority: row.priority,
      owner: row.owner,
      notes: row.notes,
      updated_at: row.creator_updated_at,
      profiles: [],
      collaboration: latestCollaboration.get(creatorId) ?? null,
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
       (SELECT COUNT(*) FROM ugc_collaborations WHERE status IN ('invited','accepted','sample_delivered')) active_outreach,
       (SELECT COUNT(*) FROM ugc_collaborations WHERE status = 'published') published
    `
  ).first<Record<string, number>>();

  return ok(c, {
    creators: Array.from(creators.values()),
    summary: totals ?? { creators: 0, profiles: 0, content_items: 0, active_outreach: 0, published: 0 },
    platforms: platformCounts.results ?? [],
  });
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
       VALUES (?1, ?2, ?3, 'found', ?4, ?4)
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
      statements.push(c.env.DB.prepare(
        `INSERT INTO ugc_content
           (id, creator_id, creator_platform_id, content_url, content_type, views,
            comments, product_codes, usage_label, source_rating, source_valid,
            audio_label, download_url, source_workbook, source_sheet, source_row,
            imported_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)
         ON CONFLICT(source_workbook, source_sheet, source_row) DO UPDATE SET
           creator_id = excluded.creator_id,
           creator_platform_id = excluded.creator_platform_id,
           content_url = excluded.content_url,
           content_type = excluded.content_type,
           views = excluded.views,
           comments = excluded.comments,
           product_codes = excluded.product_codes,
           usage_label = excluded.usage_label,
           source_rating = excluded.source_rating,
           source_valid = excluded.source_valid,
           audio_label = excluded.audio_label,
           download_url = excluded.download_url,
           updated_at = excluded.updated_at`
      ).bind(
        contentId, creatorId, profileId, textValue(row.content_url, 1000),
        textValue(row.content_type, 80), numberValue(row.views, true),
        numberValue(row.comments, true), products.length ? JSON.stringify(products) : null,
        textValue(row.usage_label, 160), numberValue(row.source_rating),
        textValue(row.source_valid, 80), textValue(row.audio_label, 160),
        textValue(row.download_url, 1000), sourceWorkbook, sourceSheet, sourceRow, now,
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
  const allowedStages = new Set(['found', 'qualified', 'invited', 'accepted', 'sample_delivered', 'published', 'orders_mature', 'renew', 'stop']);
  const nextStage = textValue(body.lifecycle_stage, 40) ?? current.lifecycle_stage;
  if (!allowedStages.has(nextStage)) return fail(c, 422, [{ code: 'invalid_stage', message: 'Unknown lifecycle stage' }]);
  const updatedAt = Date.now();
  await c.env.DB.prepare(
    `UPDATE ugc_creators SET
       display_name=?1, category=?2, audience_market=?3, audience_language=?4,
       lifecycle_stage=?5, priority=?6, owner=?7, notes=?8, updated_at=?9
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
    updatedAt, id,
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
    id, creatorId, field('platform', 40), field('status', 40) ?? 'found',
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

export default ugc;
