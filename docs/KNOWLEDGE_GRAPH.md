# Knowledge graph — `/knowledge`

**What it is:** the operator's view of what the organisation actually knows —
every seat's craft and memory, and the law those entries cite, drawn as one
graph and searchable by the condition each entry fires on.

**What it is not:** a second place the knowledge lives. The corpus stays in
GitHub `dasexperten/organizacia`. This is a **cache** of it, and every row
carries the commit it was built from.

---

## Where the data comes from

| Source in organizacia | Becomes |
|---|---|
| `agents/*/CHARTER.md` | the roster — a seat exists because its charter does. `agents/new` is the onboarding template and never enters |
| `agents/*/LEARNING.md` · `MEMORY.md` | one `record` node per entry, with its trigger line and its full body |
| `HARD_RULES.md` | one `law` node per cited section (`§8.1`, `§9g`, …) |
| `api/roster-names.mjs` | the seat-name index, EN and RU — read from the org's one registry, never copied into this repo |

Latin working terms in a trigger line become `topic` nodes. §9d requires a
trigger to carry one, precisely so a Cyrillic condition is not blind to an
English task line, which makes those terms the natural index.

### Edges

| Kind | From → to | Built from |
|---|---|---|
| `authored` | seat → record | the file the entry lives in |
| `cites` | record → law | `§0b`, `HARD_RULES §9g` in the heading or body |
| `refers` | record → record | another entry's address in the body (same seat only) |
| `mentions` | record → seat | a seat's name, through its Russian cases |
| `about` | record → topic | the latin terms of the trigger line |

---

## Sync

`POST /api/knowledge/sync` — **admin session required**, one scope per call.

Called with no `scope`, it answers with the plan: every scope, which ones are
behind the current commit, and which to do next. Called with
`?scope=law` or `?scope=seat:<slug>` it does that one and hands back the next.
The **Sync from GitHub** button on the page walks that loop and shows the
counter as it goes.

It is deliberately not one call that does everything. A Worker request cannot
parse 21 seats and several thousand entries inside its CPU budget, and a sync
that dies half way through leaves a graph that looks complete and is not.

### The one thing that needs a hand

The Worker needs `ORG_SSOT_TOKEN` — a GitHub read token for `organizacia`,
which is a **private** repo. Without it `/api/knowledge/sync` answers **503 by
name**, and the page says *no GitHub read token bound* rather than showing an
empty graph as though the corpus were empty.

```
cd api && npx wrangler secret put ORG_SSOT_TOKEN
```

Read scope is enough; the graph never writes back. The value lives in
`SECRETS/github.md` in both stores — never in this repo.

---

## Reading the page honestly

Three things are on screen at all times because leaving them off would let the
picture claim more than it holds:

* **Both sync dates.** Newest and oldest scope. A graph whose newest scope is
  fresh and whose oldest is a week stale is a stale graph, and one date hides it.
* **The cap.** The graph draws at most 400 matching entries and lays out at most
  500 nodes; when more match, it says how many are not drawn.
* **The gaps.** An entry whose trigger line carries no latin term produces no
  topic. That is the §9d «безлат» gap showing through, not a parser failure.

---

## Known limits, named rather than hidden

1. **`refers` is same-seat only.** An entry citing `LAW-20260730-01` is linked to
   its own seat's entry of that address. A cross-seat citation cannot be resolved
   to an owner from the text alone, and guessing would put an invented author on
   the page.
2. **A seat missing from `api/roster-names.mjs`** gets no Russian form, so
   mentions of it are matched on latin only. The sync note says so for that seat;
   no Cyrillic form is ever guessed from a slug, because a slug only yields latin.
3. **Topic nodes are shared and are not garbage-collected.** Re-syncing a seat
   replaces its own nodes and edges; a topic no other entry still points at stays
   as an isolated node until the tables are rebuilt.

---

## Rollback

`git revert` the commit. The three tables (`kg_nodes`, `kg_edges`, `kg_sync`)
are a cache and hold nothing that is not in GitHub — dropping them costs one
re-sync, and leaving them costs three unused tables. Removing the nav entry and
the `/knowledge` module key takes the surface away without touching anything the
ERP already does.
