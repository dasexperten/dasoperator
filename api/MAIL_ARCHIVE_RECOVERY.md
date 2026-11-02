# Mail archive incident — 2026-11-02

`self-learning` reads and administrative REST object writes work. Production
Workers PUT, a fresh remote-preview PUT, multipart uploadPart and S3 PUT return
10001/InternalError; a preview LIST also failed. The same fresh bindings write
successfully to `das-operator-data` and `das-erp-docs-dev`. Bucket lock is empty;
lifecycle contains only the default multipart-abort rule. This is evidence of a
bucket data-plane failure, not evidence that all Cloudflare services are down.

## Emergency operation

`MAIL_ARCHIVE_RECOVERY="old"` wraps ARCHIVE for HTTP, scheduled and email entry
points. Only Inbox/, MailOutbox/, MailSendRequests/ and MailDraftFiles/ use
`ARCHIVE_OLD` under `Recovery/self-learning/mail-v1/`. Existing legacy objects
are untouched. No credentials are added or rotated. The diagnostic bucket-only
S3 token was revoked after its PUT also returned InternalError.

Reads prefer the recovery version, otherwise canonical history. Mailbox indexes
union canonical and recovery entries, including later direct REST writes from
other seats. D1 remains the UI index. Conditional claims are translated to atomic
conditions in the healthy bucket, preventing two senders from claiming a draft.
Deletes are tombstones: they cannot reveal an older canonical copy. Listings
merge both namespaces with logical cursors and delimiters. If canonical LIST
fails, listing fails explicitly rather than reporting incomplete history.

External workers reading self-learning directly will not see recovery objects;
use the ERP mail API during this incident. Incoming messages and attachments
are covered by the same overlay. Do not change the global ARCHIVE binding.

## Verification

`node --test api/src/lib/mail-archive-recovery.test.mjs` covers concurrent claims,
canonical lease migration, UTF-8, history union, late canonical writes, pagination,
tombstones, failed reconciliation and source-change races. The complete repository
has pre-existing strict TypeScript errors; new recovery code is checked separately.

Protected maintenance routes require X-Emailer-Service-Secret, never send mail:

* POST /api/email/archive-recovery/probe — UTF-8 PUT/read, conditional claim,
  logical delete; returns the diagnostic key, leaves its recovery tombstone.
* POST /api/email/archive-recovery/reconcile — optional JSON cursor; copies up
  to five objects to canonical, verifies SHA-256 and unchanged source etag, and
  returns the next cursor. A failed write leaves all recovery data in place.

## Cutover and rollback

**Do not disable the flag or roll back to a version without the overlay while
recovery contains unverified data.** That would hide messages accepted meanwhile.
Safe rollback keeps the overlay and flag, or first copies/verifies all recovery
records through working administrative REST. Previous deployment before this
change: 56da067d-1dfc-4c84-b01f-6dfc7dd08742.

After canonical PUT has recovered, pause mail writers/inbound processing in a
controlled maintenance window, walk reconcile to done=true from the beginning,
verify the complete copy including tombstones and unchanged recovery source
versions, then remove the flag via pushed main/CI. Keep recovery bytes until the
cutover and incoming/outgoing readback have been verified. Reconciliation never
deletes recovery bytes automatically: the final etag check alone cannot make a
delete safe against a new concurrent write.
