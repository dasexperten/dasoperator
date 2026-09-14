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
