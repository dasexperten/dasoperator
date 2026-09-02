-- Зеркало почтовой описи в D1 — ход 1 (Владелец 2026-09-02).
--
-- Экран «Почта» до сих пор был последним крупным экраном ERP, который на
-- КАЖДОМ открытии читал сырое хранилище: клиент обходил все 30+ ящиков по
-- одному (Inbox/<адрес>.json), а левая колонка отдельным запросом скачивала
-- и разбирала описи всех ящиков разом ради счётчиков. Замер 02.09 живьём:
-- тело одного письма — 0,5 с; ящик mina@ (7 писем) — 0,6 с; orders@ (100) —
-- 0,5 с; support@ — 20 с и при повторе не ответил за 8 минут; sales@ —
-- 17 минут; счётчики (/nav) не ответили за 13 минут. Спиннер на открытом
-- письме держал не R2-запись письма, а этот обход.
--
-- Причина, а не признак: тяжёлые ящики переписывают свою опись целиком на
-- каждое письмо (read-modify-write в inbox-archive.ts), и чтение той же
-- горячей записи встаёт в очередь за записями.
--
-- Устройство то же, что у зеркала заказов 29.08 (0077): R2 остаётся архивом
-- и источником восстановления, D1 становится читаемым слоем экрана.
-- Возврат: MAIL_INDEX_SOURCE="r2" на воркере — код читает опись из R2, как
-- читал до сегодня. Таблицы при этом не удаляются и не мешают.
--
-- Персональных данных здесь не больше, чем в самой описи: адрес и тема
-- письма — то, что экран и так показывает. Тела писем в D1 не попадают
-- никогда: они остаются в R2 и читаются по одному, когда письмо открыли.

CREATE TABLE IF NOT EXISTS mail_index (
  message_key      TEXT PRIMARY KEY,          -- ключ записи в R2: Inbox/<адрес>/<received|sent>/<ISO>-<uuid>.json
  mailbox          TEXT NOT NULL,             -- ящик без плюс-метки: sales@dasexperten.com
  direction        TEXT NOT NULL,             -- received | sent
  timestamp        TEXT NOT NULL,             -- ISO8601, как в описи
  subject          TEXT NOT NULL DEFAULT '',
  from_addr        TEXT,
  to_addr          TEXT,                      -- строка или JSON-массив, как в описи
  message_id       TEXT,
  thread_id        TEXT,
  plus_tag         TEXT,                      -- метка треда (splitPlusTag), не папка
  origin           TEXT,                      -- human | auto
  trigger_name     TEXT,                      -- имя автоматики для origin=auto
  agent            TEXT,                      -- кто из мест написал (правило Владельца 26.07)
  attachment_count INTEGER NOT NULL DEFAULT 0,
  auth_json        TEXT,                      -- SPF/DKIM/DMARC как в описи, одной строкой
  synced_at        INTEGER NOT NULL           -- unix, когда строка последний раз обновлена
);

-- Экран берёт ленту одним запросом по времени; ящик — вторым по ящику.
CREATE INDEX IF NOT EXISTS idx_mail_index_time         ON mail_index(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mail_index_mailbox_time ON mail_index(mailbox, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mail_index_thread       ON mail_index(thread_id);

-- Состояние обхода: своя таблица ключ-значение, чтобы не селиться в
-- crm_sync_state (она про ленту витрины и читается другим экраном).
-- Ключи: mailbox:<адрес>:etag · mailbox:<адрес>:rows · sweep:cursor ·
--        sweep:last_ok_at · sweep:last_error
CREATE TABLE IF NOT EXISTS mail_index_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
