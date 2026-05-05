import ProductDetailClient from './product-detail-client';

// =============================================================================
// /products/[id] — server component shell for Static Export.
// generateStaticParams enumerates all SKUs so Next can prerender each at
// build time. Hydrated by ProductDetailClient.
//
// SKU list mirrors db/migrations/0002_seed_reference.sql products table.
// Update this list when adding/removing SKUs.
// =============================================================================

// IDs lowercase — must match exactly the case stored in D1 products.id
// (e.g. 'de201', not 'DE201'). The /api/products/:id endpoint is
// case-sensitive on the SQL primary key. Display upper-casing happens
// in the catalog/detail JSX via .toUpperCase() — that's purely cosmetic.
export function generateStaticParams() {
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

export default function ProductDetailPage({ params }: { params: { id: string } }) {
  return <ProductDetailClient sku={params.id} />;
}
