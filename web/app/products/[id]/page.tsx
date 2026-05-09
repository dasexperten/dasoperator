import ProductDetailClient from './product-detail-client';

// =============================================================================
// /products/[id] — server component shell, SSR via Cloudflare Pages.
// Any SKU id is rendered on demand — no build-time enumeration.
// =============================================================================

export const runtime = 'edge';

export default function ProductDetailPage({ params }: { params: { id: string } }) {
  return <ProductDetailClient sku={params.id} />;
}
