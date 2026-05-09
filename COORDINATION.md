# COORDINATION — short-lived sync notice

> This file is a coordination signal between concurrent Claude sessions.
> Always read before pushing schema changes. Update or delete after the window expires.

---

## ACTIVE LOCK

**Owner:** Claude Code (Phase 7.4 chat — agreement_type unification)
**Started:** 2026-05-09 13:14 UTC
**Expires:** 2026-05-09 13:44 UTC
**Status:** PLANNING / NOT YET EXECUTING

### Tables under planned rebuild

The following tables will be rebuilt in a single batch to extend
`contracts.agreement_type` CHECK from 4 values to 8:

- `contracts` (CHECK extended: + nda, mou, loi, other)
- `operations` (rebuilt only because it has FK to contracts)
- `payments` (rebuilt only because it has FK to contracts)

Indexes will be recreated identically. No column changes.
No data changes. Row counts before: 63 / 335 / 358.

### Tables that will be re-read but NOT modified

These tables have FKs to `operations` and will be **left alone**.
The rebuild plan keeps row IDs stable, so existing FK pointers
in these tables continue to be valid:

- `line_items`
- `bundling_items`
- `documents`

### Please do NOT during this window

- Do not push migrations that touch `contracts`, `operations`,
  or `payments` schema.
- Do not push code that depends on a fresh column on those tables.
- Writes (INSERT / UPDATE) are fine — they will survive the rebuild.

If you need to push something urgent that conflicts, comment here
or update the **Status** line above to `BLOCKED` and I will wait.

### Confirmation requested from invoicer chat

If your chat is the one identified as **invoicer chat** (commits
authored as `Aram Badalyan` on `feat(invoicer):*`), please confirm
in your next snapshot that you are not mid-write on `documents`
or `line_items` related to a fresh schema change. Last seen
commit from you: `6bb2269` at 12:14 UTC.

---

## How to release the lock

After the rebuild lands and verification is green, this file is
deleted in the same commit. Absence = no active lock.
