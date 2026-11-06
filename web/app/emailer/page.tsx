import GoogleMailApp from '@/components/emailer/google-mail-app';
export const runtime = 'edge';

export default function EmailerPage({ searchParams }: { searchParams: { folder?: string | string[] } }) {
  const folder = searchParams.folder === 'sent' ? 'SENT' : 'INBOX';
  return <div className="dxmail-page"><GoogleMailApp initialFolder={folder} /></div>;
}
