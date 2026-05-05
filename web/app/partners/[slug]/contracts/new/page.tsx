import NewContractClient from './new-contract-client';

export function generateStaticParams() {
  return [
    { slug: 'torwey' },
    { slug: 'tama' },
    { slug: 'tori_georgia' },
    { slug: 'arvitpharm' },
    { slug: 'natusana' },
    { slug: 'vip_sales' },
  ];
}

export const dynamicParams = false;

export default function NewContractPage({ params }: { params: { slug: string } }) {
  return <NewContractClient partnerSlug={params.slug} />;
}
