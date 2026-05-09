-- Phase 8.x — fix manufacturer contracts currency to CNY
-- Applied directly to D1 prod via REST API on 2026-05-09.
--
-- Rule: DEE ↔ factory contracts use CNY (payment via VTB Shanghai in yuan).
--       DEI ↔ factory contracts use USD (international invoicing).
--
-- Sources verified from Drive Agreements folder:
--   080824 (Honghui RUS): Article 3.1 — total cost 5 000 000 CNY
--   080824 (Honghui ENG): same contract, ENG version
--   MF01-DEA/YZ (Yangzhou Jinxia ENG): Article 3.1 — "payment currency shall be Chinese Yuan (CNY)"
--
-- Initial seed in 0021 set USD by mistake — corrected here.

UPDATE contracts SET currency='CNY', updated_at=strftime('%s','now')
WHERE id IN ('dee_honghui_080824', 'dee_honghui_080824_a1', 'dee_jinxia_mf01');
