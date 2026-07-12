# Backlog — 2026-07-11 — Emailer: restore orphaned tabs, fix dead .de CORS origin
Category: erp

**Триггер:** Арам подтвердил, что почта дошла, но «ui ux sucks».

## Диагноз

`app/emailer/page.tsx` (добавлен в 65e6293, 2026-07-08) с самого начала рендерил **только** `CloudflareInboxView`. При этом в том же коммите были добавлены ещё пять компонентов — `tasks-view.tsx`, `scenarios-view.tsx`, `learning-view.tsx`, `email-history.tsx`, `compose-email.tsx` — и их бэкенд (`/api/email-tasks/*` и т.д.), которые нигде не импортировались. `BACKLOGS/self-learning-emailer.md` (09.07) описывает их как «LIVE on prod» с полноценным self-learning движком (Nemotron анализирует → Opus 4.8 пишет черновик в стиле Арама, approve-цикл, сценарии-автоматизация) — но эта вкладочная навигация в `page.tsx` никогда не коммитилась. Пять готовых фич были мертвым кодом с 08.07.

Заодно поймал ту же дыру `erp.dasexperten.com` (мёртв, NXDOMAIN) в CORS allowlist `dasoperator-api` — уже фиксил её в предыдущем коммите этой же сессии (`17b96b4`), сюда попало через тот же PR.

## Исправлено

- [x] `web/app/emailer/page.tsx` — добавлена вкладочная навигация (Inbox / Tasks / Scenarios / Learning / History / Compose), панели монтируются один раз при первом визите (паттерн как в `app/analytics/page.tsx`).
- [x] `web/components/emailer/cloudflare-inbox-view.tsx` — Inbox переделан из 3-уровневого full-page drill-down (список ящиков → список писем → письмо, каждый уровень заменяет весь экран) в двухпанельный layout (список писем слева, письмо справа) после выбора ящика. Добавлен поиск по subject/from/to. Добавлено непрочитанное на уровне письма (localStorage per-браузер — в R2-индексе нет поля `read`, полноценная синхронизация потребует бэкенд-миграции).
- [x] Проверено: `tsc --noEmit` чисто, `next build` проходит целиком, `/emailer` компилируется.

## Не сделано / TODO

- [ ] Живой клик-тест на `erp.dasexperten.com/emailer` — в этой сессии нет браузера с авторизованной сессией ERP, только tsc+build.
- [ ] Настоящая (не localStorage) read/unread-синхронизация между устройствами — нужна миграция D1/R2-индекса с полем `read`.
- [ ] `dr.badalyan@dasexperten.com` теперь тоже роутится (см. `dasexperten.com/BACKLOGS/2026-07-11_com-mail-routing-gap-fix.md`) — добавить в текст пустого состояния Inbox (уже сделано в этой сессии) и свериться, что в списке mailbox не потеряется при следующем ребилде UI.
