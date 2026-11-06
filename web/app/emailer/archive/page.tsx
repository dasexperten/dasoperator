import MailApp from '@/components/emailer/mail-app';

export const runtime = 'edge';

// ERP continues sending through Resend; this is its current correspondence too.
// MailApp validates the requested mailbox against the visible ERP registry.
export default function MailArchivePage({ searchParams }: { searchParams: { mailbox?: string | string[]; folder?: string | string[] } }) {
  const mailbox = typeof searchParams.mailbox === 'string' ? searchParams.mailbox : undefined;
  const folder = searchParams.folder === 'sent' ? 'sent' : 'inbox';
  return <div className="dxmail-page"><p style={{ padding: '8px 16px', margin: 0 }}>Почта ERP · <a href="/emailer/archive?folder=sent">Отправленные</a> · <a href="/emailer?folder=sent">Отправленные Google</a> · <a href="/emailer">Входящие Google</a></p><MailApp initialMailbox={mailbox} initialFolder={folder} /></div>;
}
