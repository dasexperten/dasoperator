import FreightRfqClient from './freight-rfq-client';

export const runtime = 'edge';

export default function FreightRfqPage({ params }: { params: { id: string } }) {
  return <FreightRfqClient operationId={params.id} />;
}
