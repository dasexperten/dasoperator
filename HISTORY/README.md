# Das Operator ERP — Project History Database

> **The complete record of everything built, decided, and deployed on the
> Das Operator ERP.** One place, reconstructed from every available source:
> the 60 D1 migrations, git history, backlog logs, end-of-session notes,
> the claude.ai project export, the Vision-Coding registry, and the
> architecture decision records.

Compiled 2026-07-03. This is a **living archive** — append new events as work
continues; do not rewrite history that has already been recorded.

---

## Why this exists

The project's memory was scattered across two repositories and several
formats — `BACKLOG.md`, dated `EOS_*.md` notes, `docs/snapshots/`, migration
headers, ADRs in `docs/decisions/`, and the exported claude.ai project record
in `das-architektura/PROJECTS/Das-Operator-ERP/_PROJECT.md`. No single file
answered *"what did we do, when, and why."*

`HISTORY/` is that single file set. It reconstructs the full timeline from
Day 0 (2026-05-02, first ADRs) through 2026-07-02 (latest commit at compile
time), and inventories the whole live system as it stands.

---

## What's in here

| File | What it holds |
|---|---|
| [`EVENTS.md`](./EVENTS.md) | **Master chronological event log.** Every dated event — schema migration, feature, fix, decision, seed, integration, session — as prose grouped by phase/date. Start here. |
| [`events.csv`](./events.csv) | Machine-readable version of the same log: `date,phase,category,module,event,source`. Sort / filter / import anywhere. |
| [`PHASES.md`](./PHASES.md) | The phase roadmap 1.0 → 10.1, each with status and the migrations/commits that delivered it. |
| [`MIGRATIONS.md`](./MIGRATIONS.md) | Annotated ledger of all **60 D1 migration files** (0001 → 0057, with the branch-collided 0014/0015/0032 pairs), one line each: what it changed and when it hit prod. |
| [`SYSTEM-INVENTORY.md`](./SYSTEM-INVENTORY.md) | Snapshot of the whole live system: 65 API route modules, 53 backend libs, 41 UI pages, 30 components, the D1 table set, R2/KV/cron. "Everything we have." |
| [`DECISIONS.md`](./DECISIONS.md) | Consolidated decision log + cemented business rules — ADR 001/002 plus every rule locked in session notes and the project memory. |
| [`INFRASTRUCTURE.md`](./INFRASTRUCTURE.md) | Cloudflare account, D1/R2/KV, Workers, integrations, cron schedules, deploy protocol, token inventory (names only — values live in SECRETS/). |
| [`sessions/`](./sessions/) | The verbatim end-of-session records that survived, plus [`SESSIONS-INDEX.md`](./sessions/SESSIONS-INDEX.md) listing every session (including the ones whose full notes were lost to chat history). |

---

## How to read it

- **"What happened on date X?"** → `EVENTS.md` (grouped by date) or filter `events.csv`.
- **"When did feature/table Y ship?"** → `MIGRATIONS.md` or search `events.csv` by module.
- **"Why is money stored as integers / why slugs for IDs?"** → `DECISIONS.md`.
- **"What endpoints / pages / tables exist right now?"** → `SYSTEM-INVENTORY.md`.
- **"Where does the Worker deploy from, what's the D1 id?"** → `INFRASTRUCTURE.md`.

## Provenance & confidence

Every event cites its **source** so you can trace it back:

- `migration NNNN` — a committed SQL migration file (highest confidence: the
  change is in the repo).
- `git <hash>` — a commit in this repo's history (present locally from 2026-06-21).
- `EOS 2026-05-09` / `snapshot 2026-05-09` — the two surviving end-of-session notes.
- `BACKLOG.md` — the running backlog's "Done" sections.
- `_PROJECT.md` — the exported claude.ai project memory (state as of ~2026-05).
- `vision-coding` — the Vision-Coding project registry provisioning log.

Where a session's full notes were lost (the pre-2026-05-09 daily notes are
referenced but their files never made it into a repo), the event is marked
`reconstructed` and dated from the reference that mentions it. These are the
only low-confidence rows; everything else is anchored to a file in the repo.

## Maintenance

When a new session lands work:

1. Add its migrations to `MIGRATIONS.md`.
2. Append its events to `EVENTS.md` **and** `events.csv`.
3. Drop the end-of-session note into `sessions/` and add a row to
   `sessions/SESSIONS-INDEX.md`.
4. Update `PHASES.md` status if a phase advanced.
5. Refresh `SYSTEM-INVENTORY.md` counts if modules were added.

Keep `das-architektura/PROJECTS/Das-Operator-ERP/_PROJECT.md` pointing here as
the canonical history.
