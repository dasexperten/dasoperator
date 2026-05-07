import OperationDetailClient from './operation-detail-client';

// =============================================================================
// /partners/[slug]/operations/[id] — operation detail card, SSR.
// Any operation_id is rendered on demand — fixes the 404 problem on
// freshly-created operations like DEE-011 / DEE-012.
// =============================================================================

export const runtime = 'edge';

export default function OperationDetailPage({ params }: { params: { slug: string; id: string } }) {
  return <OperationDetailClient partnerSlug={params.slug} operationId={params.id} />;
}
