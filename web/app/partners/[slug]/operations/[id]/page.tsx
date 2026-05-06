import OperationDetailClient from './operation-detail-client';

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

export const dynamicParams = false;

export async function generateStaticParams() {
  let pairs: Array<{ slug: string; id: string }> = [];
  try {
    const [partnersRes, opsRes] = await Promise.all([
      fetch(`${API_BASE}/api/partners`, { cache: 'no-store' }),
      fetch(`${API_BASE}/api/operations`, { cache: 'no-store' }),
    ]);
    if (partnersRes.ok && opsRes.ok) {
      const partners = (await partnersRes.json()) as { success: boolean; result?: { partners?: Array<{ id: string }> } };
      const ops = (await opsRes.json()) as { success: boolean; result?: { operations?: Array<{ id: string; partner_slug?: string; partner_id?: string }> } };
      const partnerSlugs = new Set((partners.result?.partners ?? []).map((p) => p.id));
      const opsList = ops.result?.operations ?? [];
      for (const op of opsList) {
        const slug = op.partner_slug ?? op.partner_id;
        if (slug && partnerSlugs.has(slug)) {
          pairs.push({ slug, id: op.id });
        }
      }
    }
  } catch (err) {
    console.error('generateStaticParams operations failed', err);
  }
  // Always include one fallback pair per known partner
  // Plus a global __fallback/__fallback for unknown partners.
  pairs.push({ slug: '__fallback', id: '__fallback' });
  return pairs;
}

export default function OperationDetailPage({ params }: { params: { slug: string; id: string } }) {
  return <OperationDetailClient partnerSlug={params.slug} operationId={params.id} />;
}
