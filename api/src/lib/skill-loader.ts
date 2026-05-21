// =============================================================================
// Skill Loader — reads skills from R2 bucket `das-skills`, caches in KV.
//
// Architecture:
//   R2 (source of truth) ← GitHub workflow syncs from arams-db
//        ↓ read on first miss
//   KV cache (1 hour TTL) ← Worker reads here on hot path
//        ↓
//   Worker code uses the .md contents as prompts/data
//
// Layout in R2:
//   manifest.json                                — root manifest with sku_index
//   skills/{skill-name}/SKILL.md                 — instruction file for each skill
//   skills/{skill-name}/references/{file}        — supporting data
//   skills/{skill-name}/references/{subdir}/{file}
//
// Usage:
//   const md = await loadSkillFile(env, 'skills/review-master/SKILL.md');
//   const manifest = await loadManifest(env);
//   const sku = await loadSkuKnowledge(env, 'DE206');
// =============================================================================

import type { Env } from '../types';

const CACHE_KEY_PREFIX = 'skill-loader:';
const CACHE_TTL_SEC = 3600; // 1 hour

// ----------------- manifest.json -----------------
export interface SkillManifest {
  version: string;
  skills: Record<
    string,
    { files: Array<{ path: string; size: number }>; total_bytes: number; file_count: number }
  >;
  sku_index: Record<string, { sku_card?: string; ingredients?: string }>;
}

export async function loadManifest(env: Env): Promise<SkillManifest> {
  const cacheKey = `${CACHE_KEY_PREFIX}manifest`;
  if (env.CACHE) {
    const cached = await env.CACHE.get(cacheKey, 'json');
    if (cached) return cached as SkillManifest;
  }
  // R2 fetch
  if (!env.SKILLS_BUCKET) throw new Error('SKILLS_BUCKET binding missing');
  const obj = await env.SKILLS_BUCKET.get('manifest.json');
  if (!obj) throw new Error('manifest.json missing in R2');
  const text = await obj.text();
  const data = JSON.parse(text) as SkillManifest;
  if (env.CACHE) {
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: CACHE_TTL_SEC });
  }
  return data;
}

// ----------------- generic file loader -----------------
export async function loadSkillFile(env: Env, key: string): Promise<string> {
  const cacheKey = `${CACHE_KEY_PREFIX}${key}`;
  if (env.CACHE) {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return cached;
  }
  if (!env.SKILLS_BUCKET) throw new Error('SKILLS_BUCKET binding missing');
  const obj = await env.SKILLS_BUCKET.get(key);
  if (!obj) throw new Error(`R2 key not found: ${key}`);
  const text = await obj.text();
  if (env.CACHE) {
    await env.CACHE.put(cacheKey, text, { expirationTtl: CACHE_TTL_SEC });
  }
  return text;
}

// ----------------- specific helpers -----------------

/**
 * Load full SKILL.md for a given skill (review-master, product-skill, etc).
 */
export async function loadSkillMd(env: Env, skillName: string): Promise<string> {
  return loadSkillFile(env, `skills/${skillName}/SKILL.md`);
}

/**
 * Load all relevant knowledge for a SKU:
 *   - sku card (32 cards in product-skill)
 *   - ingredients profile (24 profiles)
 *   - clinical-data.md (shared)
 *
 * Strips trailing pack suffix (DE206AAAA → DE206) and looks up via manifest.
 * Returns concatenated markdown blob ready to embed as system context.
 */
export async function loadSkuKnowledge(env: Env, rawSku: string): Promise<string> {
  const baseSku = String(rawSku || '').toUpperCase().replace(/A+$/, '');
  if (!baseSku) return '';

  const manifest = await loadManifest(env);
  const idx = manifest.sku_index[baseSku];
  if (!idx) {
    return `[NO SKU INDEX for ${baseSku} — review-master may answer without product card]`;
  }

  const parts: string[] = [];

  // SKU CARD (richest source — usage, audience, positioning)
  if (idx.sku_card) {
    try {
      const card = await loadSkillFile(env, idx.sku_card);
      parts.push(`# SKU CARD — ${baseSku}\n\n${card}`);
    } catch {}
  }

  // INGREDIENTS profile (composition + mechanisms)
  if (idx.ingredients) {
    try {
      const ing = await loadSkillFile(env, idx.ingredients);
      parts.push(`# INGREDIENTS — ${baseSku}\n\n${ing}`);
    } catch {}
  }

  // CLINICAL DATA (shared across all products)
  try {
    const clinical = await loadSkillFile(env, 'skills/product-skill/references/clinical-data.md');
    parts.push(`# CLINICAL DATA (shared)\n\n${clinical}`);
  } catch {}

  return parts.join('\n\n---\n\n');
}

/**
 * Load segment-check rules (used by Gate 6).
 */
export async function loadSegmentCheck(env: Env): Promise<string> {
  return loadSkillFile(env, 'skills/review-master/references/segment-check.md');
}

/**
 * Bust the local cache (used after R2 update). KV TTL still controls upper bound.
 */
export async function flushSkillCache(env: Env): Promise<number> {
  if (!env.CACHE) return 0;
  const list = await env.CACHE.list({ prefix: CACHE_KEY_PREFIX });
  let count = 0;
  for (const key of list.keys) {
    await env.CACHE.delete(key.name);
    count++;
  }
  return count;
}
