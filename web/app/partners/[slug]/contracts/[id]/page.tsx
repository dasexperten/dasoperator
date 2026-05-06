import ContractDetailClient from './contract-detail-client';

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

export const dynamicParams = false;

export async function generateStaticParams() {
  let pairs: Array<{ slug: string; id: string }> = [];
  try {
    const res = await fetch(`${API_BASE}/api/contracts`, { cache: 'no-store' });
    if (res.ok) {
      const data = (await res.json()) as { success: boolean; result?: { contracts?: Array<{ id: string; partner_slug?: string; partner_id?: string }> } };
      const list = data.result?.contracts ?? [];
      for (const c of list) {
        const slug = c.partner_slug ?? c.partner_id;
        if (slug) pairs.push({ slug, id: c.id });
      }
    }
  } catch (err) {
    console.error('generateStaticParams contracts failed', err);
  }
  pairs.push({ slug: '__fallback', id: '__fallback' });
  return pairs;
}

export default function ContractDetailPage({ params }: { params: { slug: string; id: string } }) {
  return <ContractDetailClient partnerSlug={params.slug} contractId={params.id} />;
}
