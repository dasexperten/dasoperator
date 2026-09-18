/**
 * Das Experten multipack convention for marketplace articles.
 * Mirror of dasoperator marketplace-articles (SSOT law AA×2 / AAAA×4).
 *
 *   no suffix  -> 1 unit
 *   AA         -> 2 units
 *   AAAA       -> 4 units
 */

/**
 * @param {string|null|undefined} article
 * @returns {{ baseSku: string|null, packFactor: 1|2|4 }}
 */
export function parseMarketplaceArticle(article) {
  if (!article) return { baseSku: null, packFactor: 1 };
  const m = String(article).trim().toUpperCase().match(/^(DE\d+)(AAAA|AA)?$/);
  if (!m) return { baseSku: null, packFactor: 1 };
  const suffix = m[2];
  const factor = suffix === "AAAA" ? 4 : suffix === "AA" ? 2 : 1;
  return { baseSku: m[1].toLowerCase(), packFactor: factor };
}
