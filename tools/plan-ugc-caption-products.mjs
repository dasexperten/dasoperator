import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { identifyExplicitProducts } from '../api/src/lib/ugc-products.mjs';
import { identifySourceProductNames, publicationProductLabels } from '../api/src/lib/ugc-source-records.mjs';

export function mediaKey(value) {
  try {
    const u = new URL(value); const media = /^\/(?:p|reel|reels)\/([^/]+)/.exec(u.pathname);
    return /(^|\.)instagram\.com$/.test(u.hostname) && media ? media[1] : null;
  } catch { return null; }
}
export function identifyCaptionProducts(caption, wbMap) {
  const mapping = new Map();
  for (const row of wbMap) {
    const id = String(row.nm_id); const sku = String(row.base_sku).toUpperCase();
    const set = mapping.get(id) ?? new Set(); set.add(sku); mapping.set(id, set);
  }
  const articles = [];
  const text = String(caption ?? '');
  for (const id of new Set(text.match(/\b\d{7,12}\b/g) ?? [])) {
    const skus = mapping.get(id);
    if (skus?.size === 1 && identifyExplicitProducts([...skus]).matches.length) articles.push({ nm_id: id, sku: [...skus][0] });
  }
  return { codes: [...new Set([...identifySourceProductNames(text), ...articles.map((a) => a.sku)])], articles };
}
export function planCaptionProducts(posts, contents, wbMap) {
  const updates = []; const records = []; const issues = [];
  for (const item of contents) {
    if (item.product_source && !['explicit_import', 'metadata_text'].includes(item.product_source)) continue;
    const key = mediaKey(item.content_url);
    const post = key ? posts.find((p) => mediaKey(p.inputUrl ?? p.url) === key) : null;
    if (!post) continue;
    if (post.ownerUsername && post.ownerUsername.toLowerCase() !== String(item.normalized_handle).toLowerCase()) {
      issues.push({ id: item.id, reason: 'owner_mismatch', expected: item.normalized_handle, observed: post.ownerUsername, content_url: item.content_url }); continue;
    }
    const result = identifyCaptionProducts(post.caption, wbMap);
    let existing = []; try { existing = JSON.parse(item.product_codes ?? '[]'); } catch { /* keep the evidence below */ }
    const codes = [...new Set([...(Array.isArray(existing) ? existing : []), ...result.codes])];
    const identified = identifyExplicitProducts(codes).matches;
    // Do not downgrade any completed original classification after an unavailable fetch.
    if (!result.codes.length && item.product_status === 'identified') continue;
    const evidence = JSON.stringify({ kind: 'publication_caption', content_url: item.content_url, caption: post.caption ?? null, matched_wb_articles: result.articles, result: result.codes.length ? 'identified' : post.error ? 'unavailable' : 'no_product_match', previous_evidence: item.product_evidence ?? null, labels: result.codes.length ? [] : publicationProductLabels(item.product_evidence) });
    updates.push({ id: item.id, creator_platform_id: item.creator_platform_id, content_url: item.content_url, product_codes: JSON.stringify(codes), product_status: identified.length ? 'identified' : 'unknown', product_source: 'metadata_text', product_confidence: identified.length ? 1 : null, product_evidence: evidence });
    if (result.codes.length) {
      const doc = `instagram:${key}`;
      const stable = [doc, 'caption', 1, 'product_reference', item.creator_id].join('|');
      records.push({ id: `ugs_${createHash('sha256').update(stable).digest('hex').slice(0,24)}`, creator_id: item.creator_id, creator_platform_id: item.creator_platform_id, kind: 'product_reference', source_document: doc, source_sheet: 'caption', source_row: 1, source_text: post.caption, product_codes: JSON.stringify(result.codes), content_url: item.content_url });
    }
  }
  const unique = [...new Map(records.map((r) => [r.id, r])).values()];
  return { summary: { updates: updates.length, identified: updates.filter((u) => u.product_status === 'identified').length, references: unique.length, unresolved: updates.filter((u) => u.product_status !== 'identified').length, issues: issues.length }, updates, records: unique, issues };
}
if (process.argv[1]?.endsWith('/plan-ugc-caption-products.mjs')) {
  const [posts, contents, wbMap, output] = process.argv.slice(2);
  const plan = planCaptionProducts(JSON.parse(readFileSync(posts)).data, JSON.parse(readFileSync(contents)), JSON.parse(readFileSync(wbMap)));
  writeFileSync(output, JSON.stringify(plan, null, 2)); console.log(JSON.stringify(plan.summary));
}
