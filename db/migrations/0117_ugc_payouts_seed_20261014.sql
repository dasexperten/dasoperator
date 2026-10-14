-- 0117 — First two barter payouts on the UGC screen (Owner 2026-10-14, via
-- Diana Helios). Data only, idempotent: re-running changes nothing.
--
-- Creators missing from ugc_creators get a minimal Instagram record with the
-- same stable ids the XLSX import and POST /api/ugc/payouts use
-- (ugc_/ugcp_ + sha256("instagram:<handle>")[0:24]), so a later import lands
-- on the same row. An existing profile with the same handle is reused.
--
-- yasmin_i.b   691 ₽  sent — Konsol file sent 14.10.2026 14:01 Yerevan (10:01 UTC)
-- mis_alina_010 836 ₽ sent — send time not recorded in the brief
--
-- Rollback: DELETE FROM ugc_payouts WHERE id IN ('ugcpay_20261014_yasmin_i_b','ugcpay_20261014_mis_alina_010');
-- (creators/profiles with source = 'ugc_payout' may be removed the same way).

INSERT INTO ugc_creators (id, normalized_handle, lifecycle_stage, created_at, updated_at)
SELECT 'ugc_520173a75df9d8d0d2058534', 'yasmin_i.b', 'accepted', 1791972060000, 1791972060000
WHERE NOT EXISTS (SELECT 1 FROM ugc_creator_platforms WHERE platform = 'instagram' AND normalized_handle = 'yasmin_i.b')
ON CONFLICT(id) DO NOTHING;

INSERT INTO ugc_creator_platforms (id, creator_id, platform, handle, normalized_handle, profile_url, source, created_at, updated_at)
VALUES ('ugcp_520173a75df9d8d0d2058534', 'ugc_520173a75df9d8d0d2058534', 'instagram', 'yasmin_i.b', 'yasmin_i.b',
        'https://www.instagram.com/yasmin_i.b/', 'ugc_payout', 1791972060000, 1791972060000)
ON CONFLICT(platform, normalized_handle) DO NOTHING;

INSERT INTO ugc_creators (id, normalized_handle, lifecycle_stage, created_at, updated_at)
SELECT 'ugc_3fc9c5e0b17f27d84cefd7c5', 'mis_alina_010', 'accepted', 1791972060000, 1791972060000
WHERE NOT EXISTS (SELECT 1 FROM ugc_creator_platforms WHERE platform = 'instagram' AND normalized_handle = 'mis_alina_010')
ON CONFLICT(id) DO NOTHING;

INSERT INTO ugc_creator_platforms (id, creator_id, platform, handle, normalized_handle, profile_url, source, created_at, updated_at)
VALUES ('ugcp_3fc9c5e0b17f27d84cefd7c5', 'ugc_3fc9c5e0b17f27d84cefd7c5', 'instagram', 'mis_alina_010', 'mis_alina_010',
        'https://www.instagram.com/mis_alina_010/', 'ugc_payout', 1791972060000, 1791972060000)
ON CONFLICT(platform, normalized_handle) DO NOTHING;

INSERT OR IGNORE INTO ugc_payouts
  (id, creator_id, creator_platform_id, platform, handle, amount_minor, currency, status,
   payout_date, note, sent_at, created_by, created_at, updated_at)
SELECT 'ugcpay_20261014_yasmin_i_b', p.creator_id, p.id, 'instagram', p.handle, 69100, 'RUB', 'sent',
       '2026-10-14', 'Konsol file sent 14:01 Yerevan', '2026-10-14T10:01:00.000Z', 'Diana Helios', 1791972060000, 1791972060000
FROM ugc_creator_platforms p WHERE p.platform = 'instagram' AND p.normalized_handle = 'yasmin_i.b';

INSERT OR IGNORE INTO ugc_payouts
  (id, creator_id, creator_platform_id, platform, handle, amount_minor, currency, status,
   payout_date, note, sent_at, created_by, created_at, updated_at)
SELECT 'ugcpay_20261014_mis_alina_010', p.creator_id, p.id, 'instagram', p.handle, 83600, 'RUB', 'sent',
       '2026-10-14', 'Sent; time not recorded', NULL, 'Diana Helios', 1791972060000, 1791972060000
FROM ugc_creator_platforms p WHERE p.platform = 'instagram' AND p.normalized_handle = 'mis_alina_010';
