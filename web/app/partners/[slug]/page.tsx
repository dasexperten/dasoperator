import PartnerDetailClient from './partner-detail-client';

// =============================================================================
// /partners/[slug] — server component shell for Static Export.
// generateStaticParams enumerates all 6 partner slugs from Phase 1.2 seed.
// Update when adding/removing partners.
// =============================================================================

export function generateStaticParams() {
  return [
    { slug: 'prt_torwey' },
    { slug: 'prt_tama' },
    { slug: 'prt_tori_georgia' },
    { slug: 'prt_vip_sales' },
    { slug: 'prt_arvitpharm' },
    { slug: 'prt_natusana' },
  ];
}

export default function PartnerDetailPage({ params }: { params: { slug: string } }) {
  return <PartnerDetailClient slug={params.slug} />;
}
