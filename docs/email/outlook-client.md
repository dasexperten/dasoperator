# ERP mail client acceptance

Owner direction, updated 2026-09-15: Google Workspace is the main and only
permanent mail store; ERP is the Outlook-like interface. Google Drive is the
chosen document service. R2 is separate from email. Earlier requirements to
archive every new email in ERP/R2 are superseded. Existing legacy records must
remain available until their Google copies are verified; this does not authorize
deleting the legacy archive.

Daily mail work stays inside `/emailer`. A Gmail link or a connection dashboard
alone does not satisfy this requirement.

## Required end state

- Unified inbox and individual business mailbox views, including every registry
  department, the .ru addresses, and GEO for Julian. Preserve existing correspondence.
- Read complete conversations, including sent replies, and preview/download attachments.
- Compose, reply, reply all and forward inside ERP with From, To, CC, BCC and attachments.
- Google-backed editable drafts, automatic save/recovery, explicit send status and
  protection against duplicate sends. Authentication errors must preserve composed mail.
- Search full Google history and bodies, with mailbox/folder filters and pagination.
- Inbox, sent, drafts, archive, trash, unread and starred state on desktop and mobile;
  actions and incoming messages synchronize across devices without manual reloads.
- New incoming and outgoing business mail lives in Google. Reconcile prior Resend
  and legacy archive history, preserving dates, recipients, content and attachments.
- Correspondence remains linked to customers, orders and business documents in ERP;
  ERP references Google records instead of becoming a second permanent mail store.
- Graphite styling, Gmail font weights and compact inline replies. Only correspondent
  display names are bold in the list; addresses and dates use regular weight.
- Opening Emailer defaults to the full-width mail workspace with ERP navigation
  collapsed. Folders and department views show provider-backed counters.

## Current evidence and remaining work

The active implementation is `web/components/emailer/google-mail-app.tsx` and
`api/src/routes/email-gmail.ts`, not the legacy Resend MailApp.

Implemented and deployed: Google-backed message listing/body reads, paginated
search, sender identities, compose/reply/reply-all/forward, attachment downloads,
explicit draft save/resume, send and folder actions. Graphite layout, folder and
mailbox counters, readable sender content and inline replies were checked in the
production UI. Sender-name emphasis was deployed separately; its final browser
check timed out and remains pending.

These observations do **not** establish complete acceptance:

- The reading pane currently fetches one message; complete conversation navigation
  is still missing even though outgoing replies retain thread headers.
- Draft saving is explicit or on close; automatic saving and crash recovery are
  not implemented in the active composer.
- Refresh is manual; automatic incoming-mail/state synchronization remains incomplete.
- Attachments download, but an in-app attachment preview remains unimplemented.
- The active Google mail UI has no customer/order/document linking workflow.
- Gmail-level inbox loading speed has not been demonstrated. The loader now refills
  its five concurrent request slots without waiting for fixed groups to finish;
  concurrency/order/failure tests pass, but live latency must still be measured.
- Mail-history migration is incomplete. Earlier batch jobs ended with failures,
  not a completed migration. Existing Google IDs must be reconciled before any retry
  that could create a duplicate. Folded migration-marker verification has a regression
  test and passed three live readbacks; broader reconciliation is running separately.

## Evidence required before completion

Exercise authenticated ERP workflows at desktop and mobile widths. Verify Google
receipt/sent records for the specifically authorized test message and attachment,
then verify draft resume, reply-all recipients, forwarding fidelity, search,
state synchronization, department access and complete conversation reading.
Do not send additional test messages without message-send authorization.

Migration receipts alone are not proof of full archive coverage. Reconcile the
source inventory, known Google IDs and per-message readback results; preserve all
original content and attachment bytes. Never treat a failed verification as
permission to overwrite a message, import another copy or delete the source.

Credentials are loaded only through private vault references. No credentials,
mail bodies or private attachments belong in this acceptance document.
