-- Owner 2026-11-06: balovay sent the cart (TERMO 429 ₽); move forward to payment. Ordering through a friend is fine.
-- Same effect as the Owner's decision button on /ugc: decision saved, the hold removed, the minute check wakes.
INSERT INTO crm_sync_state (key, value, updated_at)
SELECT 'ig_owner_decision:' || cid,
       json_object('at', t, 'text', 'Корзина 429 ₽ подтверждена, идём к оплате. Заказ через подругу подходит: пусть подруга оформит заказ на Ozon и оставит отзыв со своего аккаунта. Попроси для перевода номер телефона, банк и имя получателя.', 'by', 'Aram (via Claude)'),
       CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM (SELECT conversation_id cid, MAX(created_at) t FROM ugc_ig_messages
         WHERE conversation_id = (SELECT conversation_id FROM ugc_ig_messages WHERE lower(from_username)='balovay' LIMIT 1))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
DELETE FROM crm_sync_state WHERE key = 'ig_reply_escalated:' || (SELECT conversation_id FROM ugc_ig_messages WHERE lower(from_username)='balovay' LIMIT 1);
UPDATE ugc_creators SET lifecycle_stage = 'cart', updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE id IN (SELECT creator_id FROM ugc_creator_platforms WHERE lower(handle)='balovay') AND lifecycle_stage IN ('agreed','found','contacted');
UPDATE crm_sync_state SET value = json_set(value,'$.next_at', CAST(strftime('%s','now') AS INTEGER) * 1000) WHERE key='adaptive:ig_dm' AND json_extract(value,'$.running_since') IS NULL;
