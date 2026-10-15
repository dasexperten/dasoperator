# SwiftHub AIR receipt maintenance

This one-purpose Node 24+ runner records the four physically received AIR lines
of WDAA-26091601, AWB 877282467124. It imports **unmodified**
`api/src/lib/inventory.ts::applyMovement`, pinned by SHA-256. A prepared-statement
adapter uses the existing authorized Cloudflare D1 management API. It neither
calls the ERP web edge nor changes authentication, routes, or deployment.

Only `swh`, DASEAN, the exact AIR operation and its four existing line IDs are
accepted. Each receipt is 144 tubes, `manual`, `operation`-linked, `on_hand`.
The source confirmations and stable per-line marker are recorded in notes.
`performed_at` is omitted: posting uses NOW. There is no inventory count,
supplier/OTW drain, lifecycle transition, condition acceptance or publication
setting change. The resulting ledger balance is not proof of current physical
or saleable balance.

```sh
node --test tools/stock-receipts/swifthub-air.test.mjs
node tools/stock-receipts/swifthub-air.mjs          # default: live read-only preflight
node tools/stock-receipts/swifthub-air.mjs --apply  # only after reviewing dry-run
```

Load `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_DATABASE_ID` privately from existing vault references/environment.
Do not paste credentials into a command, commit, report or log. The runner
requires the already configured account/database IDs; it cannot target another
database. Production execution requires a clean checkout whose HEAD matches
remote `origin/main`. No deployment is needed.

Preflight reads the actual warehouse/company, all operation fields and lines,
catalog SKUs, SWH stocks/movements/sessions, AIR/AWB source movements and the
four SKUs' supplier/OTW stock rows. It rejects any count session/cutoff,
unexplained stock or source movement, duplicate receipt or mismatch. On a
repeat run, only this runner's exact previously verified receipts are accepted;
those lines are verified and skipped. A fresh snapshot precedes every line.
A local exclusive lock prevents two copies of this runner from applying
together; another writer outside this runner is not locked. Stop if another
operator is working on these same records.

The existing primitive first UPSERTs stock, then inserts the journal movement.
Those are **two separate writes**, not one transaction. Every successful line
is read back and checked against its returned movement ID and balance. Any
ambiguous write stops the run, reads both tables and reports the observed IDs
and balances. No automatic retry occurs. A stock-only partial write is rejected
on the next preflight: reconcile it before any deliberate restart. If the
process is killed, retain its lock until reading both tables; do not remove the
lock and rerun blindly. The same checks apply if read-back itself fails.

Final verification requires exactly four receipt movements and four balances
of 144 (576 total), with all operation fields/notes, line items, warehouse,
company, selected product identity/deletion fields, count sessions and
supplier/OTW rows unchanged.
The script does not implement rollback or correction writes. Unexpected state
requires a separately reviewed forward correction.
