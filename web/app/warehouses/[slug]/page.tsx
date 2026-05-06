import WarehouseDetailClient from './warehouse-detail-client';

// Static export — enumerate all warehouse IDs in current D1 (verified
// via /api/warehouses on prod). Update when adding new warehouses.
export function generateStaticParams() {
  return [
    { slug: 'wh_flp' },
    { slug: 'wh_gzh' },
    { slug: 'wh_dgn' },
    { slug: 'wh_han' },
    { slug: 'wh_jeb' },
    { slug: 'wh_lbr' },
    { slug: 'wh_srn' },
    { slug: 'wh_yer' },
    { slug: 'wh_yzh' },
  ];
}

export const dynamicParams = false;

export default function WarehouseDetailPage({ params }: { params: { slug: string } }) {
  return <WarehouseDetailClient warehouseId={params.slug} />;
}
