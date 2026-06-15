'use client';

export const runtime = 'edge';

import { useState } from 'react';
import { Mail, History, Shield, Loader2, AlertCircle } from 'lucide-react';
import ComposeEmail from '@/components/emailer/compose-email';
import EmailHistory from '@/components/emailer/email-history';
import EmailRules from '@/components/emailer/email-rules';

type Tab = 'compose' | 'history' | 'rules';

export default function EmailerPage() {
  const [activeTab, setActiveTab] = useState<Tab>('compose');

  const tabs: { id: Tab; label: string; icon: typeof Mail }[] = [
    { id: 'compose', label: 'Compose', icon: Mail },
    { id: 'history', label: 'History', icon: History },
    { id: 'rules', label: 'Rules', icon: Shield },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Emailer</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Compose, send, and manage emails
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-border px-6">
        <nav className="flex space-x-8" aria-label="Tabs">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  flex items-center gap-2 py-3 px-1 border-b-2 font-medium text-sm
                  transition-colors duration-200
                  ${
                    activeTab === tab.id
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                  }
                `}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Content */}
      <div className="px-6 py-6">
        {activeTab === 'compose' && <ComposeEmail />}
        {activeTab === 'history' && <EmailHistory />}
        {activeTab === 'rules' && <EmailRules />}
      </div>
    </div>
  );
}
