import NewPaymentClient from './new-payment-client';

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

export default function NewPaymentPage({ params }: { params: { slug: string } }) {
  return <NewPaymentClient partnerSlug={params.slug} />;
}
