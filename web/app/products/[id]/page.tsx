import ProductDetailClient from './product-detail-client';

// =============================================================================
// /products/[id] — SPA-style dynamic route.
//
// generateStaticParams returns ALL known SKUs so each gets prerendered HTML.
// PLUS one special "__fallback" route that receives any unknown SKU created
// after the last build, via _redirects rule:
//   /products/*  /products/__fallback/  200
//
// The detail client reads the actual SKU from URL pathname at runtime,
// so it works for both prerendered and fallback paths.
// =============================================================================

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

export const dynamicParams = false;

export async function generateStaticParams() {
  let skus: Array<{ id: string }> = [];
  try {
    const res = await fetch(`${API_BASE}/api/products`, { cache: 'no-store' });
    if (res.ok) {
      const data = (await res.json()) as {
        success: boolean;
        result?: { products?: Array<{ id: string }> };
      };
      if (data.success && data.result?.products) {
        skus = data.result.products.map((p) => ({ id: p.id }));
      }
    }
  } catch (err) {
    console.error('generateStaticParams products: fetch failed', err);
  }
  if (skus.length === 0) {
    skus = [
      { id: 'de201' }, { id: 'de202' }, { id: 'de203' },
      { id: 'de205' }, { id: 'de206' }, { id: 'de207' },
      { id: 'de208' }, { id: 'de209' }, { id: 'de210' },
      { id: 'de101' }, { id: 'de105' }, { id: 'de106' },
      { id: 'de107' }, { id: 'de116' }, { id: 'de117' },
      { id: 'de119' }, { id: 'de120' }, { id: 'de122' },
      { id: 'de130' }, { id: 'de131' },
    ];
  }
  // Always include the catch-all fallback.
  skus.push({ id: '__fallback' });
  return skus;
}

export default function ProductDetailPage({ params }: { params: { id: string } }) {
  // Client component reads actual SKU from window.location.pathname at runtime,
  // ignoring the static-render-time params for fallback safety.
  return <ProductDetailClient sku={params.id} />;
}
