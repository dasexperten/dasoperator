# Google Workspace mail integration

Requested outcome: Google Workspace Gmail replaces the custom ERP mail client for everyday email. ERP retains correspondence and business context for sysadmin, webmaster, sales, asean, geo (Julian), logistics, legal and support at dasexperten.com, with selected mail visible in dasexperten@gmail.com. Keep existing mail history and verify replacement before changing domain routing.

## Implemented

- `/emailer/workspace`: admin test page listing the eight identities, live Google connection checks, and paginated mailbox import.
- `/api/email/workspace/status`: independently authenticated admin endpoint. Checks Google profile against the configured business account and accepted send-as identities. Does not expose tokens or claim delivery from identity configuration.
- `/api/email/workspace/sync`: imports20 messages per request. Pass returned nextPageToken to continue. Original MIME and parsed body/attachments go to R2 and existing ERP mail index. Deterministic archive keys and success receipts permit retry without duplicate archive entries. Source dates are preserved. Cursor is returned only after all messages on a page finish. Attachment, R2 and D1 failures fail the import.
- The existing two-minute Worker cron automatically imports connected Gmail accounts, then follows Gmail history. Initial scan includes sent, received, spam and trash (not drafts); it captures the history baseline before scanning. Each tick archives at most20 messages, with page and pending-message cursors persisted in R2. Expired history starts a receipt-aware full scan. Conditional R2 leases prevent concurrent workers from overwriting progress. Failures retain the last committed cursor; the status API reports last successful tick and retry errors.
- Primary Gmail identity is accepted using the verified profile and isPrimary; custom aliases still require accepted verification.
- Existing mail archiving retains best-effort behavior unless strict mode is explicitly selected by this connector.

## Credentials

Worker secrets: GOOGLE_WORKSPACE_CLIENT_ID, GOOGLE_WORKSPACE_CLIENT_SECRET, GOOGLE_WORKSPACE_ACCOUNTS (JSON array of email/refreshToken objects). Only business accounts at dasexperten.com are accepted. Provision through the canonical vault and Worker secret tooling; never commit values.

Google scopes for planned full integration: gmail.readonly, gmail.send, gmail.settings.basic. The current connector uses read-only message and send-as inspection. User consent is required before granting the ERP access. The existing OAuth app is an installed client owned by Das Experten; a local loopback authorization flow is used for initial setup.

## Not yet complete

- Connect support (sales consent and production credentials were provisioned September14). Six aliases sysadmin, webmaster, asean, geo, logistics and legal were saved on sales in Google Admin; support remains a separate user. Verify sending identities in Gmail and routing for all eight addresses.
- Verify continuous synchronization in production after deployment, including messages arriving during a multi-page initial import.
- Replace the rejected diagnostic-first web entry with a Gmail-first daily workflow; preserve ERP business context and historical correspondence.
- Workspace send/reply integration and test sends with confirmed recipients.
- External delivery, replies, attachments, ERP display and owner Gmail copy verified end-to-end for every address.
- Full inventory of current domain recipients and safe mail-routing cutover; do not simply replace MX before inventory.

`replacementReady` remains false while these checks are incomplete. The page is a real connection/import test area, not evidence of a completed migration.

Rollback: revert the integration commit and redeploy through normal Worker/Pages workflows. No DNS changes are part of this commit; Gmail source messages are never deleted.

Validation: node api/scripts/test-google-workspace.mjs; web TypeScript; repo migration and knowledge-parser guards. Repository API TypeScript currently reports existing errors outside these changed modules; do not present that as a clean global type check.
