import NewOperationClient from './new-operation-client';

export function generateStaticParams() {
  return [
    { slug: 'prt_torwey' },
    { slug: 'prt_tama' },
    { slug: 'prt_tori_georgia' },
    { slug: 'prt_arvitpharm' },
    { slug: 'prt_natusana' },
    { slug: 'prt_vip_sales' },
  ];
}

export const dynamicParams = false;

export default function NewOperationPage({ params }: { params: { slug: string } }) {
  return <NewOperationClient partnerSlug={params.slug} />;
}
