import WarehouseDetailClient from './warehouse-detail-client';

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

export const dynamicParams = false;

export async function generateStaticParams() {
  let slugs: Array<{ slug: string }> = [];
  try {
    const res = await fetch(`${API_BASE}/api/warehouses`, { cache: 'no-store' });
    if (res.ok) {
      const data = (await res.json()) as { success: boolean; result?: { warehouses?: Array<{ id: string }> } };
      if (data.success && data.result?.warehouses) {
        slugs = data.result.warehouses.map((w) => ({ slug: w.id }));
      }
    }
  } catch (err) {
    console.error('generateStaticParams warehouses failed', err);
  }
  if (slugs.length === 0) {
    slugs = [
      { slug: 'wh_flp' }, { slug: 'wh_gzh' }, { slug: 'wh_dgn' },
      { slug: 'wh_han' }, { slug: 'wh_jeb' }, { slug: 'wh_lbr' },
      { slug: 'wh_srn' }, { slug: 'wh_yer' }, { slug: 'wh_yzh' },
    ];
  }
  slugs.push({ slug: '__fallback' });
  return slugs;
}

export default function WarehouseDetailPage({ params }: { params: { slug: string } }) {
  return <WarehouseDetailClient warehouseId={params.slug} />;
}
