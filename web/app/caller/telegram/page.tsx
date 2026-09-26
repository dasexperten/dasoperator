'use client';

export const runtime = 'edge';

import CallList from '../call-list';

// Owner 2026-09-26: agents also call from the company Telegram account (+84 931 679 853).
export default function CallerTelegramPage() {
  return (
    <CallList
      channel="telegram"
      eyebrow="Caller · Telegram"
      title="Telegram"
      subtitle="Agent calls placed from the company Telegram account +84 931 679 853. Click a call for the transcript."
    />
  );
}
