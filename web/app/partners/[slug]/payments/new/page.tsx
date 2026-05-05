import NewPaymentClient from './new-payment-client';

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

export default function NewPaymentPage({ params }: { params: { slug: string } }) {
  return <NewPaymentClient partnerSlug={params.slug} />;
}
