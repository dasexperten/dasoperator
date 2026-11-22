-- Surface the verified prior handoff on the existing ERP Timers screen.
INSERT OR IGNORE INTO erp_cron_runs(worker,cron,started_at,finished_at,ok,rows,note,run_key)
SELECT 'erp-ozon-copy-check','manual','2026-11-22T20:11:00.000Z','2026-11-22T20:11:00.000Z',
  1,1,'Ozon №' || ticket || ' · ' || seller || ' · SKU ' || sku,'erp-ozon-copy-check:ticket:' || ticket
FROM ozon_copy_tickets WHERE sku='6434618713' AND ticket='98171015';
