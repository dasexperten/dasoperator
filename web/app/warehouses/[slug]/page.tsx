import WarehouseDetailClient from './warehouse-detail-client';

// =============================================================================
// /warehouses/[slug] — server component shell, SSR via Cloudflare Pages.
// =============================================================================

export const runtime = 'edge';

export default function WarehouseDetailPage({ params }: { params: { slug: string } }) {
  return <WarehouseDetailClient warehouseId={params.slug} />;
}
