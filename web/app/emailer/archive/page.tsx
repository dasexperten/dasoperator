import MailApp from '@/components/emailer/mail-app';

export const runtime = 'edge';

// Existing correspondence remains available during the Gmail migration.
// MailApp validates the requested mailbox against the visible ERP registry.
export default function MailArchivePage({ searchParams }: { searchParams: { mailbox?: string | string[] } }) {
  const mailbox = typeof searchParams.mailbox === 'string' ? searchParams.mailbox : undefined;
  return <div className="dxmail-page"><MailApp initialMailbox={mailbox} /></div>;
}
