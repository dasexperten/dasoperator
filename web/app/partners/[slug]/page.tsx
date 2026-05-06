import PartnerDetailClient from './partner-detail-client';

// =============================================================================
// /partners/[slug] — server component shell for Static Export.
// generateStaticParams enumerates all 6 partner slugs from Phase 1.2 seed.
// Update when adding/removing partners.
// =============================================================================

export function generateStaticParams() {
  return [
    { slug: 'torwey' },
    { slug: 'tama' },
    { slug: 'tori_georgia' },
    { slug: 'vip_sales' },
    { slug: 'arvitpharm' },
    { slug: 'natusana' },
  ];
}

export default function PartnerDetailPage({ params }: { params: { slug: string } }) {
  return <PartnerDetailClient slug={params.slug} />;
}
