-- Knowledge graph — the operator surface over the organizacia corpus.
--
-- The corpus itself stays where it lives: GitHub dasexperten/organizacia
-- (HARD_RULES.md, agents/<slug>/CHARTER.md · LEARNING.md · MEMORY.md).
-- These tables are a CACHE of that corpus, never a second source of truth:
-- every row carries the tree sha it was built from, and a re-sync replaces
-- the rows for that scope wholesale. Dropping all three tables costs nothing
-- but a re-sync.
--
-- Node kinds:  seat | record | law | topic
-- Edge kinds:  authored | cites | refers | mentions | about

CREATE TABLE IF NOT EXISTS kg_nodes (
  id           TEXT PRIMARY KEY,   -- seat:mina-rutunya · record:mina-rutunya/LAW-20260819-01 · law:4h · topic:hreflang
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,      -- what the graph draws
  seat_slug    TEXT,               -- owning seat for record nodes; the slug itself for seat nodes
  family       TEXT,               -- record family: LAW · RULE · MEM · CRAFT · LOG · HARD · FM · CASE · PB · …
  trigger_line TEXT,               -- "если X — делай Y" — the carrying part of a craft entry
  body         TEXT,               -- full entry body, never truncated
  dated_on     TEXT,               -- YYYY-MM-DD parsed out of the id when it carries a date
  source_path  TEXT,               -- agents/mina-rutunya/LEARNING.md
  source_file  TEXT,               -- LEARNING | MEMORY | CHARTER | VOICE | HARD_RULES
  ref_sha      TEXT NOT NULL,      -- organizacia commit sha this row was built from
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_kind ON kg_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_seat ON kg_nodes(seat_slug);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_family ON kg_nodes(family);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_file ON kg_nodes(source_file);

CREATE TABLE IF NOT EXISTS kg_edges (
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  weight     INTEGER NOT NULL DEFAULT 1,
  seat_slug  TEXT,                 -- the seat whose sync wrote this edge (scopes the rebuild)
  ref_sha    TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (src, dst, kind)
);
CREATE INDEX IF NOT EXISTS idx_kg_edges_src ON kg_edges(src);
CREATE INDEX IF NOT EXISTS idx_kg_edges_dst ON kg_edges(dst);
CREATE INDEX IF NOT EXISTS idx_kg_edges_seat ON kg_edges(seat_slug);

-- One row per synced scope (a seat, or the law file). Says what the cache holds
-- and how stale it is, so the page can show a date instead of implying "live".
CREATE TABLE IF NOT EXISTS kg_sync (
  scope       TEXT PRIMARY KEY,    -- seat:<slug> · law
  ref_sha     TEXT NOT NULL,
  nodes       INTEGER NOT NULL DEFAULT 0,
  edges       INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'ok',   -- ok | error
  note        TEXT,
  synced_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
