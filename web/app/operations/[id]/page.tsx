import OperationDetailClient from './operation-detail-client';

// =============================================================================
// /operations/[id] — universal operation detail page (sale, purchase, transfer).
// Replaces /partners/[slug]/operations/[id] which only worked for sales.
// SSR via Cloudflare Pages — any operation_id is rendered on demand.
// =============================================================================

export const runtime = 'edge';

export default function OperationDetailPage({ params }: { params: { id: string } }) {
  return <OperationDetailClient operationId={params.id} />;
}
