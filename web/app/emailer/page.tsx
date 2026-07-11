'use client';

export const runtime = 'edge';

import { useState } from 'react';
import PageHeader from '@/components/ui/page-header';
import CloudflareInboxView from '@/components/emailer/cloudflare-inbox-view';
import EmailerDashboard from '@/components/emailer/emailer-dashboard';
import MessageView from '@/components/emailer/message-view';
import OrdersView from '@/components/emailer/orders-view';
import type { MailEntry } from '@/components/emailer/shared';

type Screen = { name: 'dashboard' } | { name: 'message'; entry: MailEntry } | { name: 'orders' } | { name: 'list' };

export default function EmailerPage() {
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' });

  return (
    <div className="space-y-8 max-w-full">
      <PageHeader
        eyebrow="Communications"
        title="Emailer"
        subtitle="Official mail (sales@/support@/emea@/eurasia@/asean@/dr.badalyan@dasexperten.com) and system mail — Cloudflare archive."
      />

      {screen.name === 'dashboard' && (
        <EmailerDashboard
          onOpenMessage={(entry) => setScreen({ name: 'message', entry })}
          onOpenOrders={() => setScreen({ name: 'orders' })}
          onSwitchToList={() => setScreen({ name: 'list' })}
        />
      )}

      {screen.name === 'message' && (
        <MessageView entry={screen.entry} onBack={() => setScreen({ name: 'dashboard' })} />
      )}

      {screen.name === 'orders' && (
        <OrdersView
          onBack={() => setScreen({ name: 'dashboard' })}
          onOpenMessage={(entry) => setScreen({ name: 'message', entry })}
        />
      )}

      {screen.name === 'list' && (
        <div>
          <button
            onClick={() => setScreen({ name: 'dashboard' })}
            className="mb-4 text-sm font-semibold text-muted-foreground hover:text-foreground"
          >
            ← Back to dashboard
          </button>
          <CloudflareInboxView />
        </div>
      )}
    </div>
  );
}
