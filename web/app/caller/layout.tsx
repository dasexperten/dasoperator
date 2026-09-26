'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PhoneCall, Send } from 'lucide-react';

// Caller (Owner 2026-09-26): replaces the WhatsApp menu item. The call list is the main view;
// WhatsApp messaging is a subsection inside it.
const TABS = [
  { href: '/caller', label: 'Calls', icon: PhoneCall },
  { href: '/caller/whatsapp', label: 'WhatsApp', icon: Send },
];

export default function CallerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="space-y-6">
      <nav className="mx-auto flex max-w-6xl gap-2 border-b border-border" aria-label="Caller sections">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = href === '/caller' ? pathname === '/caller' : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-4 font-extrabold ${
                active ? 'border-rot text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4" /> {label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
