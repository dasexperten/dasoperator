# Mail Android app (PWA + APK)

**Owner 2026-07-21:** separate Android application for Emailer (approved preview design).

## Product

| Surface | Audience | URL |
|---|---|---|
| Full ERP Emailer | Desktop + ERP mobile shell | `/emailer` |
| **Standalone Почта** | **Android app (PWA / APK)** | **`/mail`** |

Standalone = same `MailApp` UI (brand colors, avatars), **no** ERP sidebar / header / bottom nav.

## PWA

- Manifest: `web/public/mail-manifest.webmanifest`
- Service worker: `web/public/mail-sw.js` (scope `/mail`)
- Icons: `web/public/mail-app/`
- Install: Chrome → https://erp.dasexperten.com/mail → Install app

## Capacitor APK scaffold

- Folder: `apps/mail-android/`
- Loads live `https://erp.dasexperten.com/mail`
- See `apps/mail-android/README.md` for Android Studio steps

## Auth

- PIN login shared with ERP
- Unauthenticated `/mail` → `/login?next=/mail`
- Module gate: `/emailer` permission (see `hasModuleAccess` for `/mail`)
