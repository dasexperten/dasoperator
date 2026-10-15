# Vietnam e-invoices: SwiftHub to SoftDreams EasyInvoice

## Purpose

This connector turns a completed SwiftHub order into one auditable Vietnam
e-invoice operation:

`SwiftHub -> erp-vn-einvoice -> D1 outbox -> SoftDreams EasyInvoice -> private R2 archive`

It supports issue, adjustment, replacement, cancellation, status verification,
and PDF/XML archival. The provider is disabled until every production-readiness
item is present. There is no HTTP fallback because the EasyInvoice
authentication header contains the account password.

## Live endpoints

- `POST https://erp-vn-einvoice.dasexperten.workers.dev/webhooks/swifthub`
  accepts normalized SwiftHub events. Send `Authorization: Bearer <secret>`.
- `GET https://erp-vn-einvoice.dasexperten.workers.dev/health` reports readiness,
  configuration blockers, the last run, and document counts. It never returns
  credential values.
- `POST https://erp-vn-einvoice.dasexperten.workers.dev/run` is the internal
  authenticated queue runner.

## SwiftHub event contract

Every delivery needs a stable `source_event_id`. Replaying the same event is
safe. A normal issue is also unique by SwiftHub `order_id`, so changing the
event id cannot create a second invoice for the same order.

```json
{
  "source_event_id": "order-123-completed-v1",
  "order_id": "order-123",
  "action": "issue",
  "ikey": "swh-order-123",
  "xml_data": "<Invoices>...<Ikey>swh-order-123</Ikey>...</Invoices>",
  "completed_at": "2026-09-22T11:20:00Z",
  "metadata": {
    "channel": "retail"
  }
}
```

Fields:

- `source_event_id` and `order_id` are required.
- `action` is `issue` by default, or `adjust`, `replace`, `cancel`.
- `ikey` is optional for issue; the connector derives a deterministic one when
  omitted. If supplied, it must match the XML `<Ikey>`.
- `xml_data` is required except for cancellation. It must follow the
  EasyInvoice v8 XML schema and contain the final fiscal facts from SwiftHub.
- `original_ikey` is required for adjustment, replacement, and cancellation.
- `pattern` and `serial` may override the configured values only when the
  provider has assigned an order-specific value.

The API returns `202` after durable receipt. The `document.state` value is the
source of truth; receipt is not proof that the tax authority issued an invoice.

## Safety and recovery

- The raw event, every provider response, and issued XML/PDF are archived in
  the private `das-erp-docs-dev` bucket.
- Before every first submission, the connector checks the provider by `Ikey`.
- A network timeout produces `verify_pending`; it never causes a blind repeat.
- Three consecutive status misses after an uncertain submission produce
  `manual_review`.
- Provider configuration errors produce `blocked_config` and are not retried.
- Cancellation of an HSM-signed invoice uses the provider cancellation API;
  fiscal correction/replacement decisions must be expressed explicitly by the
  upstream event.

## Required bindings

Secrets, stored only as Cloudflare Worker bindings and in the two organization
secret repositories:

- `EASYINVOICE_USERNAME`
- `EASYINVOICE_PASSWORD`
- `EASYINVOICE_TAX_CODE`
- `SWIFTHUB_INGEST_SECRET`
- `ERP_RUN_SECRET`

Non-secret configuration:

- `EASYINVOICE_BASE_URL`
- `EASYINVOICE_PATTERN`
- `EASYINVOICE_SERIAL`
- `EASYINVOICE_ENABLED`

Activation requires a valid HTTPS provider endpoint, an initialized tenant,
HSM signing enabled by SoftDreams, and a successful zero-risk status check.
For the supplied Circular 78 pattern `1C26TAA`, the v8 specification requires
an explicitly empty `Serial`; a separate serial is not missing. Only after the
provider-side checks pass may `EASYINVOICE_ENABLED` change from `0` to `1`.

## Demo acceptance 2026-09-29

On appdemo.softdreams.vn the connector's account issued signed invoices
(pattern 1C26TAA, numbers 1-4), read their status, refused a resend of a
signed Ikey (code 163) and downloaded the PDF. One Ikey per invoice is
accepted. Provider behaviour the connector now follows:

- `checkInvoiceState` answers Status 2 for every request; an unknown Ikey
  appears in `Data.KeyInvoiceMsg` as `-1`. That is "not found", not success.
- Issue XML needs invoice totals and `AmountInWords`; an empty `CusEmail`
  is rejected, so the element is omitted when there is no email.
- Code 163 on issue means the Ikey is already signed: verify, never fail.
- Code 164 on cancel means the tax authority check is still running: the
  cancel is retried later.
- `adjustInvoice` / `replaceInvoice` use a different XML layout (the
  product-level `Amount` is not declared); the schema is requested from
  SoftDreams.

## Production connection 2026-10-07

SoftDreams supplied the production account for tax code 0319132917 in
`0319132917_Prod.txt`. A read-only `checkInvoiceState` call to
`https://api.easyinvoice.vn` authenticated successfully (Status 2, Ok);
a deliberately nonexistent Ikey returned -1. No invoice was created.

The production endpoint is configured, with issuance disabled until the
assigned production pattern and HSM activation are verified. The demo
pattern must not be assumed to apply to production. Credentials are held
in both private vaults and Worker secret bindings, never in this repository.
Rollback: keep `EASYINVOICE_ENABLED=0`; restore the previous demo host and
vaulted demo credentials only if a return to demo is needed.

Read-only production portal verification on 2026-10-07 found:

- InvoiceTemplate/Index: VAT template `78_INVVAT_01_PRO`, pattern `1`,
  status **Not initialized**.
- Publish/index: pattern `1`, symbol empty, current invoice number `0`;
  this is not an assigned production pattern usable by the connector.
- Declaration/Index: the 2026-10-05 change-information declaration is
  **Chưa gửi CQT** (not sent to the tax authority).
- Company/ViewKeyStores: one EasyCA certificate for tax code 0319132917,
  active and enabled, valid 2026-10-05 through 2027-10-05, type `PKCS_12`,
  signing count zero. The portal does not explicitly identify it as HSM.

Complete provider/tax registration and obtain the assigned production pattern
before enabling issuance. This connection task does not submit a legal tax
declaration, initialize a fiscal template, or issue a real invoice.

## Production range verification 2026-10-15

Read-only calls to the production tenant authenticated successfully. The provider's
`getInvoiceUsageReport` for 1–15 October returned the company's own range
`1C26MAA`, with an empty separate serial and zero used invoices. Its technical
guide, section 7, specifies that Circular 78's combined symbol goes in `Pattern`
and `Serial` is explicitly empty. The connector now records that verified range
while keeping `EASYINVOICE_ENABLED=0`.

`getInvoiceByArisingDateRange` with `Option=1` returned one draft, number `0`,
unsigned, not sent to the tax authority, and without a tax-authority code. Its
lookup code matches the supplied sample, but its totals differ from that PDF;
the provider must reconcile the versions. The revised PDF's 20 rows and totals
reconcile arithmetically, but it does not prove HSM signing, tax acceptance or
production issuance. Those checks remain open; this verification created no
invoice and submitted no tax filing.

**Earlier interpretation recorded 2026-10-15; superseded by the attribution
correction below:** the specific sample draft with lookup code
`6ELTEIU7M` is **REJECTED / REFERENCE ONLY**. The Owner states it was refused;
the original refusal date, refusing party and grounds are not established here.
Earlier arithmetic and layout checks are historical observations, not acceptance.
Remove this sample's approval, further reconciliation and matching PDF/XML work
from active follow-ups; do not issue or sign it. Its VND 44,944,232 total is sample
arithmetic only, not an amount payable or receivable. This correction concerns
this sample only. General integration readiness remains a separate matter and
the correction neither cancels the integration nor authorizes enabling issuance.

**Attribution correction, 2026-10-15 13:00:59 Yerevan:** the assistant interpreted
a questioned refusal as cancellation of sample `6ELTEIU7M`. The scope and identity
of the refused invoice are unconfirmed; the Owner has not confirmed an instruction
to abandon this test. The earlier attribution of this sample's rejection to the
Owner is not an established fact. The coordinating assistant sent a source-channel
withdrawal at 12:56 Yerevan, marked Received; that action remains in the audit
history. Hold the affected sample/API, approval, reconciliation, XML, issue and
signing actions pending the Owner's clarification. This repairs attribution only:
it does not approve or reopen the sample, authorize another external instruction,
or change financial, provider or configuration states. VND 44,944,232 remains
sample arithmetic, not an established payable or receivable. General integration
readiness remains separate.

Provider sources: [shared-domain notice](https://easyinvoice.vn/thong-bao-ve-viec-thay-doi-duong-dan-trang-hoa-don-va-trang-tra-cuu-cua-he-thong-hoa-don-dien-tu-easyinvoice-tu-ngay-01-01-2026/)
and its linked [technical integration guide](https://docs.google.com/document/d/1QN9NwhAYhBidQtGV_XZtXKtYefSJFLZR/edit).

## Demo acceptance route

`POST /uat/call` runs one provider call against the SoftDreams demo tenant with
the bound demo account. It exists only while the `EASYINVOICE_UAT_SECRET`
binding is present (send it as `Authorization: Bearer <secret>`), answers only
when `EASYINVOICE_BASE_URL` is a demo host (`appdemo.softdreams.vn`), ignores
`EASYINVOICE_ENABLED`, and bypasses the outbox. Body:
`{"endpoint": "api/publish/checkInvoiceState", "body": {...}}`, or
`{"download": true, "body": {"Ikey": "...", "Option": 0}}` for the PDF. The
response carries the provider envelope, never the authentication header. The
secret is deleted when an acceptance run ends, which disables the route.
