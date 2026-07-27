// =============================================================================
// Ozon review auto-reply module (Phase: Reviews v1 — Ozon channel)
//
// Mirrors the WB path (api/src/lib/wb-reviews.ts), current "Reply-All" model:
//   - cron PREPARES drafts only (status='pending', channel='ozon') using the
//     full 6-gate review-master pipeline (review-master-pipeline.ts).
//   - a human publishes them in a batch from the /reviews page (reply-all),
//     which posts to Ozon via postOzonComment().
//
// Ozon Seller API review methods are beta (since 2024-12) and require the
// Premium Plus subscription. Ingestion (/v1/review/list) already runs in
// production (routes/mp-feeds.ts), so access is active.
//
// Posting endpoint: POST /v1/review/comment/create
//   body: { review_id, text, mark_review_as_processed, parent_comment_id? }
//   -> { comment_id }
// =============================================================================

import type { Env } from '../types';
import {
  runReviewMasterPipeline,
  runRatingOnlyPipeline,
  type PipelineInput,
} from './review-master-pipeline';
import { ozonHeadersForTamara } from './tamara-marketplace-creds';

const OZ_BASE = 'https://api-seller.ozon.ru';

function ozHeaders(env: Env): Record<string, string> {
  // Prefer TAMARA_OZON_API_KEY (Tamara review/Q&A lane) → legacy OZON_API_KEY
  return ozonHeadersForTamara(env);
}

// -----------------------------------------------------------------------------
// Post a reply comment to an Ozon review and mark it processed.
// -----------------------------------------------------------------------------
export async function postOzonComment(env: Env, reviewId: string, text: string): Promise<void> {
  const r = await fetch(`${OZ_BASE}/v1/review/comment/create`, {
    method: 'POST',
    headers: ozHeaders(env),
    body: JSON.stringify({ review_id: reviewId, text, mark_review_as_processed: true }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Ozon comment HTTP ${r.status}: ${body.slice(0, 300)}`);
  }
}

// -----------------------------------------------------------------------------
// Build ozon_sku (numeric) -> { offerId, catalogSku } map from the stocks API.
// catalogSku is the lowercased offer_id when it matches a row in `products`
// (our DE-code, e.g. "de206"); the review-master pipeline's loadSkuKnowledge
// uppercases + strips the trailing pack letters to find the product card.
// Inlined here (not imported from routes/) to keep the lib layer standalone.
// -----------------------------------------------------------------------------
interface OzSkuInfo { offerId: string; catalogSku: string | null }

async function buildOzonSkuMap(env: Env): Promise<Map<number, OzSkuInfo>> {
  const catalog = await env.DB.prepare('SELECT id FROM products WHERE deleted_at IS NULL').all<{ id: string }>();
  const ids = new Set<string>((catalog.results ?? []).map((r) => r.id));
  const map = new Map<number, OzSkuInfo>();
  let cursor = '';
  let guard = 0;
  while (guard++ < 50) {
    const resp = await fetch(`${OZ_BASE}/v4/product/info/stocks`, {
      method: 'POST',
      headers: ozHeaders(env),
      body: JSON.stringify({ filter: { visibility: 'ALL' }, limit: 200, cursor }),
    });
    if (!resp.ok) break;
    const data = await resp.json<{ items?: any[]; cursor?: string }>();
    for (const item of (data.items ?? [])) {
      const offerId = (item.offer_id as string) || '';
      const catalogSku = ids.has(offerId.toLowerCase()) ? offerId.toLowerCase() : null;
      for (const stock of (item.stocks ?? [])) {
        const ozonSku = stock.sku as number | undefined;
        if (ozonSku && !map.has(ozonSku)) map.set(ozonSku, { offerId, catalogSku });
      }
    }
    if (!data.cursor || data.cursor === cursor) break;
    cursor = data.cursor;
  }
  return map;
}

// -----------------------------------------------------------------------------
// Fetch a page of Ozon reviews. status: ALL | UNPROCESSED | PROCESSED.
// -----------------------------------------------------------------------------
async function fetchOzonReviewPage(
  env: Env,
  status: 'ALL' | 'UNPROCESSED' | 'PROCESSED',
  limit: number,
  lastId?: string,
): Promise<{ reviews: any[]; hasNext: boolean; lastId: string | undefined }> {
  const body: any = { limit, sort_dir: 'DESC', status };
  if (lastId) body.last_id = lastId;
  const r = await fetch(`${OZ_BASE}/v1/review/list`, {
    method: 'POST',
    headers: ozHeaders(env),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const b = await r.text().catch(() => '');
    throw new Error(`Ozon reviews HTTP ${r.status}: ${b.slice(0, 300)}`);
  }
  const j = await r.json<{ reviews?: any[]; has_next?: boolean; last_id?: string }>();
  return { reviews: j.reviews ?? [], hasNext: Boolean(j.has_next), lastId: j.last_id };
}

export interface OzonPrepResult {
  status: 'ok' | 'error';
  inspected: number;
  drafted: number;
  skipped: number;      // already answered / already drafted
  ratingOnly: number;
  errors: { reviewId?: string; stage: string; error: string }[];
  durationMs: number;
  details: { reviewId: string; rating: number; sku: string; replyChars: number }[];
}

// -----------------------------------------------------------------------------
// Generate draft replies for unprocessed Ozon reviews and upsert them into
// review_drafts (channel='ozon', status='pending'). Does NOT post to Ozon —
// publishing is a human batch action (reply-all) or per-draft publish.
// -----------------------------------------------------------------------------
export async function runOzonDraftPrep(
  env: Env,
  opts: { maxDrafts?: number; maxInspect?: number } = {},
): Promise<OzonPrepResult> {
  const startedAt = Date.now();
  const maxDrafts = Math.max(1, opts.maxDrafts ?? 15);
  // Only ~19% of the Ozon queue carries text; the rest is parked without an LLM
  // call, so inspection must reach much deeper than the draft budget.
  const maxInspect = Math.max(maxDrafts, opts.maxInspect ?? 300);

  const result: OzonPrepResult = {
    status: 'ok', inspected: 0, drafted: 0, skipped: 0, ratingOnly: 0,
    errors: [], durationMs: 0, details: [],
  };

  let skuMap: Map<number, OzSkuInfo>;
  try {
    skuMap = await buildOzonSkuMap(env);
  } catch (e: any) {
    // Non-fatal: fall back to raw numeric sku with no catalog mapping.
    skuMap = new Map();
    result.errors.push({ stage: 'sku-map', error: String(e?.message ?? e).slice(0, 200) });
  }

  let lastId: string | undefined;
  let hasNext = true;
  const pageSize = Math.min(100, maxInspect);

  while (hasNext && result.inspected < maxInspect && result.drafted < maxDrafts) {
    let page: { reviews: any[]; hasNext: boolean; lastId: string | undefined };
    try {
      page = await fetchOzonReviewPage(env, 'UNPROCESSED', pageSize, lastId);
    } catch (e: any) {
      result.errors.push({ stage: 'list', error: String(e?.message ?? e) });
      result.status = 'error';
      break;
    }
    if (page.reviews.length === 0) break;
    hasNext = page.hasNext;
    lastId = page.lastId;

    for (const rv of page.reviews) {
      if (result.inspected >= maxInspect || result.drafted >= maxDrafts) break;
      result.inspected++;

      const reviewId = String(rv.id ?? '');
      if (!reviewId) continue;
      const rating = Number(rv.rating) || 0;
      const text = String(rv.text ?? '').trim();
      const ozonSku = Number(rv.sku) || 0;
      const info = skuMap.get(ozonSku);
      const productSku = info?.catalogSku ?? (info?.offerId || String(ozonSku || ''));

      // Skip reviews already resolved (posted/rejected). Regenerate only when
      // there is no row yet or it is still pending/held.
      const existing = await env.DB.prepare(
        `SELECT status FROM review_drafts WHERE channel = 'ozon' AND external_id = ?`
      ).bind(reviewId).first<{ status: string }>();
      if (existing && !['pending', 'held', 'failed'].includes(existing.status)) {
        result.skipped++;
        continue;
      }

      // Resolve product name from catalog when we mapped it.
      let productName: string | null = null;
      if (info?.catalogSku) {
        const prod = await env.DB.prepare(
          `SELECT product_name FROM products WHERE id = ?`
        ).bind(info.catalogSku).first<{ product_name: string }>();
        productName = prod?.product_name ?? null;
      }

      const hasText = text.length > 0;
      if (!hasText) {
        // Owner 2026-07-27: Ozon refuses comments on text-less reviews
        // («createComment: cannot comment on empty review»), so a draft for one
        // can never be published. Park it instead of burning ~7.3k tokens.
        result.ratingOnly++;
        result.skipped++;
        try {
          await env.DB.prepare(`
            INSERT INTO review_drafts
              (id, channel, external_id, rating, product_name, product_sku, status,
               rejection_reason, created_at, updated_at)
            VALUES (?, 'ozon', ?, ?, ?, ?, 'rejected', 'ozon_empty_review', datetime('now'), datetime('now'))
            ON CONFLICT(channel, external_id) DO UPDATE SET
              status = 'rejected',
              rejection_reason = 'ozon_empty_review',
              updated_at = datetime('now')
            WHERE review_drafts.status IN ('pending', 'held', 'failed')
          `).bind(`rd_${crypto.randomUUID()}`, reviewId, rating, productName, productSku || null).run();
        } catch { /* parking is best-effort */ }
        continue;
      }

      const input: PipelineInput = {
        feedbackId: reviewId,
        rating,
        customerName: null, // Ozon review list does not expose buyer name
        productName: productName ?? (productSku || null),
        productSku: productSku || null,
        reviewText: hasText ? text : null,
        pros: null,
        cons: null,
      };

      let reply = '';
      let tokensIn = 0, tokensOut = 0;
      try {
        const pr = hasText
          ? await runReviewMasterPipeline(env, input)
          : await runRatingOnlyPipeline(env, input);
        reply = pr.reply;
        tokensIn = pr.totalTokensIn;
        tokensOut = pr.totalTokensOut;
      } catch (e: any) {
        result.errors.push({ reviewId, stage: 'pipeline', error: String(e?.message ?? e).slice(0, 200) });
        continue;
      }
      if (!reply) {
        result.errors.push({ reviewId, stage: 'pipeline', error: 'empty reply' });
        continue;
      }

      try {
        await env.DB.prepare(`
          INSERT INTO review_drafts
            (id, channel, external_id, rating, customer_name, product_name, product_sku,
             review_text, draft_text, status, draft_tokens_in, draft_tokens_out, created_at, updated_at)
          VALUES (?, 'ozon', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(channel, external_id) DO UPDATE SET
            rating = excluded.rating,
            product_name = excluded.product_name,
            product_sku = excluded.product_sku,
            review_text = excluded.review_text,
            draft_text = excluded.draft_text,
            draft_tokens_in = excluded.draft_tokens_in,
            draft_tokens_out = excluded.draft_tokens_out,
            updated_at = datetime('now')
          WHERE review_drafts.status IN ('pending', 'held', 'failed')
        `).bind(
          `rd_${crypto.randomUUID()}`,
          reviewId,
          rating,
          null,
          productName,
          productSku || null,
          hasText ? text : null,
          reply,
          tokensIn,
          tokensOut,
        ).run();
      } catch (e: any) {
        result.errors.push({ reviewId, stage: 'upsert', error: String(e?.message ?? e).slice(0, 200) });
        continue;
      }

      result.drafted++;
      result.details.push({ reviewId, rating, sku: productSku || String(ozonSku), replyChars: reply.length });
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
