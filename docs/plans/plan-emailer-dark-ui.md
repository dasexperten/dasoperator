# PLAN — Emailer Dark UI v3 + Люди/Система + CRM-переписка + официальная почта
> Утверждён владельцем 2026-07-11. ФИНАЛ — открытых бизнес-решений нет.
> Проверено против живого репо dasexperten/dasoperator (main, клон 2026-07-11),
> живого R2 (бакет self-learning) и живого DNS (2026-07-11):
> зона dasexperten.com ACTIVE на CF; MX = route1-3.mx.cloudflare.net
> (Cloudflare Email Routing перед Workspace); Workspace установлен владельцем.
> Расхождения со снапшотом cloudflare.md (обновить): (1) архив писем — бакет
> self-learning (binding ARCHIVE), das-operator-data = ARCHIVE_OLD; (2) домен
> notify.dasexperten.com УДАЛЁН — системные отправители на my.dasexperten.com;
> (3) зона .com уже active, NS переключены с Wix.

## 1. OBJECTIVE
Перевести модуль /emailer на тёмный карточный интерфейс v3 с разделением писем
Люди/Система по природе письма (origin), AI-выжимкой «что они хотят», экраном
Заказы, CRM-лентой переписки по контрагенту — и довести официальную почту
(sales@, support@, emea@, eurasia@ на dasexperten.com, Google Workspace уже
установлен) до полной работоспособности с зеркалом в Operator.

## 2. SCOPE
IN (релиз 1 — ядро UI):
- Тёмная тема только внутри модуля emailer (мокапы: дашборд v4, экран письма, экран Заказы).
- Card-дашборд: переключатель Люди/Система, hero gold card «ждут ответа 48+ ч»,
  карточки корреспондентов, карточка Заказы (gold-счётчик), приглушённая карточка
  Система, табы Сегодня/Вчера/Неделя/Все.
- Read/unread (D1) + endpoint attention.
- Классификация origin=human|auto + trigger на каждом письме (метка при записи).
- Экран письма: выжимка v2 (3–4 строки: суть, что просят, дедлайн, температура),
  тело, чипы вложений, мини-хронология треда, ответ через существующий reply.
- Экран Заказы: лента заказов и заявок с форм за период, статусы
  новая/обработана, сумма подтверждённых, действия «открыть заказ» /
  «создать партнёра» / «ответить».
IN (релиз 2 — почта и CRM):
- CRM-лента переписки по контрагенту (мокап утверждён): склейка всех писем
  по адресам партнёра из модуля Partners, статистика, фильтр по ящикам.
- Официальная почта: приём как есть (CF → worker → R2), отправка апекса через
  Resend Pro (домен verified, DNS стоят), расширение ALLOWED_FROM в email-reply.ts.
OUT:
- Тёмная тема остального Operator; календарь.
- Кнопки-действия экрана письма (черновик ответа personizer — дизайн-мокап
  зафиксирован в спеке, перевод, разбор вложений, контекстная цена, в задачи) —
  третий этап после приёмки релиза 2.
- Изменение механики sendEmail()/R2-архива — только расширение полей записи.

## 3. ARCHITECTURE & SKILL FIT
Репо: dasexperten/dasoperator. web → CF Pages (dasoperator), api → Worker
dasoperator-api. Хранилища: R2 self-learning (binding ARCHIVE, Inbox/<mailbox>/...),
D1 das_erp_dev, KV das-cache-layer.
Почтовая топология (зафиксирована владельцем 2026-07-11, DNS проверен живьём):
- my.dasexperten.com — системный поддомен: orders@, forms@, no-reply@,
  notifications@, system@ (авто-письма Workers по триггерам; авто-письмо может
  уходить и с любого ящика — потому классификация per-message, не per-mailbox).
- dasexperten.com — официальные человеческие: sales@, support@, emea@, eurasia@.
  Приём: MX апекса = Cloudflare Email Routing → worker dasoperator-api → R2
  (уже работает, не трогаем). Отправка: Resend Pro, оба домена в одном
  аккаунте — my. (системный) + апекс (человеческий, verified 2026-07-11,
  DKIM d=dasexperten.com — письма уходят чисто, без via). Дом человеческой
  почты = Operator /emailer. Google Workspace отменён; VPS отклонён.
Существующее (переиспользуем):
- web/components/emailer/cloudflare-inbox-view.tsx — список/тред/reply, нижний слой.
- api/src/routes/email-archive.ts — чтение архива + существующий /summary
  (кэш в D1 email_summaries) — расширяем до v2.
- api/src/routes/email-reply.ts — ответ из UI (пишет origin=human).
- api/src/lib/inbox-archive.ts — запись архива (расширяем поля, механику не трогаем).
- Модуль Partners (api/src/routes/partners.ts): email(ы) партнёра — ключ CRM-ленты.
- web/styles/das-design-tokens.css — токены (schwarz #282229, ink #1A1519,
  rot #E5202C, gold #FEF004, stone-ряд; Archivo/Manrope подключены).
- Gmail-инфраструктура: emailer-bridge (OAuth-паттерн) — для зеркала исходящих.
Новое: web/components/emailer/{emailer-dashboard,attention-card,message-view,
orders-view,partner-thread-view,shared}.tsx; api/src/routes/email-state.ts;
Email Routing Worker (edge-архив); миграции D1; docs/design/emailer-dark-v3.md
(спека 7 мокапов: дашборд v4, письмо, черновик, CRM, Заказы, Система + цветомаппинг + UI hard rule).
Исполнитель: Claude Code + vision-coding skill. [NEW SKILL] не требуется.

Цветомаппинг v3 (зафиксирован):
- Канва #1A1519; карточки #282229; тело письма #221D22; текст #FBFAF6;
  вторичный #C9C1B0; мета #6E6558.
- Hero card: #FEF004, текст #1A1519/#4A4238. Выжимка: борт 3px #FEF004.
- Входящее #1D9E75, отправлено #E5202C. Система: #2C2C2A, текст #888780/#B4B2A9.
- Заказы: счётчик и суммы #FEF004; статус НОВАЯ — бейдж #1D9E75/#04342C;
  левый борт карточки: заказ #FEF004, заявка с формы #1D9E75.
- Активный таб — подчёркивание #FEF004. Главное действие: #FEF004 на #1A1519.
- Заголовки Archivo 900, UI-текст Manrope.

UI HARD RULE (зафиксировано владельцем 2026-07-11): никакой служебной/технической
информации в интерфейсе — имена бакетов, trigger-метки, названия таблиц, источники
данных НЕ отображаются ни в футерах, ни в подписях. Интерфейс говорит языком
бизнеса (заказы, заявки, письма), техника остаётся в коде и доках.

## 4. PHASES

### РЕЛИЗ 1

Фаза 1 — Токены и спека
1. Scoped-блок `.emailer-dark{…}` в das-design-tokens.css (module-scope, не :root).
   → done: /emailer на #1A1519, остальные страницы не тронуты.
2. docs/design/emailer-dark-v3.md — спека 6 мокапов + цветомаппинг + почтовая
   топология. → done: файл в репо, ссылка из Design/README.md.

Фаза 2 — API: origin, read, attention, выжимка v2
1. Расширить ArchiveEmailInput/IndexEntry в inbox-archive.ts: origin 'human'|'auto',
   trigger string|null. Все Worker-вызовы sendEmail() подписывают себя
   (order-confirmation, form-ack, …); email-reply.ts пишет origin=human.
   Входящие: Email Routing Worker метит по Auto-Submitted/Precedence/known-robots.
   → done: новые записи в R2 несут origin/trigger.
2. Backfill-скрипт (однократно, scripts/): старые записи метятся rule-based
   (отправитель my.-домена/no-reply → auto; остальное human).
   → done: в индексах нет записей без origin.
3. D1 миграция: email_read_state (message_key PK, mailbox, read_at);
   ALTER email_summaries ADD version INTEGER DEFAULT 1;
   email_attention_log (learning loop). Письма старше даты деплоя = read.
   → done: миграция применена к das_erp_dev.
4. api/src/routes/email-state.ts:
   POST /api/email/read {keys[]};
   GET /api/email/unread-count?group=human|system;
   GET /api/email/attention (последнее письмо sent >48h без received, только
   origin=human; кэш KV 15 мин);
   GET /api/email/orders?period=24h|7d (записи trigger LIKE 'order%'/'form%'
   + статус обработки: обработан = есть связанный ответ/партнёр/заказ ERP).
   → done: curl-тесты корректны.
5. Summary v2 в email-archive.ts (?v=2): 3–4 строки — суть, что просят, дедлайн,
   температура сделки; кэш с version=2. → done: тестовое письмо даёт 4 строки.

Фаза 3 — Дашборд (мокап «дашборд v4»)
1. attention-card.tsx — gold hero card. → done: живые данные /attention.
2. emailer-dashboard.tsx: переключатель Люди/Система (по origin) со счётчиками;
   заголовок «У вас N непрочитанных»; поиск; табы-периоды; грид auto-fit
   minmax(170px,1fr): hero (row-span 2) + карточки корреспондентов (группировка
   по correspondent(); утилиты в shared.ts) + карточка Заказы (gold-счётчик,
   /orders) + приглушённая карточка Система. Max 11 карточек + «ещё N →».
   → done: работает на живых данных.
3. page.tsx: дашборд по умолчанию, кнопка «списком» → старый CloudflareInboxView.
   → done: переключение без потери состояния.

Фаза 4 — Экран письма (мокап «письмо»)
1. message-view.tsx: шапка (имя Archivo 900, направление, тред), блок «ЧТО ОНИ
   ХОТЯТ» (/summary?v=2, левый борт gold, скелетон), чипы вложений, тело на
   #221D22, мини-хронология треда, кнопка Ответить (gold) → существующий reply.
   → done: открывается с дашборда и из списка, ответ уходит.
2. Открытие шлёт POST /read. → done: unread-count падает после возврата.

Фаза 4b — Экран Заказы (мокап «Заказы» — УТВЕРЖДЁН)
1. orders-view.tsx: заголовок с count и суммой подтверждённых, фильтры
   Все/Заказы/Формы/Необработанные, лента карточек (заказ — борт gold,
   заявка — борт green, бейдж НОВАЯ), действия: открыть заказ (ERP-модуль),
   создать партнёра (partners/new c prefill), ответить (reply).
   → done: открывается с карточки Заказы дашборда, фильтры работают.

Фаза 4c — Вкладка Система (мокап «Система» — УТВЕРЖДЁН)
1. Вид Система на дашборде (переключатель): заголовок «N системных за сутки»,
   подстрока «всё штатно · M требует взгляда»; аномалии (ошибки доставки,
   сбои) — карточки с красным бортом и действием «Разобраться» наверху;
   остальной шум сгруппирован по типам (подтверждения заказов, автоответы форм,
   уведомления Experten Club, служебные) со счётчиками; массовое действие
   «Отметить всё прочитанным». Приглушённая палитра #2C2C2A/#888780/#B4B2A9.
   → done: группы считаются по trigger, аномалии всплывают наверх.

Фаза 5 — Деплой и приёмка релиза 1
1. wrangler deploy dasoperator-api → done: state/attention/orders/summary?v=2 live.
2. Deploy web (Pages, превью-ветка → main). → done: /emailer в проде = v4.
3. Смоук: unread падает; attention очищается после ответа; заказ с формы виден
   в экране Заказы; живое письмо в системный ящик всплывает в Людях.

### РЕЛИЗ 2

Фаза 6 — CRM-лента по контрагенту (мокап «CRM»)
1. GET /api/email/by-partner/:slug — все письма всех ящиков, где correspondent
   ∈ email-адреса партнёра; агрегаты: всего, тредов, темп ответа, последний контакт.
   → done: endpoint отдаёт склейку из ≥2 ящиков.
2. partner-thread-view.tsx: шапка партнёра + бейдж «ждёт ответа», 4 метрики,
   фильтр-чипы по ящикам, хронология (системные — приглушённо). Входы: карточка
   корреспондента на дашборде + вкладка «Переписка» на /partners/[slug].
   → done: лента открывается из обоих входов.
3. Неопознанные корреспонденты: «создать партнёра» → partners/new с prefill.
   → done: цикл письмо→партнёр замкнут.

Фаза 7 — Официальная почта: Cloudflare-приём + Resend Pro-отправка
[РЕШЕНИЕ ПРИНЯТО 2026-07-11: Workspace и VPS отклонены (доступ/оплата из РФ
и Китая, лишняя эксплуатация); MailerSend отменён — владелец апгрейднул
Resend до Pro ($20/мес: 50k писем/мес, без дневного лимита, 10 доменов).
Дом человеческой почты = Operator.]
1. ✅ СДЕЛАНО 2026-07-11 в сессии: апекс dasexperten.com заведён в Resend
   (id 1dd3cc32-d961-4585-9a61-c4f4f68f4d9e, eu-west-1, Return-Path send),
   DNS в CF добавлены (TXT resend._domainkey, MX+TXT send.dasexperten.com),
   временный google-SPF на апексе нейтрализован (v=spf1 ~all),
   домен VERIFIED, тестовое письмо от sales@dasexperten.com отправлено
   (id 6b75972f) — владелец подтверждает чистоту в своём Gmail.
2. Входящие БЕЗ ИЗМЕНЕНИЙ: MX апекса = route1-3.mx.cloudflare.net,
   CF Email Routing → worker dasoperator-api → R2. Google Workspace: визард
   не подтверждать, триал отменить (Billing → Subscriptions → Cancel).
   → done: подписка Google отменена владельцем.
3. email-reply.ts: ALLOWED_FROM расширить адресами @dasexperten.com
   (sales, support, emea, eurasia, asean, dr.badalyan); reply-from по
   умолчанию = адрес, на который пришло письмо. Провайдер один — Resend,
   ветвления не нужно. → done: ответ из /emailer на письмо в emea@ уходит
   от emea@dasexperten.com и приходит без пометки via.
4. Гигиена ключей: полный ключ das-architektor удалить в дашборде Resend
   после закрытия фазы; в Worker остаётся send-only RESEND_API_KEY.
   → done: полный ключ отозван.

Фаза 8 — Приёмка релиза 2
Смоук: заявка с формы (auto) и живое письмо (human) одного контрагента — в одной
CRM-ленте с разными метками; ответ из /emailer от emea@ доходит и выглядит чисто.

## 5. DEPENDENCIES
Ф2.1→2.2→3.2; Ф2.3→2.4; Ф2.4(attention/orders)→3.1,4b; Ф2.5→4.1; Ф1→3,4,4b,4c;
Ф5 после 1–4c. Ф6 после Ф5 (origin в проде). Ф7.2 (SPF/DKIM) — независим,
можно СРАЗУ (15 минут, критично для доставляемости). Ф7.3→7.4→Ф8.

## 6. RISKS
1. SPF отсутствует прямо сейчас — исходящие из Workspace уже спамятся.
   Митигируем: Ф7.2 выполнить немедленно, не дожидаясь релизов.
2. Один провайдер на всё (Resend): его инцидент кладёт всю отправку.
   Митигируем: ошибки в email_send_errors + статус в /emailer; аварийный
   запасной канал — emailer-bridge (Apps Script/Gmail), уже существует.
3. Ошибки origin-классификации входящих. Митигируем: known-robots в KV,
   правка в одно место; смоук в Ф5.3.
4. Гонки read-state — состояние в D1, R2-индекс не трогаем.
5. Attention/summary дорогие — KV-кэш 15 мин, D1-кэш выжимок, глубина 30 дней.
6. Дубли: одно письмо через edge-архив и через Gmail-зеркало. Митигируем:
   dedupe по Message-ID при любой записи в архив.
7. Сетка при 50+ корреспондентах — max 11 карточек + «ещё N».

## 7. LEARNING LOOP
Сигналы: attention_shown/clicked/replied_after (порог 48ч → per-контрагент),
summary_expanded (качество выжимки), поправки origin вручную (обучение
классификатора), конверсия заявок с форм в партнёров (экран Заказы).
Всё в email_attention_log (Ф2.3). Еженедельная дистилляция self-learning;
канон — email-canon/DISTILL_FULL.md в das-operator-data, расширяем его.

## 8. ACCEPTANCE
- /emailer = тёмный дашборд v4 (Люди/Система, Заказы); клик → экран письма
  с выжимкой 3–4 строки; карточка Заказы → экран Заказы с действиями.
- Люди/Система по origin: авто-письмо с support@ — Система, живое на orders@my — Люди.
- Unread живой; attention очищается после ответа контрагента.
- CRM-лента контрагента склеивает все ящики, включая Workspace.
- Официальная почта: письмо от sales@dasexperten.com уходит без пометки via,
  mail-tester ≥9/10; входящие в /emailer как прежде, мгновенно (CF-путь);
  ответ на письмо уходит от того же адреса, куда оно пришло.
- Старый список/reply без регрессий; остальной Operator визуально не изменён.

## 9. OPEN BUSINESS DECISIONS
Пусто — план финальный.
