CREATE TABLE IF NOT EXISTS ozon_copy_days (
  day TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  catalog TEXT, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS ozon_copy_cards (
  day TEXT NOT NULL REFERENCES ozon_copy_days(day), sku TEXT NOT NULL,
  status TEXT NOT NULL, detail TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(day,sku)
);
CREATE TABLE IF NOT EXISTS ozon_copy_tickets (
  sku TEXT PRIMARY KEY, original_sku TEXT NOT NULL, seller TEXT NOT NULL,
  evidence TEXT NOT NULL, reserved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  token TEXT NOT NULL, ticket TEXT UNIQUE, thread TEXT
);
INSERT INTO ozon_copy_tickets(sku,original_sku,seller,evidence,token,ticket,thread)
VALUES ('6434618713','1359459315','HomeComfort','Подтверждено владельцем. Ozon передал специалисту.','','98171015','https://seller.ozon.ru/app/messenger?id=0c89a23e-48a2-4918-bb7b-92371557a226&group=support_v2')
ON CONFLICT(sku) DO NOTHING;
