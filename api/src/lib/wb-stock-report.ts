export interface WbStockMapping {
  nmId: number;
  supplierArticle: string;
  baseSku: string;
  packFactor: 1 | 2 | 4;
}

export interface WbWarehouseStock {
  nmId: number;
  supplierArticle: string;
  baseSku: string;
  packFactor: 1 | 2 | 4;
  warehouseName: string;
  quantity: number;
  inWayToClient: number;
  inWayFromClient: number;
}

export interface WbWarehouseStockReport {
  rows: WbWarehouseStock[];
  unmatchedNmIds: number[];
}

const WB_STOCK_REPORT_URL =
  'https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/wb-warehouses';

export async function loadWbStockMappings(db: D1Database): Promise<WbStockMapping[]> {
  const { results } = await db.prepare(`
    SELECT nm_id, supplier_article, base_sku, pack_factor
    FROM marketplace_stocks_wb
    WHERE nm_id IS NOT NULL AND supplier_article IS NOT NULL
  `).all<{
    nm_id: number;
    supplier_article: string;
    base_sku: string;
    pack_factor: number;
  }>();

  return results.map((row) => ({
    nmId: Number(row.nm_id),
    supplierArticle: row.supplier_article,
    baseSku: row.base_sku,
    packFactor: row.pack_factor === 2 || row.pack_factor === 4 ? row.pack_factor : 1,
  }));
}

export async function fetchWbWarehouseStocks(
  token: string,
  mappings: WbStockMapping[],
): Promise<WbWarehouseStockReport> {
  const byNmId = new Map<number, WbStockMapping>();
  for (const mapping of mappings) {
    if (!byNmId.has(mapping.nmId)) byNmId.set(mapping.nmId, mapping);
  }
  const nmIds = [...byNmId.keys()];
  if (!nmIds.length) return { rows: [], unmatchedNmIds: [] };

  const response = await fetch(WB_STOCK_REPORT_URL, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ nmIds, limit: 1000, offset: 0 }),
  });
  if (!response.ok) {
    throw new Error(`WB warehouse stock report HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    data?: {
      items?: Array<{
        nmId: number;
        warehouseName?: string;
        quantity?: number;
        inWayToClient?: number;
        inWayFromClient?: number;
      }>;
    };
  };
  const rows: WbWarehouseStock[] = [];
  const unmatched = new Set<number>();
  const returnedNmIds = new Set<number>();
  for (const item of payload.data?.items || []) {
    const nmId = Number(item.nmId);
    const mapping = byNmId.get(nmId);
    if (!mapping) {
      unmatched.add(nmId);
      continue;
    }
    returnedNmIds.add(nmId);
    rows.push({
      ...mapping,
      warehouseName: item.warehouseName || 'Склад WB',
      quantity: Number(item.quantity || 0),
      inWayToClient: Number(item.inWayToClient || 0),
      inWayFromClient: Number(item.inWayFromClient || 0),
    });
  }

  // A missing row is still a stock result: zero. Materializing it prevents a
  // discontinued card from retaining yesterday's positive quantity forever.
  for (const mapping of byNmId.values()) {
    if (returnedNmIds.has(mapping.nmId)) continue;
    rows.push({
      ...mapping,
      warehouseName: 'Склад WB',
      quantity: 0,
      inWayToClient: 0,
      inWayFromClient: 0,
    });
  }
  return { rows, unmatchedNmIds: [...unmatched].sort((a, b) => a - b) };
}
