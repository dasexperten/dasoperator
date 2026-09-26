'use client';

export const runtime = 'edge';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Owner 2026-09-26: WhatsApp now lives inside Caller. Old links land on the new place.
export default function WhatsAppMoved() {
  const router = useRouter();
  useEffect(() => { router.replace('/caller/whatsapp'); }, [router]);
  return null;
}
