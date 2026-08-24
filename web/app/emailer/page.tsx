'use client';

export const runtime = 'edge';

import MailApp from '@/components/emailer/mail-app';

// DASOPERATOR MAIL — full-bleed mail client per the two approved mockups
// (docs/design/references/). The component itself switches desktop/mobile.
export default function EmailerPage() {
  return (
    <div className="dxmail-page">
      <MailApp />
    </div>
  );
}
