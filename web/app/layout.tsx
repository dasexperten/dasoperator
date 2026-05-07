import './globals.css';
import type { Metadata } from 'next';
import Sidebar from '@/components/layout/sidebar';
import Header from '@/components/layout/header';

export const runtime = 'edge';

export const metadata: Metadata = {
  title: 'Das Operator',
  description: 'Das Experten ERP — innovativ und praktisch',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <div className="flex h-screen">
          <Sidebar />
          <div className="flex-1 flex flex-col overflow-hidden">
            <Header />
            <main className="flex-1 overflow-auto">
              <div className="px-8 py-8">{children}</div>
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
