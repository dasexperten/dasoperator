import NewContractClient from './new-contract-client';

export const runtime = 'edge';

export default function NewContractPage({ params }: { params: { slug: string } }) {
  return <NewContractClient partnerSlug={params.slug} />;
}
