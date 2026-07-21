'use client';

export const runtime = 'edge';

import MailApp from '@/components/emailer/mail-app';

/**
 * Standalone Emailer for Android PWA / Capacitor APK.
 * Full-bleed mail UI — no ERP sidebar, header, or bottom nav.
 * Auth still required (same PIN login as ERP).
 */
export default function MailStandalonePage() {
  return (
    <div className="dxmail-page dxmail-standalone">
      <MailApp />
    </div>
  );
}
