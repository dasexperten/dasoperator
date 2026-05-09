import ContractDetailClient from './contract-detail-client';

// =============================================================================
// /partners/[slug]/contracts/[id] — contract detail card, SSR.
// =============================================================================

export const runtime = 'edge';

export default function ContractDetailPage({ params }: { params: { slug: string; id: string } }) {
  return <ContractDetailClient partnerSlug={params.slug} contractId={params.id} />;
}
