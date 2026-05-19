# Marketplace Reports — UI Spec

**Created:** 2026-05-19 by Aram + main chat
**Status:** Backend ready, UI required
**Owner of this task:** parallel chat (or whoever owns frontend)

## Что готово в D1

### Новая таблица `marketplace_pnl_lines`

Создана в миграции этой сессии (без номера, так как делалась прямым DDL). Хранит детальный per-SKU PnL breakdown для маркетплейсов (WB + Ozon). Связана с `operations` через `operation_id`.

```sql
CREATE TABLE marketplace_pnl_lines (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('wb', 'ozon')),
  product_id TEXT NOT NULL,
  
  qty INTEGER NOT NULL DEFAULT 0,
  retail_amount REAL NOT NULL DEFAULT 0,   -- розничная цена (sum по всем продажам)
  gross_amount REAL NOT NULL DEFAULT 0,    -- gross после скидок маркетплейса (до комиссии)
  commission REAL NOT NULL DEFAULT 0,      -- комиссия маркетплейса (WB), вычитается из gross
  payout REAL NOT NULL DEFAULT 0,          -- к перечислению селлеру после комиссии
  
  logistics REAL NOT NULL DEFAULT 0,       -- прямые транспортные расходы по SKU
  penalty REAL NOT NULL DEFAULT 0,         -- прямые штрафы по SKU (например, "Штраф МП. Невыполненный заказ")
  acceptance REAL NOT NULL DEFAULT 0,      -- операции на приёмке
  rebill_logistic REAL NOT NULL DEFAULT 0, -- возмещение логистики
  additional_payment REAL NOT NULL DEFAULT 0,
  
  storage_share REAL NOT NULL DEFAULT 0,   -- доля хранения (распределена пропорционально payout)
  advert_share REAL NOT NULL DEFAULT 0,    -- доля рекламы (WB Продвижение, Джем и пр.)
  
  net_total REAL NOT NULL DEFAULT 0,       -- итоговый NET по SKU
  net_per REAL NOT NULL DEFAULT 0,         -- NET на единицу
  
  period_from TEXT,                         -- '2026-04-13' (логическое начало периода)
  period_to TEXT,                           -- '2026-04-19' (sunday для WB, конец месяца для Ozon)
  
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE
);

CREATE INDEX idx_mp_pnl_operation ON marketplace_pnl_lines(operation_id);
CREATE INDEX idx_mp_pnl_marketplace ON marketplace_pnl_lines(marketplace);
CREATE INDEX idx_mp_pnl_product ON marketplace_pnl_lines(product_id);
CREATE INDEX idx_mp_pnl_period ON marketplace_pnl_lines(marketplace, period_to);
```

### Что уже заполнено

**WB (Wildberries):** 20 недель × ~36 SKU = **743 строк**.
- Период: 2026-01-04 → 2026-05-17 (W01-W20)
- Все полные поля заполнены: gross/payout/logistics/storage/advert/penalty/NET

**Ozon:** 4 месяца × ~28 SKU = **114 строк**.
- Период: 2026-01-31 → 2026-04-30 (Jan/Feb/Mar/Apr 2026)
- Заполнено: qty / payout / logistics / advert / net_total / net_per
- **Не заполнено в Ozon-строках:** retail_amount, gross_amount, commission, storage_share (отдельно от logistics). Это требует пересчёта из Ozon API (transaction/list + Performance) — отдельная задача.

## Источник данных

- **WB:** еженедельные xlsx-отчёты из ЛК ВБ (RU + СНГ файлы за каждую неделю объединяются). Парсер: `/tmp/wb_full_parse.py` + insertion: `/tmp/wb_insert_week.py`.
- **Ozon:** Ozon Seller API realization + transaction/list + Performance API. См. в transcript 2026-05-18.

## Связь с operations

Каждой строке `marketplace_pnl_lines` соответствует одна операция в `operations`:
- WB: `op_wb_YYMMDD_weekly`, reference `WB-YYMMDD-WEEKLY`
- Ozon: `op_ozn_<month>2026_monthly`, reference `OZN-YYMMDD-MONTHLY`

Sum(`net_total`) по operation_id из `marketplace_pnl_lines` ≈ `operations.total_amount` (с точностью до округления NET/шт).

## UI — что нужно построить

### 1. Раздел `/reports` в сайдбаре

Иконка `BarChart3` или `FileSpreadsheet` (lucide-react). Под существующим `/operations` или рядом с `/analytics`.

### 2. Страницы `/reports/wb` и `/reports/ozon`

Структура одинаковая, отличается только источник (`marketplace='wb'` vs `'ozon'`).

#### Список периодов (top-level view)

Запрос:
```sql
SELECT 
  o.id AS operation_id,
  o.reference,
  m.period_from,
  m.period_to,
  COUNT(*) AS sku_count,
  SUM(m.qty) AS total_qty,
  ROUND(SUM(m.gross_amount)) AS gross_sum,
  ROUND(SUM(m.payout)) AS payout_sum,
  ROUND(SUM(m.logistics)) AS logist_sum,
  ROUND(SUM(m.storage_share)) AS storage_sum,
  ROUND(SUM(m.advert_share)) AS advert_sum,
  ROUND(SUM(m.penalty)) AS penalty_sum,
  ROUND(SUM(m.net_total)) AS net_sum
FROM marketplace_pnl_lines m
JOIN operations o ON o.id = m.operation_id
WHERE m.marketplace = ?
  AND o.deleted_at IS NULL
GROUP BY o.id, o.reference, m.period_from, m.period_to
ORDER BY m.period_to DESC;
```

Колонки таблицы:
| Period | Reference | SKU | шт | gross | payout | logist | storage | advert | penalty | NET |
|---|---|---|---|---|---|---|---|---|---|---|

При клике на строку → переход на `/reports/{wb|ozon}/{operation_id}`.

#### Детальная страница отчёта (`/reports/wb/op_wb_260125_weekly`)

Запрос:
```sql
SELECT 
  m.product_id,
  p.name_en AS product_name,
  m.qty, m.gross_amount, m.commission, m.payout,
  m.logistics, m.penalty, m.acceptance, m.rebill_logistic,
  m.storage_share, m.advert_share,
  m.net_total, m.net_per
FROM marketplace_pnl_lines m
LEFT JOIN products p ON p.id = m.product_id
WHERE m.operation_id = ?
ORDER BY m.net_total DESC;
```

Заголовок страницы (с возможностью клика по операции для перехода в `/partners/wb/operations/{id}`):
- Reference (например, `WB-260125-WEEKLY`)
- Период (`19.01 - 25.01.2026`)
- Total NET (большая цифра справа)

Под заголовком — таблица per-SKU:

| SKU | шт | gross | payout | logist | storage | advert | penalty | NET ₽ | NET/шт |
|---|---|---|---|---|---|---|---|---|---|

Колонка `NET/шт`:
- зелёная (`#16a34a`) если > 200 ₽
- оранжевая (`#d97706`) если 50-200 ₽
- красная (`#C4302B`) если < 50 ₽
- жирно красная и подсветка строки если negative

Если в SKU есть `penalty > 0`, подсвечивать строку светло-розовым (`rgba(196, 48, 43, 0.06)`) и показывать penalty жирно красным.

### 3. API endpoints (backend Worker)

Можно добавить новые маршруты в `api/src/routes/reports.ts`:

```typescript
// GET /api/reports/marketplace/{marketplace}/list
// Returns periods list aggregated from marketplace_pnl_lines
app.get('/api/reports/marketplace/:marketplace/list', async (c) => {
  const mp = c.req.param('marketplace');
  if (mp !== 'wb' && mp !== 'ozon') return c.json({ error: 'invalid' }, 400);
  
  const { results } = await c.env.DB.prepare(`
    SELECT 
      o.id AS operation_id, o.reference,
      m.period_from, m.period_to,
      COUNT(*) AS sku_count, SUM(m.qty) AS total_qty,
      ROUND(SUM(m.gross_amount)) AS gross_sum,
      ROUND(SUM(m.payout)) AS payout_sum,
      ROUND(SUM(m.logistics)) AS logist_sum,
      ROUND(SUM(m.storage_share)) AS storage_sum,
      ROUND(SUM(m.advert_share)) AS advert_sum,
      ROUND(SUM(m.penalty)) AS penalty_sum,
      ROUND(SUM(m.net_total)) AS net_sum
    FROM marketplace_pnl_lines m
    JOIN operations o ON o.id = m.operation_id
    WHERE m.marketplace = ? AND o.deleted_at IS NULL
    GROUP BY o.id, o.reference, m.period_from, m.period_to
    ORDER BY m.period_to DESC
  `).bind(mp).all();
  
  return c.json({ periods: results });
});

// GET /api/reports/marketplace/lines/:operation_id
// Returns per-SKU lines for one period
app.get('/api/reports/marketplace/lines/:operation_id', async (c) => {
  const op_id = c.req.param('operation_id');
  const { results } = await c.env.DB.prepare(`
    SELECT 
      m.*,
      p.name_en AS product_name
    FROM marketplace_pnl_lines m
    LEFT JOIN products p ON p.id = m.product_id
    WHERE m.operation_id = ?
    ORDER BY m.net_total DESC
  `).bind(op_id).all();
  
  return c.json({ lines: results });
});
```

## Что НЕ трогать

- Таблица `operations` со стороны marketplace-операций — не модифицировать, она правильно показывает total NET и работает в net balance.
- Таблица `line_items` для WB-операций — там агрегированные NET/шт (per-SKU), они НЕ дублируются в marketplace_pnl_lines, у них разные цели.

## Кто что делает

- **Main chat (Claude):** добавляет в `marketplace_pnl_lines` следующие недели по мере получения xlsx от Aram. Ozon — обновляется ежемесячно из API.
- **Parallel chat (or anyone):** строит UI `/reports/wb` и `/reports/ozon` по этой спеке.

## Tokens

См. `das-secrets-masterfile.md`:
- CF D1 Admin: `<CF_D1_ADMIN_TOKEN>`
- GitHub PAT: `<GITHUB_PAT>`
