import NewOperationClient from './new-operation-client';

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

export default function NewOperationPage({ params }: { params: { slug: string } }) {
  return <NewOperationClient partnerSlug={params.slug} />;
}
