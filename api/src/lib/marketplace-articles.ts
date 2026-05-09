/**
 * Das Experten multipack convention for marketplace articles.
 *
 *   no suffix     -> 1 unit  (single product)
 *   suffix AA     -> 2 units (двойник)
 *   suffix AAAA   -> 4 units (четвёрник)
 *
 * Used to translate marketplace offer_id / supplierArticle into our
 * canonical SKU and a multiplier so that aggregate stock totals reflect
 * actual physical pieces, not card counts.
 */

export interface ParsedArticle {
  baseSku: string | null;   // null if article doesn't match Das Experten pattern
  packFactor: 1 | 2 | 4;
}

/**
 * Parse a marketplace article string into a canonical SKU + pack factor.
 *
 * Examples:
 *   "DE201"      -> { baseSku: "de201", packFactor: 1 }
 *   "DE201AA"    -> { baseSku: "de201", packFactor: 2 }
 *   "DE201AAAA"  -> { baseSku: "de201", packFactor: 4 }
 *   "DE201A"     -> { baseSku: null, packFactor: 1 }   // typo, ignore
 *   "Random text"-> { baseSku: null, packFactor: 1 }
 *
 * Canonical SKUs are stored lowercase in the products table.
 */
export function parseMarketplaceArticle(article: string | null | undefined): ParsedArticle {
  if (!article) return { baseSku: null, packFactor: 1 };

  // Order matters: AAAA must be tested before AA (longer suffix first via regex group).
  const m = article.trim().toUpperCase().match(/^(DE\d+)(AAAA|AA)?$/);
  if (!m) return { baseSku: null, packFactor: 1 };

  const suffix = m[2];
  const factor: 1 | 2 | 4 = suffix === 'AAAA' ? 4 : suffix === 'AA' ? 2 : 1;
  const base = m[1];
  if (!base) return { baseSku: null, packFactor: 1 };
  return { baseSku: base.toLowerCase(), packFactor: factor };
}
