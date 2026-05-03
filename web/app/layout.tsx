import './globals.css';
import type { Metadata } from 'next';
import Sidebar from '@/components/layout/sidebar';
import Header from '@/components/layout/header';

export const metadata: Metadata = {
  title: 'Das Operator',
  description: 'Das Experten ERP',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <div className="flex h-screen">
          <Sidebar />
          <div className="flex-1 flex flex-col overflow-hidden">
            <Header />
            <main className="flex-1 overflow-auto p-6">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
