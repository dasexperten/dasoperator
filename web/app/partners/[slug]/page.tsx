import PartnerDetailClient from './partner-detail-client';

// =============================================================================
// /partners/[slug] — server component shell, SSR via Cloudflare Pages.
// No more generateStaticParams: any partner slug is rendered on demand.
// =============================================================================

export const runtime = 'edge';

export default function PartnerDetailPage({ params }: { params: { slug: string } }) {
  return <PartnerDetailClient slug={params.slug} />;
}
