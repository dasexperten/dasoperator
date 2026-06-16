'use client';

export const runtime = 'edge';

import { useState } from 'react';
import { ListChecks, Workflow, GraduationCap, Inbox, History } from 'lucide-react';
import TasksView from '@/components/emailer/tasks-view';
import ScenariosView from '@/components/emailer/scenarios-view';
import LearningView from '@/components/emailer/learning-view';
import InboxView from '@/components/emailer/inbox-view';
import EmailHistory from '@/components/emailer/email-history';

type Tab = 'tasks' | 'inbox' | 'scenarios' | 'learning' | 'history';

export default function EmailerPage() {
  const [activeTab, setActiveTab] = useState<Tab>('tasks');

  const tabs: { id: Tab; label: string; icon: typeof Mail }[] = [
    { id: 'tasks', label: 'Tasks', icon: ListChecks },
    { id: 'inbox', label: 'Inbox', icon: Inbox },
    { id: 'scenarios', label: 'Scenarios', icon: Workflow },
    { id: 'learning', label: 'Learning', icon: GraduationCap },
    { id: 'history', label: 'History', icon: History },
  ];

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-2xl font-bold text-foreground">Emailer</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Task conveyor — agents read, reason, draft. You approve. The system learns.
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
        {activeTab === 'tasks' && <TasksView />}
        {activeTab === 'scenarios' && <ScenariosView />}
        {activeTab === 'learning' && <LearningView />}
        {activeTab === 'inbox' && <InboxView />}
        {activeTab === 'history' && <EmailHistory />}
      </div>
    </div>
  );
}
