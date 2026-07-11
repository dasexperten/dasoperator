'use client';

export const runtime = 'edge';

import PageHeader from '@/components/ui/page-header';
import CloudflareInboxView from '@/components/emailer/cloudflare-inbox-view';

export default function EmailerPage() {
  return (
    <div className="space-y-8 max-w-full">
      <PageHeader
        eyebrow="Communications"
        title="Emailer"
        subtitle="Cloudflare email archive — Personal (mail to sales@/support@/…) and System (notify.dasexperten.com), read-only."
      />

      <CloudflareInboxView />
    </div>
  );
}
