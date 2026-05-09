import EditPartnerClient from './edit-partner-client';

// =============================================================================
// /partners/[slug]/edit — edit partner form, edge runtime.
// =============================================================================

export const runtime = 'edge';

export default function EditPartnerPage({ params }: { params: { slug: string } }) {
  return <EditPartnerClient slug={params.slug} />;
}
