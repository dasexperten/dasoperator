'use client';

export const runtime = 'edge';

import { useState } from 'react';
import { Shield, GraduationCap, Inbox, History } from 'lucide-react';
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
    <div className="min-h-screen bg-background">
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-foreground">Emailer</h1>
          <span className="flex h-[3px] w-14 overflow-hidden rounded-full" aria-hidden="true">
            <span className="flex-1 bg-zinc-900" />
            <span className="flex-1 bg-[#D7141A]" />
            <span className="flex-1 bg-[#F0C915]" />
          </span>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Inbox: the Cloudflare system-mailbox archive (notify.dasexperten.com). Rules/Learning/History: your Gmail inbox, triaged by sender and type.
        </p>
      </div>

      <div className="border-b border-border px-6">
        <nav className="flex gap-6 overflow-x-auto" aria-label="Tabs">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 py-3 px-1 border-b-2 font-medium text-sm whitespace-nowrap transition-colors ${
                  activeTab === tab.id
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="px-6 py-6">
        {activeTab === 'rules' && <EmailRules />}
        {activeTab === 'learning' && <LearningView />}
        {activeTab === 'inbox' && <CloudflareInboxView />}
        {activeTab === 'history' && <EmailHistory />}
      </div>
    </div>
  );
}
