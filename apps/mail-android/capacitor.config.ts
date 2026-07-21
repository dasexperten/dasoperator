import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Das Experten · Почта — Android-only Capacitor shell.
 *
 * Loads the production standalone mail PWA at /mail (no ERP chrome).
 * Same PIN auth + mail UI as https://erp.dasexperten.com/mail
 *
 * First-time setup (on a machine with Android Studio + JDK 17):
 *   cd apps/mail-android
 *   npm install
 *   npx cap add android
 *   npx cap sync android
 *   npx cap open android
 *   → Build → Build APK(s) / Generate Signed Bundle
 */
const config: CapacitorConfig = {
  appId: 'com.dasexperten.mail',
  appName: 'Почта',
  webDir: 'www',
  server: {
    // Live ERP mail standalone — always network-backed
    url: 'https://erp.dasexperten.com/mail',
    cleartext: false,
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#1A1519',
  },
  plugins: {
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#E5202C',
    },
  },
};

export default config;
