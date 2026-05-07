import NewPaymentClient from './new-payment-client';

export const runtime = 'edge';

export default function NewPaymentPage({ params }: { params: { slug: string } }) {
  return <NewPaymentClient partnerSlug={params.slug} />;
}
