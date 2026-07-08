'use client';

export const runtime = 'edge';

import { useState } from 'react';
import { Shield, GraduationCap, Inbox, History } from 'lucide-react';
import PageHeader from '@/components/ui/page-header';
import LearningView from '@/components/emailer/learning-view';
import CloudflareInboxView from '@/components/emailer/cloudflare-inbox-view';
import EmailHistory from '@/components/emailer/email-history';
import EmailRules from '@/components/emailer/email-rules';

type Tab = 'inbox' | 'rules' | 'learning' | 'history';

export default function EmailerPage() {
  const [activeTab, setActiveTab] = useState<Tab>('inbox');

  const tabs: { id: Tab; label: string; icon: typeof Inbox }[] = [
    { id: 'inbox', label: 'Inbox', icon: Inbox },
    { id: 'rules', label: 'Rules', icon: Shield },
    { id: 'learning', label: 'Learning', icon: GraduationCap },
    { id: 'history', label: 'History', icon: History },
  ];

  return (
    <div className="space-y-8 max-w-full">
      <PageHeader
        eyebrow="Communications"
        title="Emailer"
        subtitle="Inbox: the Cloudflare system-mailbox archive (notify.dasexperten.com). Rules/Learning/History: your Gmail inbox, triaged by sender and type."
      />

      <div style={{ borderBottom: '1px solid var(--border-hairline)' }}>
        <nav className="flex gap-6 overflow-x-auto" aria-label="Tabs">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="flex items-center gap-2 whitespace-nowrap transition-colors"
                style={{
                  padding: '12px 4px',
                  borderBottom: `2px solid ${isActive ? 'var(--brand-rot)' : 'transparent'}`,
                  color: isActive ? 'var(--brand-rot)' : 'var(--fg-2)',
                  fontSize: 'var(--fs-body-sm)',
                  fontWeight: 600,
                }}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      <div>
        {activeTab === 'rules' && <EmailRules />}
        {activeTab === 'learning' && <LearningView />}
        {activeTab === 'inbox' && <CloudflareInboxView />}
        {activeTab === 'history' && <EmailHistory />}
      </div>
    </div>
  );
}
