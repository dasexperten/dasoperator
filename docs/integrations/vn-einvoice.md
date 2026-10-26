# Vietnam e-invoices: SwiftHub to SoftDreams EasyInvoice

## Purpose

This connector accepts a normalized fiscal command for a completed SwiftHub
order and performs one auditable Vietnam e-invoice operation:

`SwiftHub -> erp-vn-einvoice -> D1 outbox -> SoftDreams EasyInvoice -> private R2 archive`

The SwiftHub raw-order adapter is **not implemented or connected** as verified
on 2026-10-26. This endpoint requires prepared EasyInvoice XML; it does not pull
orders, accept the native SwiftHub order payload, or derive fiscal facts from a
marketplace order. `ingress_configured` means only that the receiver secret is
bound, not that SwiftHub has configured or delivered a webhook.

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
- `completed_at` is required for a new `issue`: an ISO 8601 timestamp with
  timezone, representing an already completed event. Missing, malformed, or
  future timestamps return `422` without archiving or enqueuing a command.
  Existing event/order replays still return their existing document. Legacy
  queued issues are checked again before first submission and held in
  `manual_review` if completion is absent or invalid. Verification of uncertain
  submissions and archival of issued documents continue, to avoid losing the
  outcome of a previous provider call. This is a technical contract check;
  the actual source-status mapping and legal issuance time require confirmation.
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

## SwiftHub connection gap verified 2026-10-26

Lazada order `530124445322445` is present in SwiftHub as order
`aaf186cb-63c1-43cf-b29d-098705f5a86d`, status Packed. This establishes the
marketplace-to-OMS leg only. ERP invoice documents and attempts were both zero;
production issuance remains disabled. A Packed order must not be manufactured
into a completed fiscal command just to populate this outbox.

Before implementing the missing upstream adapter, obtain from SwiftHub:

1. The documented order-read API or webhook contract, authentication, retry and
   replay rules, and one actual payload for this order.
2. The relationship between immutable SwiftHub order ID and marketplace order
   ID, event ID/version, timestamp timezone, and source status lifecycle.
3. Line quantities and amounts, discounts, shipping, currency, payment/settlement
   fields, buyer legal name/address/tax code, and returns/cancellation events.

ERP owns raw-event retention, the approved status-to-fiscal-event mapping,
amount reconciliation and EasyInvoice XML construction. Finance must approve
VAT, buyer and template mapping and the issuance trigger. A read-only replay of
this Packed order must prove that no invoice is queued. A completed-event test
must prove duplicate replay safety before enabling production issuance.

SwiftHub publicly describes APIs for parcel/status integration, but that is not
an account-specific order API contract or working credentials:
[SwiftHub API overview](https://swifthub.net/en/fulfillment-en/how-to-buy-spx-jt-ghn-labels-in-vietnam-via-swifthub/).

## Manual ERP orders (2026-10-26)

The authenticated ERP page `/operations/vietnam` inherits `/operations` permissions.
Read access lists/orders/downloads; `rw` or `full` records orders and requests issue.
The API proxies to `VN_EINVOICE` using its server-only `ERP_RUN_SECRET` and session actor.
Migration `0142_vn_einvoice_manual.sql` adds manual workflow fields to the existing outbox.

An order carries VND gross line amounts, explicit VAT rates and evidence, buyer billing,
source references, and original shipping/discount components. The validated template
currently supports one VAT rate and zero net shipping; unsupported allocations fail.
Saving creates an unsigned draft, or adopts a verified `document_extractions` source
with the same Ikey. Adoption does not create another provider invoice. Saving,
ordinary GET, reconciliation and cron never request release of an unsigned draft.

The primary card action calls bodyless `POST /api/integrations/vn-einvoice/orders/:id/issue`.
It uses the canonical stored order and the fresh, matching provider draft's `ArisingDate`;
caller-supplied amounts, XML and dates are ignored. Under the processing lease, the
worker archives a durable `release_request` with actor, request time, pinned invoice
date, date source and the exact provider readback/source object references. The prior
source object remains immutable; `request_r2_key` points at a new source envelope
containing this audit. Neither `transfer_at` nor transfer evidence is invented.
The same draft is restored from canonical saved lines and the pinned invoice date,
then issued through HSM. Retry processing requires this persisted explicit request
(or the separately recorded, legacy transfer event); an uncertain issue is only queried.

The optional transfer-event API remains compatible with `actual_transfer_date`
(`YYYY-MM-DD`) or `actual_transfer_at` with timezone, never both. Date-only evidence
remains date-only; no midnight time is invented. This event is distinct from the
invoice date and is not a mandatory blank form in the primary issue workflow.
Provider Ikey, buyer, totals and series must match. The worker then uses the documented
HSM `issueInvoices` endpoint. A persisted phase and lease prevent concurrent writes;
uncertain issue results are queried, never blindly resubmitted.

Provider draft, signing, issued/pending-tax, tax-rejected and accepted states are
separate. Final PDF/XML are refreshed after acceptance and stored privately with
SHA256 and provider-readback provenance. HTML/error downloads cannot complete the
archive. The provider guide does not document exported XML field names; fiscal facts
are matched through the same-Ikey provider readback, not guessed XML tags.

The SwiftHub raw webhook adapter is still absent. This manual path does not claim
that feed is connected. Production signed/accepted end-to-end testing still needs a
real authorized issue or working demo tenant; no artificial production invoice is used.

## General Operations and marketplace identity (2026-10-26)

Normalized Vietnam orders enter the ordinary `operations` register automatically
at durable worker creation, replay and processing completion. The queue runner
also repairs missing links for normalized issue documents, including completed
ones, independently of an interrupted browser/API response. Repair calls no
provider endpoint. Corrections/cancellations do not create another sale.

Lazada, Shopee and TikTok use separate channel-qualified keys for **new**
invoices; an existing/adopted invoice always retains its stored provider Ikey.
The readable operation reference is `Lazada-<order>`, `Shopee-<order>` or
`TikTok-<order>`. Buyer identity remains the actual customer. The general list
shows each order separately with its issued invoice number; the Vietnam entry
page is only an import screen and opens the regular operation after saving.

Production audit: one Lazada invoice, one linked ordinary operation, no other
manual or XML documents and no unlinked invoices as of this deployment. The
raw SwiftHub adapter remains absent. Legacy XML commands without normalized
buyer, item, VAT and channel facts cannot produce a truthful sale record; this
change does not infer those facts or claim to poll marketplace/provider portals.
