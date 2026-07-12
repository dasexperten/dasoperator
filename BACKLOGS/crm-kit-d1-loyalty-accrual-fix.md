# Бэклог сессии 2026-06-20 — CRM прозрела: RetailCRM мёртв, продажи и бонусы из KIT+D1, начисление починено
Category: erp

**Сессия:** Cowork, Mac
**Запрос-вход:** Почему CRM-страница ERP (erp.dasexperten.com/crm) не показывает или мало показывает продажи, не показывает бонусную программу и сколько бонусов люди получают?
**Итог-выход:** Корень найден прозвоном живых API (не доков). Бонусное начисление починено и задеплоено. Дашборд CRM переключён с мёртвого RetailCRM на KIT + D1-ledger. Мёртвый CF Workers Edit вычищен из каноника. Всё проверено вживую — цифры внутренне сходятся, новых крашей нет, баллы капают.

---

## 1. Диагностика — что было сломано

| # | Находка | Доказательство |
|---|---|---|
| 1.1 | CRM-фронт `erp.dasexperten.com/crm` (Next.js на Cloudflare Pages, проект `dasoperator`) дёргает Воркер `dasoperator-api`; данные продаж/бонусов идут через `/api/crm/*` | x-powered-by: Next.js; бандл указывает на `dasoperator-api.dasexperten.workers.dev` + роуты `/api/crm/{stats,funnel,timeline}` |
| 1.2 | `/api/crm/stats` и `/funnel` читали мёртвый **RetailCRM** (`dasexperten.retailcrm.ru`) | живой ответ Воркера: `"source":"dasexperten.retailcrm.ru"`, `orders_total:1115` |
| 1.3 | Продажи занижены ~на 37%: RetailCRM 1115 заказов против **1780 в KIT**; выручка обрезана (считался лишь один платёжный статус) | KIT `/orders` total_count=1780; у KIT два статуса оплаты — `PAYMENT_FINALLY_PAID` (1385) и `PAYMENT_PAID` (46) |
| 1.4 | Бонусный движок (D1) жив: 1128 участников, 29 696 активных баллов — но начисление сбоит | `/api/loyalty/stats`; webhook_last_7d: из 971 события `accrued` только 124, `skipped:status_not_final` 555, **13 краш `error:D1_ERROR: UNIQUE constraint failed: loyalty_accounts.phone`**, `pending=0` |
| 1.5 | Краш начисления = гонка в `upsertAccount`: SELECT-потом-INSERT, два одновременных вебхука `ORDER_STATUS_CHANGED` на новый телефон оба не находят запись и оба вставляют → UNIQUE | чтение `api/src/lib/loyalty.ts` строки 97-126 |
| 1.6 | Уровни: все 1128 на `svoy` — но это **НЕ баг**. max `lifetime_spent` = 4333 ₽ < порог `tsenitel` 10 000 ₽; аккаунтов «≥10k но svoy» = 0 | D1: `SELECT MAX(lifetime_spent)…`, mis-tiered count = 0 |
| 1.7 | Списания почти ноль (3 заказа, 150 ₽ из 1431 продажи) — продуктовая проблема (клиентам негде увидеть баланс: витрина на Yandex KIT без кабинета лояльности), не код | агрегат по `loyalty_discount` в заказах KIT |
| 1.8 | Токены протухли частично: classic `GitHub PAT ghp_pD7n…` в skill-файле мёртв (401); **CF Workers Edit** мёртв (1000). Cloud Master / Full Infra / D1 Admin — **живы** (первая проверка дала ложный «все мертвы» из-за неверного эндпоинта `/accounts/{id}/tokens/verify`; правильный `/user/tokens/verify` показал правду) | live curl; `cloudflare.md` уже фиксировал смерть Workers Edit с 2026-06-12 |
| 1.9 | Деплой Воркера идёт через GitHub Actions (`deploy-worker.yml`, on push main, paths `api/**`), не локальным wrangler (RAIL 5) | чтение workflow |
| 1.10 | График **Daily activity** на CRM-странице давал столб **1 028 регистраций** в один день (11.06) — это артефакт: 1024 аккаунта `source='retailcrm_migration'` при засеве движка получили `registered_at = created_at = 2026-06-11`, а не реальную дату регистрации | скриншот страницы; D1: на 11.06 1028 аккаунтов, у всех `registered_at=created_at`; органических `source='kit'` за тот день только 4 |

**Вердикт:** CRM-страница не сломана в вёрстке — она питалась из мёртвого источника (RetailCRM). Бонусы начислялись, но с транзиентным крашем из-за гонки. Уровни и редкие списания — не баги.

## 2. Сделано в этой сессии

| # | Действие | Где / коммит |
|---|---|---|
| 2.1 | Полная диагностика прозвоном живых API — KIT, Воркер `dasoperator-api`, D1 `das_erp_dev` — вместо доверия докам | песочница |
| 2.2 | Аналитический движок из сырых заказов KIT (у KIT нет готовой аналитики): все 1780 заказов, правильные статусы → выручка **899 817 ₽**, 1431 продажа, AOV 629 ₽, 2817 единиц, отмены 19,4%, повторные 9,3%, помесячная динамика. Показан превью-дашбордом | песочница |
| 2.3 | **Фикс начисления:** `upsertAccount` → атомарный `INSERT … ON CONFLICT(phone) DO UPDATE … RETURNING`. Проверен на живой D1 (двойной upsert тестового телефона: второй вызов обновляет, не падает; дубля нет; тестовая строка удалена) | `api/src/lib/loyalty.ts`, commit **630a424** → деплой success |
| 2.4 | Reprocess потерянных начислений — **не потребовался**: все 15 UNIQUE-сбойных заказов имеют `later_accrued=1` (ретрай вебхука добрал баллы) | D1 `loyalty_webhook_log` |
| 2.5 | Уровни перепроверены — система работает по ТЗ, просто никто не дотратил до 10k | D1 |
| 2.6 | Очистка мёртвого **CF Workers Edit** из `SECRETS/cloudflare.md`: убрана строка токена + правило выбора (deploy→Cloud Master) + строка ротации + имя из hard-rule, hard-rules перенумерованы 7-10→6-9, оставлена строка-метка о выводе | `das-architektura/SECRETS/cloudflare.md`, commit **ffe2250** |
| 2.7 | **Миграция CRM-дашборда:** `/stats /funnel /timeline /customers` переписаны с RetailCRM на единый кэшируемый KIT-агрегат (TTL 300, один пулл на загрузку) + D1-ledger. Форма ответов сохранена (фронт без правок), добавлены `revenue_total/aov/cancel_rate/monthly`. `/orders` уже был на KIT | `api/src/routes/crm.ts`, commit **f47a33a** → деплой success |
| 2.8 | Финальная перепроверка вживую: 4 эндпоинта 200/`source=kit+d1`/errors=[]; согласованность (`sales+cancelled ≤ orders`, сумма месяцев = revenue_total, воронка монотонна); **0 новых UNIQUE-крашей за час, 4 начисления за час** | live curl + D1 |
| 2.9 | **Фикс таймлайна:** дневные регистрации исключают разовый засев (`source <> 'retailcrm_migration'`). Проверено: 11.06 1028→**4**, максимум по дням 20 — реальная динамика. Счётчик членов 1133 не трогали (перенесённые — настоящие участники) | `api/src/routes/crm.ts`, commit **8970466** → деплой success |

## 3. Решения, принятые в сессии

- **KIT = единственный источник продаж** (1780 заказов). RetailCRM из контура чтения убран полностью.
- **Лояльность на странице — из D1-ledger** (`loyalty_accounts/transactions`), не из retail-поля.
- **Определение продажи:** `status ∈ {COMPLETED, WAIT_FOR_DELIVERY}` И `payment ∈ {PAYMENT_FINALLY_PAID, PAYMENT_PAID}`. По нему выручка = 899 817 ₽.
- **Один кэшируемый KIT-агрегат на все 4 read-эндпоинта** — загрузка страницы = один полный пулл KIT, а не четыре.
- **Деплой только пушем в main** (RAIL 5), никакого локального wrangler.
- **Новый classic GitHub PAT не плодить по сторам** — канонический fine-grained в `SECRETS/github.md` жив; CF-токен в репо не коммитить (риск авто-revoke GitHub).
- **Уровни и редкие списания — не баги**, а отдельные наблюдения (низкий средний чек / отсутствие кабинета лояльности на витрине).

## 4. Открытые хвосты

| # | Задача | Кто | Срочность |
|---|---|---|---|
| 4.1 | Воронка: база `registered` = телефоны заказов (1457), конверсия 88% малоинформативна. Переставить базу на D1-участников (1133) → метрика «членов → покупателей» | Claude | средняя |
| 4.2 | Новые метрики (вся выручка, AOV, отмены, помесячный график) добавлены в `/stats`, но НЕ выведены на фронт `web/app/crm/page.tsx` — вывести виджетами | Claude | средняя |
| 4.3 | Два POST-синка `/sync-site-sales`, `/backfill-site-sales` всё ещё на RetailCRM (пишут `marketplace_sales_daily('site')`) — переключить на KIT | Claude | средняя |
| 4.4 | Skill-файл `SKILLS/vision-coding/references/infrastructure/secrets-and-tokens.md` держит мёртвый classic `ghp_pD7n…` — синхронизировать с живым fine-grained из `SECRETS/github.md` | Claude/Aram | низкая |
| 4.5 | Новый classic `ghp_EdrsUn…` (выпущен Арамом в чате) — лишний широкий ключ; **отозвать** после синка канона | Aram | низкая |
| 4.6 | CF Workers Edit — из `cloudflare.md` убран; добить — удалить/перевыпустить сам токен в дашборде Cloudflare | Aram | низкая |
| 4.7 | Бонусы-списания ≈ ноль: клиенты не тратят баллы — на витрине KIT нет кабинета лояльности (баланс/redeem). Продуктовая задача — показать баланс и one-time промокод на сайте | Aram/Claude | средняя |
| 4.8 | `ghp_EdrsUn…` засвечен в сессии — ротация по протоколу при любом подозрении; репо держать private | памятка | — |
| 4.9 | У 1024 миграционных аккаунтов `registered_at` = дата импорта (11.06), а не реальная. Из графика исключены (4.2 fix), но если нужна честная история регистраций — бэкфилл из оригинального RetailCRM `createdAt` | Aram/Claude | низкая |

## 5. Карта данных после сессии

```
erp.dasexperten.com/crm  (Next.js, Cloudflare Pages «dasoperator»)
        │  /api/crm/{stats, funnel, timeline, customers, orders}
        ▼
dasoperator-api  (Cloudflare Worker)
   ├── KIT API  (api.kit.yandex.net/v1)  — заказы = источник истины (1780)
   │        один кэшируемый агрегат, TTL 300с
   └── D1 das_erp_dev  — loyalty_accounts / loyalty_transactions (1133 уч., 29 8xx баллов)
            ▲  начисление: INSERT … ON CONFLICT(phone) DO UPDATE  (гонка устранена)
            │  KIT webhook ORDER_STATUS_CHANGED
            └── reprocess/redeem/admin эндпоинты

Деплой:  push → main  →  GitHub Actions deploy-worker.yml (paths api/**)
RetailCRM:  выведен из read-контура (остался только в 2 legacy POST-синках — хвост 4.3)
```

## 6. Коммиты сессии

| Commit | Репо | Что |
|---|---|---|
| `630a424` | dasexperten/dasoperator | fix(loyalty): атомарный upsertAccount через ON CONFLICT(phone) |
| `f47a33a` | dasexperten/dasoperator | feat(crm): дашборд /stats /funnel /timeline /customers с RetailCRM на KIT+D1 |
| `8970466` | dasexperten/dasoperator | fix(crm/timeline): исключить миграционный засев из дневных регистраций |
| `ffe2250` | dasexperten/das-architektura | secrets(cloudflare.md): вычищен мёртвый CF Workers Edit |

---

**END — 2026-06-20 CRM prozrela / RetailCRM→KIT+D1 / loyalty accrual fix**
