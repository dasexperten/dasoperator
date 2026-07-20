// =============================================================================
// Tamara Haar — Customer Support marketplace credentials (reviews + Q&A)
//
// Owner 2026-07-20: WB reviews token + Ozon API key for the postsale / review
// engine are owned by agent Tamara. Cloudflare secret *names* are prefixed
// TAMARA_ so ownership is visible in the Worker dashboard.
//
// Resolution order (never log secret values):
//   1. TAMARA_* binding (preferred — Tamara lane)
//   2. legacy shared binding (fallback until fully cut over)
// =============================================================================

import type { Env } from '../types';

/** Wildberries feedbacks-api / questions (reviews token category). */
export function tamaraWbReviewsToken(env: Env): string {
  const v =
    (env.TAMARA_WB_API_TOKEN_REVIEWS && String(env.TAMARA_WB_API_TOKEN_REVIEWS).trim()) ||
    (env.WB_API_TOKEN_REVIEWS && String(env.WB_API_TOKEN_REVIEWS).trim()) ||
    '';
  return v;
}

/** Ozon Seller API key used by review draft-prep + questions sync (Tamara lane). */
export function tamaraOzonApiKey(env: Env): string {
  const v =
    (env.TAMARA_OZON_API_KEY && String(env.TAMARA_OZON_API_KEY).trim()) ||
    (env.OZON_API_KEY && String(env.OZON_API_KEY).trim()) ||
    '';
  return v;
}

/** Ozon Client-Id — still org-shared unless a Tamara-specific id is added later. */
export function tamaraOzonClientId(env: Env): string {
  const v =
    (env.TAMARA_OZON_CLIENT_ID && String(env.TAMARA_OZON_CLIENT_ID).trim()) ||
    (env.OZON_CLIENT_ID && String(env.OZON_CLIENT_ID).trim()) ||
    '';
  return v;
}

export function requireTamaraWbReviewsToken(env: Env): string {
  const t = tamaraWbReviewsToken(env);
  if (!t) {
    throw new Error(
      'Tamara WB reviews token not configured (set TAMARA_WB_API_TOKEN_REVIEWS or WB_API_TOKEN_REVIEWS)',
    );
  }
  return t;
}

export function ozonHeadersForTamara(env: Env): Record<string, string> {
  const clientId = tamaraOzonClientId(env);
  const apiKey = tamaraOzonApiKey(env);
  if (!clientId || !apiKey) {
    throw new Error(
      'Tamara Ozon credentials incomplete (need OZON_CLIENT_ID + TAMARA_OZON_API_KEY or OZON_API_KEY)',
    );
  }
  return {
    'Client-Id': clientId,
    'Api-Key': apiKey,
    'Content-Type': 'application/json',
  };
}

/** Which binding actually supplied the value — for health UI only (no secret). */
export function tamaraCredSource(
  env: Env,
  kind: 'wb_reviews' | 'ozon_key',
): 'TAMARA_*' | 'legacy' | 'missing' {
  if (kind === 'wb_reviews') {
    if (env.TAMARA_WB_API_TOKEN_REVIEWS) return 'TAMARA_*';
    if (env.WB_API_TOKEN_REVIEWS) return 'legacy';
    return 'missing';
  }
  if (env.TAMARA_OZON_API_KEY) return 'TAMARA_*';
  if (env.OZON_API_KEY) return 'legacy';
  return 'missing';
}
