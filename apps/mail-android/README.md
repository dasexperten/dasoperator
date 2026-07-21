# Das Experten · Почта (Android)

Standalone **Android** app for the Emailer. Same design as production ERP mail
(brand-rot brighter UI + agent avatars).

| Layer | URL / path |
|---|---|
| **PWA (install now)** | https://erp.dasexperten.com/mail |
| **ERP embed (unchanged)** | https://erp.dasexperten.com/emailer |
| **Capacitor shell** | this folder → APK / Play Bundle |

## 1) PWA — install on Android (no APK)

1. Open Chrome on the phone: **https://erp.dasexperten.com/mail**
2. Log in with the usual PIN.
3. Menu **⋮ → Install app** / **Add to Home screen** → **Почта**.
4. Opens full-screen (no browser chrome, no ERP sidebar).

Requires Chrome/Android. Uses `/mail-manifest.webmanifest` + `/mail-sw.js`.

## 2) APK (Capacitor) — later / Play Store

### Prerequisites

- Node 20+
- Android Studio (Hedgehog+) + JDK 17
- Android SDK platform tools

### Build

```bash
cd apps/mail-android
npm install
npx cap add android    # first time only
npx cap sync android
npx cap open android
```

In Android Studio:

1. Wait for Gradle sync.
2. **Build → Build Bundle(s) / APK(s) → Build APK(s)** for a debug install.
3. For Play Store: **Generate Signed Bundle / APK** (upload keystore).

The WebView loads **https://erp.dasexperten.com/mail** live (see `capacitor.config.ts`).
UI deploys with ERP Pages — no need to rebuild APK for design-only changes.

### App identity

| Field | Value |
|---|---|
| Application ID | `com.dasexperten.mail` |
| Display name | Почта |
| Theme | brand rot `#E5202C` / schwarz |

### Notes

- **Android only** — iOS not in scope.
- Auth = same PIN as ERP; module permission = `/emailer`.
- Do not commit keystores or `android/local.properties`.
