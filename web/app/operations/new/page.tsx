import NewOperationClient from '@/app/partners/[slug]/operations/new/new-operation-client';

export default function NewOperationGlobalPage() {
  // Empty partnerSlug = global mode (partner picked from dropdown inside form)
  return <NewOperationClient partnerSlug="" />;
}
