import MailApp from '@/components/emailer/mail-app';

export const runtime = 'edge';

// ERP continues sending through Resend; this is its current correspondence too.
// MailApp validates the requested mailbox against the visible ERP registry.
export default function MailArchivePage({ searchParams }: { searchParams: { mailbox?: string | string[]; folder?: string | string[]; draft?: string | string[] } }) {
  const mailbox = typeof searchParams.mailbox === 'string' ? searchParams.mailbox : undefined;
  const folder = searchParams.folder === 'sent' ? 'sent' : 'inbox';
  const draft = typeof searchParams.draft === 'string' ? searchParams.draft : undefined;
  return <div className="dxmail-page dxmail-archive"><MailApp initialMailbox={mailbox} initialFolder={folder} initialDraftId={draft} /></div>;
}
