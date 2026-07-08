# Backlog — 2026-07-08 — Cloudflare Email Inbox

**Сессия:** интеграция Cloudflare Email Sending (`notify.dasexperten.com`) в Das Operator ERP + R2-архив входящей/исходящей почты по папкам на mailbox, плюс попутный фикс мёртвого домена `dasexperten.de` в существующем коде. Всё в PR [#104](https://github.com/dasexperten/dasoperator/pull/104), ветка `claude/cloudflare-email-sending-xxbsii`.

---

## ✅ Выполнено в этой сессии

### 1. Cloudflare Email Sending — исходящая транзакционная почта
- [x] Binding `EMAIL` (`send_email`, unrestricted destination) добавлен в `api/wrangler.toml`
- [x] `api/src/types.ts` — добавлены `EMAIL: SendEmail` и `ADMIN_EMAIL_TEST_SECRET?: string` в `Env`
- [x] `api/src/services/email.ts` — сервис-модуль: `sendEmail`, `sendTestEmail`, `sendLeadNotification`, `sendFormSubmissionNotification`, `sendOrderNotification`, `sendSystemNotification`
- [x] Жёсткая проверка домена отправителя — только `@notify.dasexperten.com`; `sales@dasexperten.com` / `support@` / и т.п. отклоняются с понятной ошибкой
- [x] `api/src/routes/email-send.ts` — `POST /api/email/test`, защищён admin-сессией (`Authorization: Bearer`, role `admin`) **или** секретом `ADMIN_EMAIL_TEST_SECRET` в заголовке `X-Admin-Email-Test-Secret`; поддерживает опциональный `from` для смок-теста любого из 5 адресов
- [x] Логирование попытки отправки (timestamp/sender/subject/success/messageId) без тела письма и без полного адреса получателя (PII-редакция)
- [x] **Реально протестировано** через временный `wrangler dev --remote` (не деплой в прод) — письма реально дошли на `a.v.badalyan@gmail.com` с каждого из 5 адресов, каждый раз с настоящим Cloudflare `messageId`:
  `no-reply@`, `notifications@`, `orders@`, `forms@`, `system@` — все `@notify.dasexperten.com`

### 2. R2 Inbox-архив (бакет `self-learning`, binding `ARCHIVE`)
- [x] `api/src/lib/inbox-archive.ts` — новый модуль
- [x] Структура: `Inbox/<mailbox>/sent/<timestamp>-<uuid>.json`, `Inbox/<mailbox>/received/...`, плюс `Inbox/<mailbox>.json` — индекс-файл со всеми записями этого ящика (без пагинации `list()`)
- [x] `dasexperten@gmail.com` программно исключён из архивации (этот ящик не трогаем — остаётся в Gmail)
- [x] Индекс обновляется через etag-conditional read-modify-write с retry (R2 не умеет атомарный append)
- [x] **Найден и исправлен реальный баг**: `R2Object.httpEtag` отдаётся в кавычках, а `onlyIf.etagMatches` кавычки не принимает — переключил на `.etag` (без кавычек). Без фикса второй и последующие апдейты индекса тихо проваливались
- [x] Подключено в `sendEmail()` — каждая успешная отправка архивируется автоматически
- [x] **Реально протестировано и подтверждено в живом бакете `self-learning`** — все 5 mailbox-папок с настоящими письмами + индексами уже лежат в R2 прямо сейчас (проверяемо в Cloudflare Dashboard → R2 → `self-learning` → префикс `Inbox/`)
- [x] После первого прогона с багом — переиндексировал (`rebuildIndex`) осиротевшие записи `no-reply@notify.dasexperten.com`, чтобы индекс совпадал с реальными объектами

### 3. Фикс мёртвого домена `dasexperten.de`
- [x] Aram сообщил, что `dasexperten.de` больше не доступен как домен
- [x] `web/components/emailer/compose-email.tsx` — селектор отправителя и дефолт `from` переведены на `@dasexperten.com` (eurasia/emea/marketing/sales/support)
- [x] `api/src/routes/email-tasks.ts` — seed-сценарии автоматизации (`pechkin-s1..s4`) переведены на `@dasexperten.com`
- [x] README-заметка про follow-up work исправлена (была `.de`)
- [x] **Не тронуто** (вне рамок этой задачи, флагнуто Араму): `api/src/middleware/cors.ts` (`erp.dasexperten.de` в allowed origins — это домен самого ERP-фронтенда, не почта), `Design/README.md` и `web/design-system/README.md` (ссылки на маркетинговый сайт `www.dasexperten.de`)

### 4. PR и CI
- [x] PR [#104](https://github.com/dasexperten/dasoperator/pull/104) создан как draft, подписка на webhook-события включена
- [x] 5 коммитов, CI зелёный на каждом (`migration-numbers` ✅, `Cloudflare Pages` ✅), 0 review-комментариев
- [x] Все ad-hoc тестовые Worker'ы (`wrangler dev --remote`), временные `.dev.vars` и scratch-директории — удалены после проверки; в прод ничего не задеплоено (деплой только через CI при мёрдже в `main`, согласно правилу репо "RAIL 5")

---

## ⚠️ Не сделано / TODO на будущие сессии

### Прямое продолжение этой фичи
- [ ] **Архивация `received`** — у 5 `notify.dasexperten.com`-адресов физически нет входящей почты (only-send, нет Email Routing на этот саб-домен), так что `received/`-папки остаются пустыми. Это ожидаемо для этих адресов
- [ ] **Архивация human-ящиков `dasexperten.com`** (`sales@`, `support@`, `emea@`, `asean@`, `eurasia@`) — их почта идёт через Google Apps Script / `emailer-bridge`, туда архивация ещё не встроена (ни sent, ни received). Нужно решить, перехватывать на стороне `emailer-bridge` или `api/src/routes/email.ts`
- [ ] **`erp.dasexperten.com/emailer` UI** — сейчас читает почту напрямую из Gmail (live через bridge), не из папок `Inbox/` в R2. Переключение на архив как источник данных не сделано
- [ ] Решить: чистить ли `dasexperten.de` в `cors.ts` (allowed origin ERP-фронтенда) и в `Design/README.md` / `web/design-system/README.md` (маркетинговый сайт) — ждём подтверждения от Арама, что домен мёртв целиком, а не только для почты

### Эксплуатация PR #104
- [ ] PR всё ещё **draft** — не смёржен. Ветка `claude/cloudflare-email-sending-xxbsii`
- [ ] После мёрджа: задать `wrangler secret put ADMIN_EMAIL_TEST_SECRET` в проде (`dasoperator-api`) — без этого `/api/email/test` вернёт 401 с любым секретом
- [ ] После мёрджа: прогнать acceptance-тест из тикета — `POST /api/email/test` с `{"to": "dasexperten@gmail.com"}`, ожидается письмо от `no-reply@notify.dasexperten.com`
- [ ] Индекс-файл `Inbox/<mailbox>.json` растёт бесконечно (весь список за всё время в одном JSON-массиве) — для v1 это ок, но если объём вырастет, потребуется пагинация/ротация индекса

---

## 🔑 Ключевые артефакты этой сессии

| Файл | Назначение |
|---|---|
| `api/wrangler.toml` | + `[[send_email]]` binding `EMAIL` |
| `api/src/types.ts` | + `EMAIL`, `ADMIN_EMAIL_TEST_SECRET` в `Env` |
| `api/src/services/email.ts` | Сервис отправки: 6 функций, валидация домена отправителя |
| `api/src/lib/inbox-archive.ts` | R2-архив sent/received + индекс-файл на mailbox |
| `api/src/routes/email-send.ts` | `POST /api/email/test` |
| `api/src/routes/email-tasks.ts` | Фикс `.de` → `.com` в seed-сценариях |
| `web/components/emailer/compose-email.tsx` | Фикс `.de` → `.com` в UI отправки |
| `README.md` | Раздел про EMAIL binding, allowed senders, R2 Inbox-архив |
| R2 bucket `self-learning`, префикс `Inbox/` | Реальные тестовые письма + индексы для всех 5 адресов |
| PR #104 | https://github.com/dasexperten/dasoperator/pull/104 |

---

**Сессия продолжается** (PR открыт, ждём решения Арама по scope продолжения — received-архивация, human-ящики, UI на `/emailer`, чистка `.de` вне почты).
**Статус:** ✅ ядро фичи (Cloudflare Email Sending + R2 sent-архив) готово и проверено вживую, PR открыт draft, CI зелёный.
