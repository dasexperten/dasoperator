'use client';

export const runtime = 'edge';

import { useCallback, useState } from 'react';
import PageHeader from '@/components/ui/page-header';
import CloudflareInboxView from '@/components/emailer/cloudflare-inbox-view';
import TasksView from '@/components/emailer/tasks-view';
import ScenariosView from '@/components/emailer/scenarios-view';
import LearningView from '@/components/emailer/learning-view';
import EmailHistory from '@/components/emailer/email-history';
import ComposeEmail from '@/components/emailer/compose-email';

// The self-learning email engine (Tasks/Scenarios/Learning) and the legacy
// Gmail-bridge tools (History/Compose) were built and wired to their APIs in
// earlier sessions (see BACKLOGS/self-learning-emailer.md,
// BACKLOGS/2026-07-08_cloudflare-email-inbox.md), but this page only ever
// rendered the Cloudflare Inbox tab — the other five were dead components,
// unreachable from the UI. Restored 2026-07-11.
const TABS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'learning', label: 'Learning' },
  { id: 'history', label: 'History' },
  { id: 'compose', label: 'Compose' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function EmailerPage() {
  const [active, setActive] = useState<TabId>('inbox');
  // Panels stay mounted once visited, so switching back to a tab doesn't
  // refetch/flash — matches the pattern in app/analytics/page.tsx.
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set<TabId>(['inbox']));

  const activate = useCallback((id: TabId) => {
    setActive(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  return (
    <div className="space-y-8 max-w-full">
      <PageHeader
        eyebrow="Communications"
        title="Emailer"
        subtitle="Inbox reads the Cloudflare email archive (inbound to Das Operator + outbound system mail). Tasks/Scenarios/Learning are the self-learning AI reply engine. History/Compose are the legacy Gmail-bridge tools."
      />

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Emailer sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => activate(t.id)}
            className="px-4 py-2 rounded-md transition-colors"
            style={{
              fontFamily: 'var(--font-display, inherit)',
              fontWeight: 800,
              fontSize: 'var(--fs-body-sm)',
              letterSpacing: 'var(--tr-tight)',
              ...(active === t.id
                ? { background: 'var(--brand-rot, #E5202C)', color: '#fff', boxShadow: 'var(--shadow-raised)' }
                : { background: 'var(--paper-sunk, #F3F0E8)', color: 'var(--fg-2, #6E6558)' }),
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: active === 'inbox' ? 'block' : 'none' }}>
        {visited.has('inbox') && <CloudflareInboxView />}
      </div>
      <div style={{ display: active === 'tasks' ? 'block' : 'none' }}>
        {visited.has('tasks') && <TasksView />}
      </div>
      <div style={{ display: active === 'scenarios' ? 'block' : 'none' }}>
        {visited.has('scenarios') && <ScenariosView />}
      </div>
      <div style={{ display: active === 'learning' ? 'block' : 'none' }}>
        {visited.has('learning') && <LearningView />}
      </div>
      <div style={{ display: active === 'history' ? 'block' : 'none' }}>
        {visited.has('history') && <EmailHistory />}
      </div>
      <div style={{ display: active === 'compose' ? 'block' : 'none' }}>
        {visited.has('compose') && <ComposeEmail />}
      </div>
    </div>
  );
}
