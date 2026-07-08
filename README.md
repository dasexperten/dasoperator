# Das Operator ERP

## 🎨 Design System — MANDATORY

All Das Experten design principles live in [`Design/`](./Design/) — brand voice, color palette, typography, spacing, components, casing rules.

- [`Design/README.md`](./Design/README.md) — the design system source of truth
- [`Design/colors_and_type.css`](./Design/colors_and_type.css) — ready-to-use CSS design tokens

**Rule for humans and AI agents:** any UI, page, banner, document, or visual output produced from this repo MUST follow these principles. Consult `Design/` before styling anything.


Cloudflare-native ERP system for Das Experten International.

**Stack:** D1 + R2 + KV + Workers + Hono + Next.js 14 + Drizzle + shadcn/ui + Tremor

## Status

| Phase | Description | Status |
|---|---|---|
| 1.0 | Repository skeleton (api / web / db / docs) | Done |
| 1.0a | Cloudflare Pages Static Export fix | Done |
| 1.1 | D1 schema initial migration (16 tables) | In review |
| 1.2 | Reference data seed (companies, partners, products) | Planned |
| 1.3 | R2 bucket + KV namespace setup | Planned |
| 2.0 | Skills bridge (8 HTTP endpoints) | Planned |
| 3.0 | UI shell (dashboards, forms) | Planned |

## Structure

```
dasoperator/
  api/        — Cloudflare Workers backend (Hono)
  web/        — Next.js 14 frontend on Cloudflare Pages
  db/         — Drizzle schema + D1 migrations
  docs/       — Architecture, ADRs, runbooks
```

## Quick references

- **Repository:** `github.com/dasexperten/dasoperator`
- **Production URL:** `dasoperator.pages.dev` (auto-deploy from main)
- **Future custom domain:** `erp.dasexperten.com` (deferred)
- **Architecture overview:** `docs/architecture.md`
- **Schema documentation:** `db/README.md`

## Decision records

- ADR 001 — D1 vs Skills as Source of Truth
- ADR 002 — D1 Schema Architectural Conventions

Located in `docs/decisions/`.

## Cloudflare resources

- Account ID: `081ddb85cb399ad62a70210328d744fc`
- Plan: Workers Paid
- D1 database: `das_erp_dev` (East Europe)
- Shared workers: `emailer-bridge`, `apify-bridge`

## Outbound transactional email (Cloudflare Email Sending)

Automated/transactional email is sent from **`notify.dasexperten.com`** via a
Cloudflare Email Sending (Beta) Worker binding — this is a **separate system**
from:

- `EMAILER` (Apps Script/Gmail bridge) — human-facing mail on the main
  `dasexperten.com` mailboxes (`sales@`, `support@`, `emea@`, `asean@`, `eurasia@`).
- Cloudflare Email Routing on `dasexperten.com` — inbound forwarding only.

Do not mix these systems: automated mail always goes out via `EMAIL`, never
via the human mailboxes above.

**Allowed sender addresses** (enforced in code, not just convention —
`api/src/services/email.ts` rejects anything else):

- `no-reply@notify.dasexperten.com`
- `notifications@notify.dasexperten.com`
- `orders@notify.dasexperten.com`
- `forms@notify.dasexperten.com`
- `system@notify.dasexperten.com`

**Configuring the `EMAIL` binding** — already declared in `api/wrangler.toml`:

```toml
[[send_email]]
name = "EMAIL"
```

No `destination_address` / `allowed_destination_addresses` is set, so the
binding can send to any recipient (required — leads/customers are arbitrary
addresses, not one fixed inbox). The sending domain itself
(`notify.dasexperten.com`) must already be verified and enabled for Email
Sending in the Cloudflare dashboard (DNS/SPF/DKIM records configured) —
that part is account-level setup, not something `wrangler deploy` creates.
Current beta quota: 200 emails/day.

**Test endpoint:**

```
POST /api/email/test
Content-Type: application/json
X-Admin-Email-Test-Secret: <ADMIN_EMAIL_TEST_SECRET>

{ "to": "someone@example.com" }
```

Sends a fixed test message from `no-reply@notify.dasexperten.com`. Protected
by either an admin session (`Authorization: Bearer <token>` from
`/api/auth/login`, role `admin`) or the shared secret header above. Set the
secret with:

```
wrangler secret put ADMIN_EMAIL_TEST_SECRET
```

Response: `{ "success": true, "messageId": "..." }` or
`{ "success": false, "error": "..." }`.

**Service module** — `api/src/services/email.ts` exposes `sendEmail`,
`sendTestEmail`, `sendLeadNotification`, `sendFormSubmissionNotification`,
`sendOrderNotification`, and `sendSystemNotification`. All of them funnel
through `sendEmail`, which validates required fields and rejects any `from`
address outside `@notify.dasexperten.com` before calling the `EMAIL` binding.
