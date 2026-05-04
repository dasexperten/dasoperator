import NewContractClient from './new-contract-client';

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

export default function NewContractPage({ params }: { params: { slug: string } }) {
  return <NewContractClient partnerSlug={params.slug} />;
}
