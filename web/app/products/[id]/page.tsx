import ProductDetailClient from './product-detail-client';

// =============================================================================
// /products/[id] — server component shell for Static Export.
//
// SKU list is fetched from the live D1 catalog at build time so any SKU
// that exists in production gets a prerendered page. No more hardcoded list.
// =============================================================================

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

export const dynamicParams = false;

export async function generateStaticParams() {
  try {
    const res = await fetch(`${API_BASE}/api/products`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = (await res.json()) as {
      success: boolean;
      result?: { products?: Array<{ id: string }> };
    };
    if (!data.success || !data.result?.products) {
      throw new Error('API response missing products array');
    }
    return data.result.products.map((p) => ({ id: p.id }));
  } catch (err) {
    // Fallback to known SKUs so build never fails completely
    console.error('generateStaticParams: fetch failed, falling back to hardcoded list', err);
    return [
      { id: 'de201' }, { id: 'de202' }, { id: 'de203' },
      { id: 'de205' }, { id: 'de206' }, { id: 'de207' },
      { id: 'de208' }, { id: 'de209' }, { id: 'de210' },
      { id: 'de101' }, { id: 'de105' }, { id: 'de106' },
      { id: 'de107' }, { id: 'de116' }, { id: 'de117' },
      { id: 'de119' }, { id: 'de120' }, { id: 'de122' },
      { id: 'de130' }, { id: 'de131' },
    ];
  }
}

export default function ProductDetailPage({ params }: { params: { id: string } }) {
  return <ProductDetailClient sku={params.id} />;
}
