-- 0096 — Jurgen's daily run tables: seo_daily_pulse + agent_questions.
--
-- Both tables were created on 2026-08-25 directly on das_erp_dev by the job
-- `jurgen-daily-marketplaces` (organizacia jobs/jurgen-daily-marketplaces/_JOB.md)
-- and have been written daily since. They never had a file here, so the ERP code
-- did not know they existed and no screen showed them (Owner 2026-09-23).
--
-- This file records their shape so the repo matches the live database and a
-- rebuilt database gets them back. IF NOT EXISTS: on the live database it
-- changes nothing, so it is NOT applied there. Column list read from the live
-- tables on 2026-09-23 (PRAGMA table_info via /api/seo/*); types and keys are
-- from the job spec and the stored values, not from the original DDL, which
-- was never saved anywhere. The ERP only reads them (/api/seo/daily-pulse,
-- /api/seo/agent-questions); the seat writes through the D1 API.

CREATE TABLE IF NOT EXISTS seo_daily_pulse (
  day                 TEXT PRIMARY KEY,   -- YYYY-MM-DD, Yerevan; re-run upserts ON CONFLICT(day)
  data_asof           TEXT,               -- day the numbers are really complete for (Webmaster lag 1–3 days)
  wm_pages_in_search  INTEGER,            -- Yandex Webmaster /summary
  wm_shows            INTEGER,            -- Webmaster /search-queries/popular
  wm_clicks           INTEGER,
  wm_avg_position     REAL,
  mx_purchases        INTEGER,            -- Metrika 107720199 ym:s:ecommercePurchases
  mx_revenue_rub      REAL,               -- RUBLES, not kopecks — the one place in ERP that stores rubles
  mx_avg_check_rub    REAL,
  mx_conversion_pct   REAL,
  note                TEXT,
  agent_slug          TEXT,               -- 'jurgen-witt'
  updated_at          TEXT                -- 'YYYY-MM-DD HH:MM:SS' UTC
);

CREATE TABLE IF NOT EXISTS agent_questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT,
  agent_slug   TEXT NOT NULL,
  day          TEXT NOT NULL,
  question     TEXT NOT NULL,
  context      TEXT,
  status       TEXT NOT NULL DEFAULT 'open',   -- open / answered / expired
  answered_at  TEXT,
  answer       TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_questions_open ON agent_questions (agent_slug, status);
