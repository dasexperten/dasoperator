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

Activation requires a valid HTTPS provider endpoint, an initialized tenant, an
assigned serial, HSM signing enabled by SoftDreams, and a successful zero-risk
status check. Only then may `EASYINVOICE_ENABLED` change from `0` to `1`.

## Current readiness

The connector is intentionally deployed disabled. The supplied sandbox host
does not present a certificate valid for its hostname, the shared HTTPS API
reports that this tenant is not initialized, and no serial was supplied. No
invoice may be issued until SoftDreams resolves those provider-side items.
