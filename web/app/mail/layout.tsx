import type { Metadata, Viewport } from 'next';

export const runtime = 'edge';

/** Standalone Android mail app — separate from full ERP chrome. */
export const metadata: Metadata = {
  title: 'Почта · Das Experten',
  description: 'Das Experten Emailer — standalone mail client',
  applicationName: 'Почта',
  manifest: '/mail-manifest.webmanifest',
  icons: {
    icon: [
      { url: '/mail-app/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/mail-app/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/mail-app/icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: 'Почта',
    statusBarStyle: 'black-translucent',
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#E5202C',
  viewportFit: 'cover',
};

export default function MailAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Register SW only on mail app routes */}
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', function(){
    navigator.serviceWorker.register('/mail-sw.js', { scope: '/mail' }).catch(function(){});
  });
})();`,
        }}
      />
      {children}
    </>
  );
}
