import NewOperationsClient from './new-operation-client';

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

export const dynamicParams = false;

export async function generateStaticParams() {
  let slugs: Array<{ slug: string }> = [];
  try {
    const res = await fetch(`${API_BASE}/api/partners`, { cache: 'no-store' });
    if (res.ok) {
      const data = (await res.json()) as { success: boolean; result?: { partners?: Array<{ id: string }> } };
      if (data.success && data.result?.partners) {
        slugs = data.result.partners.map((p) => ({ slug: p.id }));
      }
    }
  } catch (err) {
    console.error('generateStaticParams new operations failed', err);
  }
  if (slugs.length === 0) {
    slugs = [
      { slug: 'torwey' }, { slug: 'tama' }, { slug: 'tori_georgia' },
      { slug: 'arvitpharm' }, { slug: 'natusana' }, { slug: 'vip_sales' },
    ];
  }
  slugs.push({ slug: '__fallback' });
  return slugs;
}

export default function NewOperationsPage({ params }: { params: { slug: string } }) {
  return <NewOperationsClient partnerSlug={params.slug} />;
}
