import OperationDetailClient from './operation-detail-client';

// =============================================================================
// /partners/[slug]/operations/[id] — operation card
// Static export requires generateStaticParams. Snapshot of live operations at
// deploy time. Re-deploy when new operations appear (or switch to dynamic
// rendering later).
// =============================================================================

export function generateStaticParams() {
  return [
    { slug: 'torwey',       id: 'op_50ba8391-fb0e-4e93-9986-29cd9232ef0a' },  // DEE-007
    { slug: 'torwey',       id: 'op_45116993-9317-4355-ab73-416b3ed8c0aa' },  // DEE-006
    { slug: 'torwey',       id: 'op_537acd5c-7bbb-4639-8c23-812eb96960be' },  // DEE-005
    { slug: 'torwey',       id: 'op_64a2d8dc-a959-4c9b-a7e5-6e92508f3a37' },  // DEE-004
    { slug: 'torwey',       id: 'op_82d2dc86-5466-4e1a-80ba-6e4db069fe00' },  // DEE-003
    { slug: 'torwey',       id: 'op_1466b379-0799-4ce4-851d-26d8f7a2acc6' },  // DEE-002
    { slug: 'torwey',       id: 'op_d495fcbc-27f0-484b-a38a-587e8c30e238' },  // DEE-001
    { slug: 'tori_georgia', id: 'op_4e405e2b-8288-4350-82ce-75f7a7087c8b' },  // DEI-003
    { slug: 'tori_georgia', id: 'op_a6eaf3ca-0ac0-4665-b7cc-f87ad92bddac' },  // DEI-002
    { slug: 'tori_georgia', id: 'op_fac668b1-6687-4ccd-b70f-5a082f006191' },  // DEI-001
  ];
}

export const dynamicParams = false;

export default function OperationDetailPage({ params }: { params: { slug: string; id: string } }) {
  return <OperationDetailClient partnerSlug={params.slug} operationId={params.id} />;
}
