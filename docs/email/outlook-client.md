# ERP mail client acceptance

Owner direction, 2026-09-14: ERP must work as an Outlook-like mail aggregator.
Daily mail work stays inside `/emailer`; Google Workspace is a mail provider.
A link to Gmail or a connection dashboard does not satisfy this requirement.

Required end state:

- Unified inbox and individual business mailboxes, including all registry departments,
  the .ru addresses, and GEO for Julian; preserve existing correspondence.
- Read messages and complete threads, including sent replies, with attachment preview/download.
- Compose, reply, reply all and forward inside ERP, with From, To, CC, BCC and attachments.
- Persistent editable drafts, safe close/recovery, explicit send status and protection from duplicate sends.
- Search across complete history and bodies, with mailbox/folder filters and pagination.
- Inbox, sent, drafts, archive, trash, unread and starred state on desktop and mobile;
  supported actions synchronize with the connected provider and across devices.
- Google Workspace receive/send and continuous synchronization, while preserving ERP/R2 records,
  original message metadata and attachments. Existing Resend flows remain accounted for during migration.
- Correspondence stays linked to customers, orders and business documents.
- Connection/authentication failures have actionable recovery, without losing composed mail.

## Evidence required before completion

Exercise real authenticated ERP workflows on desktop (1440px) and mobile (390px).
Verify provider receipt/sent records AND ERP/R2 archive records for the authorized test messages.
Test send, reply-all, forward, attachments, draft resume, state synchronization and history search.
Use existing private credentials through their vault references only. Never commit tokens or PINs.
Do not send test messages without the user's explicit message-send authorization.

## Current increment: drafts

The server now supports paginated per-user draft reads and rejects cross-user draft overwrites.
The route integration test uses real in-memory SQLite and the real session validator;
`node api/scripts/test-mail-drafts.mjs` requires Node with `node:sqlite` (tested on Node 24).
It covers save/read/edit, CC and parent metadata, pagination, unauthenticated access,
invalid payloads, cross-user reads/updates/deletes, and owner deletion.

UI work is separate and remains under verification: draft listing/resume, save-and-close,
CC field and keyboard support. This increment does not implement Gmail draft synchronization,
autosave/recovery, attachments, BCC, or complete Outlook functionality.

## Current increment: attachments and send results

The API supports private draft-file upload/list/removal, BCC persistence, and downloads
resolved through the archived message metadata. Draft-file IDs are scoped to the current
user and draft. Limits are 20 files, 10 MB per file, and 20 MB total.

The existing Resend send path now sends attachment bytes and archives them in R2.
A durable pre-send copy under `MailOutbox/` remains when archiving fails; the response
distinguishes accepted delivery from completed archive storage. Stable send IDs have
per-user receipts and a lease under `MailSendRequests/`; accepted requests are replayed
without sending another email. Ambiguous old attempts are not resent automatically.

`node api/scripts/test-mail-attachments.mjs` exercises binary and empty attachments,
provider payloads, protected downloads, archival failure after acceptance, pre-send
storage failure, duplicate archive avoidance, stable request receipts and concurrent retries.
These tests use fake provider responses; no real email is sent by them.

Remaining work includes automated repair/reconciliation of pending outbox records,
Google Workspace outbound transport and provider state synchronization, complete history
pagination/search, Reply All/forward fidelity, real delivery tests and authenticated UI
acceptance. Prepared UI changes are not a completed or deployed Outlook replacement.
