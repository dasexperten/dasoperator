import NewOperationClient from './new-operation-client';

export const runtime = 'edge';

export default function NewOperationPage({ params }: { params: { slug: string } }) {
  return <NewOperationClient partnerSlug={params.slug} />;
}
