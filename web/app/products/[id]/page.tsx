import ProductDetailClient from './product-detail-client';

// =============================================================================
// /products/[id] — server component shell for Static Export.
// generateStaticParams enumerates all SKUs so Next can prerender each at
// build time. Hydrated by ProductDetailClient.
//
// SKU list mirrors db/migrations/0002_seed_reference.sql products table.
// Update this list when adding/removing SKUs.
// =============================================================================

export function generateStaticParams() {
  return [
    { id: 'DE201' }, { id: 'DE202' }, { id: 'DE203' },
    { id: 'DE205' }, { id: 'DE206' }, { id: 'DE207' },
    { id: 'DE208' }, { id: 'DE209' }, { id: 'DE210' },
    { id: 'DE101' }, { id: 'DE105' }, { id: 'DE106' },
    { id: 'DE107' }, { id: 'DE116' }, { id: 'DE117' },
    { id: 'DE119' }, { id: 'DE120' }, { id: 'DE122' },
    { id: 'DE130' }, { id: 'DE131' },
  ];
}

export default function ProductDetailPage({ params }: { params: { id: string } }) {
  return <ProductDetailClient sku={params.id} />;
}
