# Actual purge-selector compatibility

This local test extracts the **unchanged SELECT** from pinned
`api/src/lib/ugc-silent-purge.ts` at commit
`16149d51389cbc4d625bbc8e26d766890e232c14`. It verifies the original source and
derived schema hashes before executing the SELECT against synthetic, in-memory
SQLite rows. It never imports or calls the purge worker, runs its deletions,
contacts Cloudflare, or changes production policy. The schema fixture retains
original DDL, indexes, foreign keys and accepted-at triggers; historical migration
backfill and cleanup DML are not run.

Run with Node 24 using the committed pinned source fixture:

```
node --test pilots/operational-storage/erp-purge-contract.test.mjs
```

An explicit `UGC_SCHEMA_SOURCE` may point to the separately materialized full
source bundle. Missing or mismatched fixtures fail rather than skip. The source
bundle's manifest and reproducible extraction script identify every selected
DDL statement; the committed subset retains its manifest and exact derived bytes. This is compatibility evidence for that source snapshot, not proof
of the deployed schema, executed migrations or current production contents.

## What the tests establish

- A genuine `replied` collaboration protects a blank-stage card under the current
  selector, without writing `agreed` or manufacturing `accepted_at`. Existing
  creator notes and stage remain unchanged.
- Incoming messages matching the current handle, existing content/source records
  and existing payouts are separate exclusions. Tests use synthetic existing
  rows only. Creating a payout or fabricated evidence as a migration workaround
  is prohibited.
- `found`, `silent` and empty collaborations do not exclude a card. The selector
  currently also excludes a collaboration with `new` status; that is its observed
  behavior, not evidence of substantive discussion or authorization to transfer.
- Inbound messages under a historical alias alone, manual-stage bookkeeping,
  archival status and notes do not exclude an otherwise eligible card. Those are
  known compatibility gaps, not reasons to weaken migration checks.
- Seven-day age is measured from creator creation; it is not a verified period
  since first contact. The source bounds selection to 200 rows.

## Concurrent purge is a separate integration gate

The worker first selects candidates and later batches deletes for those saved IDs.
It does not re-evaluate eligibility in the deletion statements. A real discussion
record inserted after selection is not, by itself, a transactional deletion fence.
The test demonstrates stale selection but does not execute deletion. Actual-schema
handoff integration must preserve its durable identity mapping and dependent records
even against that stale batch, with enforced constraints and complete atomic
rollback, before any cutover. A successful fresh SELECT is not sufficient evidence.

The user's latest boundary remains unchanged: preliminary contact stays in Sheets;
response plus deliberate substantive discussion precedes ERP ownership. These tests
neither change the historical purge policy nor authorize moving preliminary contacts.
