import OperationDetailClient from './operation-detail-client';

// =============================================================================
// /partners/[slug]/operations/[id] — operation card
// Static export requires generateStaticParams. Snapshot of live operations at
// deploy time. Re-deploy when new operations appear (or switch to dynamic
// rendering later).
// =============================================================================

export function generateStaticParams() {
  return [
    { slug: 'prt_torwey',       id: 'op_d495fcbc-27f0-484b-a38a-587e8c30e238' },
    { slug: 'prt_torwey',       id: 'op_1466b379-0799-4ce4-851d-26d8f7a2acc6' },
    { slug: 'prt_torwey',       id: 'op_82d2dc86-5466-4e1a-80ba-6e4db069fe00' },
    { slug: 'prt_torwey',       id: 'op_64a2d8dc-a959-4c9b-a7e5-6e92508f3a37' },
    { slug: 'prt_tori_georgia', id: 'op_fac668b1-6687-4ccd-b70f-5a082f006191' },
    { slug: 'prt_tori_georgia', id: 'op_a6eaf3ca-0ac0-4665-b7cc-f87ad92bddac' },
  ];
}

export const dynamicParams = false;

export default function OperationDetailPage({ params }: { params: { slug: string; id: string } }) {
  return <OperationDetailClient partnerSlug={params.slug} operationId={params.id} />;
}
