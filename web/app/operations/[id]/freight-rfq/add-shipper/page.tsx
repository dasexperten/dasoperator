import { AddShipperClient } from './add-shipper-client';

export const runtime = 'edge';

export default async function AddShipperPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AddShipperClient operationId={id} />;
}
