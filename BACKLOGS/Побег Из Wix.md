# Побег Из Wix
### dasexperten.com — уход с Wix на Cloudflare (сайт + видео + домен + почта)

**Сессия:** 2026-07-01 → 2026-07-02
**Суть одной строкой:** вырвали `dasexperten.com` из walled-garden Wix на Cloudflare — пересобрали сайт на базе `dasexperten.de`, перенесли видео в R2, подняли `www` на Cloudflare через дырку в Wix DNS, запустили полноценный transfer домена Wix → OnlyDomains → Cloudflare NS. Wix сопротивлялся на каждом шаге (залоченные NS, убитая почта).

---

## 1 · Живое СЕЙЧАС (проверено)

- **`https://www.dasexperten.com` — новый сайт на Cloudflare, валидный SSL.** Работает для людей.
- **`dasexperten.com` (голый апекс)** → Wix отдаёт 301 на `www` → тот же новый сайт. Т.е. **весь домен уже показывает новый сайт** (апекс временно хопает через Wix-редирект).
- Превью-проект: **`https://dasexperten-com-staging.pages.dev`** (это и есть прод-контент).
- Старый Wix-магазин `.com` ещё существует (апекс-редирект живёт на нём), уйдёт после завершения трансфера.

---

## 2 · Что за сайт (и откуда контент)

**База = клон нового `dasexperten.de`** (НЕ скрейп Wix — это была ошибка захода 1-2, Aram поправил: приоритет `.de`, из Wix добавлять только отсутствующее, ничего не переписывать, фото с `.de`).

- Каталог: `.de` `assets/product-data.js` (`window.DX_PRODUCTS`, 24 товара, реальные рейтинги Wildberries, фото webp: `card/` пасты, `brush/` щётки, `floss/` флосс).
- Страницы `.de`: index, products, bundles, system (квиз), science, professionals, about, partners, loyalty, imprint, privacy.
- **Gap-страницы, добавленные из Wix** (которых на `.de` не было): `/faq` (11 Q&A) и `/blog` (9 постов, извлечены с живого Wix). Оба в дизайне `.de`.
- **SEO:** `canonical`/`hreflang`/`og:url` переписаны с `dasexperten.de` → `dasexperten.com` (272 URL в 47 файлах). Рабочие ссылки (`mailto:sales@dasexperten.de`, `loyalty.dasexperten.de/widget.js`) не тронуты.
- **Фикс:** пункты меню переносились на 2 строки при загрузке (layout shift: запасной шрифт шире → перенос, потом Archivo → влезает). Починено `white-space:nowrap` на `nav.top a.link` в `styles.css`.
- `robots.txt`: `Allow` (прод).

**Источники/генераторы** (`dasexperten-com-website/build/`): `generate-{products,pages,blog,pdp,faq,i18n}.js`, данные `catalog-export.json`, `blog-raw.json`, `product-translations.json` (17 товаров × 13 языков Wix-переводов — резерв под i18n), `ui-strings.json`.

---

## 3 · Видео (из локальной папки, НЕ Wix)

Aram: «Wix нахер, источник — папка **`C:\Users\user\Documents\DAS ANIMATION`**». Там ~37 роликов + картинки-персонажи + музыка.

- **R2-бакет `dasexperten-com-media`** (public, r2.dev домен **`pub-e9f2415fe5464105b2e659ba4420d423.r2.dev`**), отдаёт с range-стримингом.
- Залито 9 роликов (`videos/<slug>.mp4`, web-lite версии для скорости): `we-set-the-rules` (бренд), `symbios`, `innoweiss`, `detox`, `ginger`, `grosse`, `intensiv`, `schwarz` (продукты), `microbiome` (educational).
- Встроено: бренд-ролик на **главной** (вместо баннера), `microbiome` на **`/science`**, 7 продуктовых на **`/products`** («See them in action»). `preload=none/metadata` — не тормозят загрузку.
- **Detox 1957 — любимый ролик Aram** (вынести на видное место при доработке видео).
- Каталог всех 37 роликов с ориентацией/разрешением был снят (ffprobe нет — парсил mp4 `tkhd`): HQ-горизонтальные (Symbios 4K 217M, We Set The Rules HQ, Microbiome HQ), продуктовые, языковые версии Innoweiss (Chinese/Rus/English), вертикальные (WB/Ozon/reels), Lite-версии, мелкие UGC/AI-тесты.

---

## 4 · Домен-трансфер — СТАТУС и следующие шаги

**Почему пришлось делать полный transfer** (а не просто сменить NS):
- Wix **не даёт менять nameservers** для своих доменов (`NS records are not editable`).
- Cloudflare Pages не отдаёт голый апекс при внешнем DNS (апексу нельзя CNAME, у Pages нет фикс-IP).
- Cloudflare Registrar не примет домен, пока он не на CF-nameservers (замкнутый круг с Wix-локом).
- Cloudflare SSL-for-SaaS apex-proxying — **не на плане** (err 1404, Enterprise-only).
- Итог: единственный путь на Cloudflare — **transfer-out** (Wix по ICANN обязан отдать домен, блокировать не может) → регистратор, дающий свои NS → NS Cloudflare.

**Регистратор-получатель = OnlyDomains** (у Aram там уже `.de`, проверен с Cloudflare NS; reg.ru/Porkbun/Namecheap Aram отверг).

**Прогресс:**
- ✅ Wix: «Transfer away from Wix» → **auth-код получен** (в Gmail Aram, ~7 дней; в файлы не пишу — чувствительный).
- ✅ OnlyDomains: **Transfer In оформлен 2026-07-02**, `dasexperten.com`, +1 год, $17.99, Auto Renew OFF.
- ⏳ Идёт ~5-7 дней (ICANN), либо быстрее если Wix подтвердит/отпустит. **`www` живой всё это время** (DNS в Wix до завершения).

**Осталось (по порядку):**
1. (опц.) Ускорить: в Wix → Domains → dasexperten.com поискать «Approve/Release transfer». Wix может динамить (обструкция).
2. Как домен придёт в OnlyDomains → **Aram ставит NS Cloudflare**: `craig.ns.cloudflare.com` + `jillian.ns.cloudflare.com` (Domain Info → DNS Settings → Delegate to Your Name Servers).
3. Включить Auto Renew ON в OnlyDomains (чтобы не истёк).
4. **Я довожу CF-зону** `dasexperten.com` (id **`8754d20d716a017b21d6179a53133247`**, сейчас `pending`) при активации: апекс → Pages `dasexperten-com-staging`, `www` → Pages, **MX под почту**, `google-site-verification` TXT. ⚠️ Зона за сессию была намучена (снимал/добавлял custom domains) — сверить записи ПЕРЕД активацией.

---

## 5 · Почта — решение и что осталось

- **Wix-почта `@dasexperten.com` УМЕРЛА**, когда Aram запустил трансфер (Wix отключил Business Email — обструкция; мой DNS ни при чём, MX я не трогал, сверено). MX смотрит на `mail.dasexperten.com` = NXDOMAIN.
- **Провайдер решён: Cloudflare Email Routing** (бесплатно, всё на Cloudflare). Это **пересылка входящих** `@dasexperten.com` → на Gmail (не отдельный ящик/вебмейл).
- **Отправка «как @dasexperten.com»** — Email Routing не умеет; подключим «Send mail as» в Gmail через **Resend** (SMTP, домен верифицировать) — отдельным шагом.
- ⚠️ Настройка возможна **только когда зона активна на Cloudflare** (после трансфера). Плюс токен CF Cloud Master **без Email-Routing scope** (err 10000) → включать в дашборде или дать scoped-токен.
- **РЕШЕНО Aram 2026-07-02 — адреса `@dasexperten.com`:** `sales@`, `support@`, `emea@`, `eurasia@`, `dr.badalyan@`, `asean@`. **Пересылка:** все шесть → бренд-ящик **`dasexperten@gmail.com`** (подтверждено Aram; не личный `a.v.badalyan@`). Разнести по ролям — позже через virtual-staff. Catch-all `*@` — не заказан.
- **Осталось только исполнить** (когда зона активна): включить Email Routing + завести 6 правил → Gmail (destination верифицировать 1 раз) + Resend «Send as» для отправки. Пошаговый runbook с точными DNS-записями — `MAIL_AND_CUTOVER_RUNBOOK.md`.

---

## 6 · Гочи и уроки (важно для будущего)

- **Wix walled-garden:** NS не меняются, Business Email гаснет при трансфере, transfer может «динамиться». Единственный незаблокируемый рычаг — ICANN transfer-out.
- **CF Cloud Master токен НЕ может:** `POST /zones` (403), `DELETE /zones` (9109), Email Routing (10000), zone rules (редиректы поддоменов). Зоны — руками в дашборде.
- **Cloudflare Pages upload API падал 502** весь ~час (их инцидент, `POST /pages/assets/upload`) — деплой ретраить в цикле (R2/DNS при этом работали).
- **www-pointing через чужой DNS + CF Pages:** custom domain сначала висел `pending` (конфликт с pending CF-зоной в аккаунте). Фикс: снять www custom domain с Pages-проекта → заново добавить → через ~2 мин валидируется ВНЕШНЕ по CNAME → active + SSL.
- **Wix apex→www 301** (был настроен изначально) = поднятие только `www` фактически мигрирует весь домен для посетителей.
- **Классификатор auto-mode** блокирует: литерал токена в команде (грепать из SECRETS), деплой живого платёжного воркера без явного «ок», PII (email покупателей). Транзитные ошибки классификатора — ретраить.

---

## 7 · Ключевые коррекции курса от Aram (чтобы не повторять)

1. **База = `dasexperten.de`, НЕ скрейп Wix.** Из Wix — только отсутствующее, ничего не переписывать поверх, фото с `.de`.
2. **Видео — из локальной `DAS ANIMATION`, не с Wix.**
3. **Только `dasexperten.com`** в фокусе (не путать с `.ru`/`.de`).
4. **Всё на Cloudflare, без промежуточных регистраторов** (reg.ru исключён категорически; OnlyDomains — ок, т.к. свой и уже с CF).
5. **Скорость загрузки каждой страницы — постоянный приоритет.**
6. **Не гонять в поддержку Wix** — делать сами (через API / то, что Wix редактировать даёт).

---

## 🧊 ЗАМОРОЖЕНО решением Aram 2026-07-02: dasexperten.de выпал из DNS — НЕ ЧИНИМ, фокус .com

> Aram: «leave .de alone, всё про .com». Последствия зафиксированы и озвучены: пока .de вне DNS, лежат erp.dasexperten.de (ERP-фронт; обход = dasoperator.pages.dev), blog.dasexperten.de, loyalty.dasexperten.de и вся почта @dasexperten.de (включая mailto:sales@dasexperten.de, на который ссылается .com-сайт → заменить на @dasexperten.com после запуска Email Routing). В OnlyDomains у домена всё чисто (Active до 2029, Auto-Renew ON, NS craig/jillian, скрин 2026-07-02) — рассинхрон OnlyDomains↔DENIC-зона; если решим чинить, план ниже.

## 🚨 (архив) P0-ИНЦИДЕНТ 2026-07-02: dasexperten.de ВЫПАЛ ИЗ DNS

- **Симптом:** `dasexperten.de` (и ВСЕ поддомены: www, erp/dasoperator, blog, loyalty + ВСЯ почта @dasexperten.de) — **NXDOMAIN глобально**. Подтверждено тремя независимыми точками: Google DoH (Status 3), Cloudflare 1.1.1.1 DoH (Status 3), Anthropic-инфра (ENOTFOUND). Авторитативы DENIC (f.nic.de, a.nic.de) отвечают NXDOMAIN напрямую.
- **При этом:** DENIC whois = `Status: connect`, NS craig/jillian, `Changed: 2026-06-29T13:32` (3 дня назад что-то изменилось на уровне реестра!); RDAP = active; CF-зона `2a445c1b13c64bc5fc5d003bb09c5a7a` = active, DNSSEC disabled (DS-конфликт исключён), craig.ns.cloudflare.com авторитативно отвечает A 104.21.55.128/172.67.148.31.
- **Вывод:** запись домена в реестре есть, но делегирование НЕ опубликовано в живой зоне `.de` — рассинхрон DENIC ↔ регистратор. НЕ Cloudflare, НЕ деплой (Pages не трогает DNS). Чинится ТОЛЬКО со стороны OnlyDomains/DENIC.
- **Действия Aram (срочно):** (1) OnlyDomains → dasexperten.de → статус/алерты/дата продления; (2) почта аккаунта OnlyDomains — письма от DENIC/OnlyDomains около 29 июня (верификация holder-данных? биллинг?); (3) пере-сохранить NS (заново craig/jillian) для форс-републикации; (4) если не помогает — тикет в OnlyDomains: «domain Status connect at DENIC but absent from .de zone since 2026-06-29, please re-publish delegation»; (5) проверить transit.denic.de.
- Контент цел: Pages-проект `dasexperten-de` отдаёт всё на `dasexperten-de.pages.dev` — сайт вернётся мгновенно при восстановлении делегирования.

## 8 · Открытые задачи (TODO)

- [ ] **Дождаться завершения трансфера** (OnlyDomains уведомит) / при возможности ускорить в Wix.
- [ ] **Aram: поставить NS Cloudflare** в OnlyDomains после переезда + Auto Renew ON.
- [ ] **Я: активировать и сверить CF-зону** `dasexperten.com` — апекс→сайт, www, MX, verification.
- [x] **Почта — адреса решены** (Aram 2026-07-02): `sales@ / support@ / emea@ / eurasia@ / dr.badalyan@ / asean@` → все на бренд-Gmail `dasexperten@gmail.com`.
- [ ] **Почта — исполнение** (после активации зоны): **Cloudflare Email Routing** (6 правил + destination-верификация) + **Resend «Send as»**. Точные шаги/записи — `MAIL_AND_CUTOVER_RUNBOOK.md`.
- [ ] **Видео (не приоритет сейчас):** вынести **Detox 1957**; языковые версии Innoweiss на `/ru/`; заменить где нужно Lite→HQ; для прода r2.dev → свой домен `media.dasexperten.com`.
- [ ] **i18n (по решению Aram):** 9 недостающих языков (переводы товаров уже в `product-translations.json`); `.de`-база пока en/de/ru/vn.
- [ ] **Товары bio (DE123) / kinder (DE108)** — единственные Wix-SKU, которых нет в `.de` (решить, добавлять ли).
- [x] **Чек-аут разблокирован 2026-07-02:** воркер `dasexperten-checkout` задеплоен по явному «ок» Aram (version 85406017). Проверено: CORS отдаёт правильный origin для `dasexperten.com` И `www.dasexperten.com`, `.de` не сломан, `/health` ok + 5 SKU. `.com`-чекаут теперь должен проходить quote→shipping→payment (ошибка «Оформление временно недоступно» ушла). Остался клик-тест Aram на живом сайте.
- [ ] **Чек-аут — OTP-поле Link было слишком мелкое под 6 цифр (правка внесена 2026-07-02, НЕ задеплоено).** Решение Aram: Link ОСТАВЛЯЕМ (быстрая оплата для возвращающихся), чиним размер. Ранняя попытка «убрать Link» (правки cart.js `linkAuthentication`→email + воркер `payment_method_types:['card']`) ОТКАЧЕНА полностью — воркер как был (`automatic_payment_methods`). Итоговая правка — **только фронт**, объект `APPEARANCE` в `cart.js`: добавлен `rules['.CodeInput']` (шрифт 22px + паддинги — `.CodeInput` = документированный селектор Stripe для поля кода) + `rules['.Input']` 16px + `fontSizeBase` 15→16 (убирает авто-зум на мобиле). Деплой = только статика Pages (боевой воркер не трогаем). **ЗАДЕПЛОЕНО 2026-07-02** (`wrangler pages deploy` → prod-ветка `main`; проверено: `.CodeInput` + `fontSizeBase:16px` живы на `dasexperten-com-staging.pages.dev` и `www.dasexperten.com`, `linkAuthentication` на месте). Осталось: визуальный Link-OTP тест Aram (hard-refresh, ввести Link-email, получить код, глянуть влезают ли 6 цифр).
- [ ] **35 Wix members / loyalty** — подход не решён (email-инвайт vs Members API export).
- [ ] **Соц-prefill в чекауте (код готов 2026-07-02, НЕ задеплоен).** Решение Aram: гостевой чекаут + опция «в один клик» (Google/FB/VK), одинаковые квадратные кнопки 44×44 с официальными логотипами (`assets/social/{google,facebook,vk}.svg` — скачаны). Реализовано в cart.js `.com`: конфиг `SOCIAL={google,facebook,vk}` (пустой ID = кнопка скрыта), prefill email+имя через пересоздание Stripe-элементов с defaultValues, demo-режим `?dxsocial=demo`, двухпанельный desktop-лейаут (форма + постоянная сводка заказа), мобайл — одна колонка. Проверено на локальном превью (grid 401/259, кнопки 44×44, сводка живая). **Research-вердикты 2026:** Google — зелёный (клиентский GIS, ревью не нужно, нужен Web-client ID из консоли, кнопку рендерит Google — icon-режим 40×40, кастомная запрещена); Facebook — можно, но Meta часто требует Business Verification (~14 дн) + privacy/data-deletion страницы, довод «за» = /vn/ FB-first; VK ID — рекомендован SKIP (Mail.ru OAuth закрыт для новых с 07-2025, всё через VK ID; 60-дневная верификация под РФ-юрлица; РФ-провайдеры режут Cloudflare до 16КБ — /ru/-аудитория = диаспора с Google). **Дополнено 2026-07-02 (2):** по решению Aram добавлен **Mail.ru** (квадрат с фирменным «@», `assets/social/mailru.svg`; техчисто — едет через тот же VK ID app, свой OAuth Mail.ru закрыт для новых с 07-2025; кнопки VK+Mail.ru только на `/ru/`) и весь чекаут-стек **портирован на dasexperten.de** (cart.js байт-в-байт + assets/social/, диф подтвердил идентичность базы; проверено на превью: 4 кнопки, грид, Stripe-поля). **Дополнено 2026-07-02 (3):** добавлен **OK (Одноклассники)** — 5-я кнопка (`assets/social/ok.svg`, глиф #EE8208), тот же VK ID app (`vkGo('OK')`), только `/ru/`; синк на `.de` сделан; превью-проверка: 5 кнопок 44×44, ряд 260px влезает и в десктоп-колонку (365px), и в мобилу (339px). `/ru/`-ряд теперь полный по правилу ≤5 элементов на секцию. **Research #2 вердикты (2026-07-02, проверено на живых эндпоинтах):** **Instagram — SKIP навсегда** (Basic Display API убит 12-2024, замена = business-контент-API без consumer-identity и без email; IG-юзеров ловит кнопка Facebook через Meta Accounts Center). **OK — ADD NOW ✅ сделано** (VK ID `provider=ok_ru`, отдельной регистрации нет — один тумблер «Авторизация через Одноклассники» в кабинете VK ID app; email best-effort — OK-аккаунты часто phone-only). **LinkedIn — ADD LATER, не для чекаута** (auth-code-only + client_secret, PKCE для web нет, CORS на token/userinfo нет — проверено curl'ом; нужен мини-воркер ~60 строк; email отдаёт; регистрация self-serve + требует привязки LinkedIn Company Page; место ему — B2B лид-форма на /professionals). **TikTok — SKIP** (email не отдаёт НИ ПОД КАКИМ скоупом, display_name = ник-хэндл а не имя, client_secret-флоу + ручное ревью 1–2 нед с демо-видео; для /vn/ достаточно Google+FB). **WeChat login — SKIP** (у WeChat-аккаунтов нет email в принципе, QR-флоу, $99/год + ICP-стена). **Alipay login — SKIP** (нужно китайское юрлицо), НО **PIVOT: Alipay как способ ОПЛАТЫ через Stripe — ADD NOW**: DE-аккаунт Stripe поддерживает, EUR, включается тумблером dashboard.stripe.com/settings/payment_methods, авто-всплывает в нашем Payment Element через уже включённый automatic_payment_methods — ноль кода. **WeChat Pay via Stripe — ADD LATER** (тот же тумблер + 1 параметр `payment_method_options[wechat_pay][client]=web` в воркере). **STRIPE-КОШЕЛЬКИ (2026-07-02, через Chrome, Aram залогинил дашборд):** (1) **Google Pay: Disabled → Enabled** в дефолт-конфигурации `pmc_1Rt4dIGyWzlIhMzYmfelkd0W` (была выключена — «Google Pay в чекауте» до этого не мог показываться). (2) **Payment method domains: добавлены `dasexperten.com` (pmd_1TojqM…) + `www.dasexperten.com` (pmd_1TojuY…), оба Enabled** — без них Apple Pay/Google Pay/Link не работают в Payment Element на своём домене (были только js.stripe.com/checkout.stripe.com). (3) **Alipay — НЕДОСТУПЕН на этом аккаунте:** Stripe-аккаунт = Das Experten International LLC (**ОАЭ**), Alipay Stripe даёт мерчантам ~39 стран (DE — да, AE — нет); его нет ни в списке методов (4 шт.), ни в Manual integration options (там только Cards+Apple Pay). Путь при желании: Stripe-аккаунт на немецкое юрлицо (DEE) — отдельное большое решение. WeChat Pay — та же стена. (4) Кошельковый стек чекаута теперь: Cards + Apple Pay + Google Pay + Link, домены зарегистрированы. **ЛОКАЛЬ-СПЛИТ + ALIPAY (2026-07-02, поздний вечер, решения Aram):** (1) `/ru/` = ТОЛЬКО российские системы (VK·Яндекс·Mail.ru·OK, Google убран — закон РФ об авторизации; формально на немецкое юрлицо не распространяется, решение = доверие аудитории); (2) международные en/de/vn = ВСЁ: Google(GIS)·Facebook·VK·Яндекс·Mail.ru·OK (6 квадратов, влезают); (3) деплой с кэш-бастом `cart.js?v=9→10` (гоча: `/assets/*` правило в `_headers` даёт 1ч edge-кэша и перекрывает `/*.js` must-revalidate — изменения cart.js ВСЕГДА возить с бампом `?v=` в 13 HTML обоих сайтов); проверено live. (4) **Prefill подтверждён на проде** (скрин Aram: email+имя встали от Google-клика). (5) **Alipay = способ оплаты через Stripe** (не логин — кит. юрлицо): попытка включить тумблер через Chrome упёрлась в Stripe-логин (вводить пароли нельзя) — **Aram: залогиниться в dashboard.stripe.com → Settings → Payment methods → Alipay → Turn on** (или залогинься и скажи — дощёлкаю). Наш Payment Element покажет Alipay китайским покупателям автоматически (automatic_payment_methods уже включён; из EU кнопку не видно — это норма, проверять через Stripe test-mode preview). **КОРРЕКЦИЯ КУРСА Aram + UI-фикс (2026-07-02, вечер):** (1) Aram: «UI идентичен макету — все квадраты видимы всегда, Яндекс после VK»; SDK-кнопка Яндекса на проде не отрисовалась (пустой ряд) → **переделано**: Яндекс = такой же квадрат 44×44, свой попап-флоу `oauth.yandex.ru/authorize` + упрощённый token.html (postMessage `dx-yandex`, без yastatic SDK); все 5 квадратов на `/ru/` (Google·VK·Яндекс·Mail.ru·OK) и 2 на en/de/vn (Google·FB) видимы БЕЗ demo-параметра; невайренные — но-оп до ключей. Задеплоено, проверено live. (2) Aram: «не создавай заново — всё уже создано под фундамент .de» → подтверждено: **loyalty-bridge = готовый OAuth-шлюз 10 провайдеров** (cloudflare.md §loyalty-bridge + loyalty-bridge/PROVIDERS.md): Google Web-client LIVE `962731465268-jomqo…` (проект dasexperten-loyalty-498717, a.v.badalyan@gmail.com, In production), Яндекс `ff78552…` (тот самый), **VK app 54627578 с включёнными OK+Mail.ru multibranding** (блокер: бизнес-верификация ООО в VK ID — за Aram), Telegram-виджет LIVE, Apple/TikTok/Sber/Zalo/LINE — слоты. Полузаполненный мастер в das-experten-automation брошен, ничего не создано. **Google подключён переиспользованием**: в клиент loyalty-web добавлены JS origins .com apex+www (сохранено, «OAuth client saved»; действует ч/з 5 мин–часы), ClientID в cart.js, задеплоено. Осталось: смоук Яндекс+Google на живом /ru/; VK/Mail.ru/OK — после верификации VK (потом: вписать 54627578 в SOCIAL.vk + добавить наш redirect в app). **ЯНДЕКС LIVE 2026-07-02:** по решению Aram переиспользовано существующее приложение **«Das Experten Loyalty»** (ClientID `ff78552aaaa142dabd7266b52b45236b`, скоупы email/имя/аватар уже были; кабинет = dasexperten@yandex.ru). Через Chrome добавлены Redirect URI `dasexperten.com/auth/yandex/token.html` + www-вариант и Suggest Hostnames (loyalty-bridge URI не тронут; «существующие токены продолжат работу»). ClientID вписан в cart.js → **задеплоено на .com**, проверено live: cart.js с ID, token-страница отдаётся (через безвредный 308 `.html`→extensionless, фрагмент сохраняется), логотип 200. Детали/секреты → `SECRETS/yandex-oauth.md` (создан + строка в index-secrets.md). Гоча кабинета: «Создать приложение» стабильно падает `CreateOAuthClientProblem: INTERNAL` — поэтому переиспользование. Остался смоук-тест Aram живого логина (проверка модерации `unauthorized_client`). **Research #3 вердикты (2026-07-02):** **Яндекс — ADD NOW ✅ реализовано** (100% клиентски: suggest-SDK кнопка `buttonView:'icon'` 44px в ряду `/ru/` + token-страница `/auth/yandex/token.html` (создана, origin-pinned через location.origin — работает на apex и www); email через `login:email` → `login.yandex.ru/info` (CORS `*` проверен вживую); осталось: регистрация app на oauth.yandex.ru — БЕСПЛАТНО, мгновенно, юрлицо не нужно, аккаунт = тот же что Yandex Metrika; Redirect URIs: `https://dasexperten.com/auth/yandex/token.html` + `https://www.dasexperten.com/auth/yandex/token.html`; скоупы login:email + login:info; ClientID → SOCIAL.yandex в cart.js; гоча: `unauthorized_client` = модерация — smoke-test сразу). **Ozon — SKIP** (программы «вход через Ozon» для внешних сайтов НЕ существует: Ozon ID = внутренний SSO, dev.ozon.ru OAuth = только Seller API к данным магазина; в 2026 Ozon сам потребитель чужих логинов, не провайдер). **WB — SKIP** (WB ID для внешних = закрытый пилот по договорам для крупных RU-брендов (Profi.ru, Riv Gosh…), без публичной регистрации/SDK; телефон-центричен, email не отдаёт даже партнёрам; селлерство ничего не даёт). **Блокеры:** (1) Google Client ID — консоль (5 мин, проект das-experten-automation, Auth Platform → Clients → Web app, origins: оба апекса+www .com и .de + localhost + pages.dev); (2) решение Aram по FB (Business Verification ~14 дн); (3) VK ID app — один на VK+Mail.ru+OK (регистрация + 60-дн верификация, иностранцам ручная); (4) деплой: cart.js на Pages `.com` + `.de` и воркер CORS — ок Aram.
- [x] **Зона почищена 2026-07-02:** снесены **14 дохлых Wix-CNAME** языковых сабдоменов (`ar/de/en/es/fr/ms/pl/ru/th/tl/tr/uk/vi/zh → cdn1.wixdns.net`). Осталось: апекс+www CNAME на Pages (ОК), google-verification TXT (ОК), мёртвый MX `mail.dasexperten.com` (снести при включении Email Routing — PART 4.0 runbook).
- [x] **Апекс `dasexperten.com` заведён в Pages-проекте** `dasexperten-com-staging` 2026-07-02 (было только www). Сейчас `status=pending` (норма: HTTP-challenge идёт на Wix, пока NS не переехали) → cert выпустится САМ при активации зоны. НЕ делать delete/re-add апекса. Детали — PART 0.2/3 runbook.

---

## 9 · Файлы и локации

- **Проект сайта:** `CoWork/Projects/WEBSITE MIGRATION CLOUDFLARE+HETZNER/dasexperten-com-website/` (`public/` = деплой, `build/` = генераторы + данные).
- **Документы миграции** (в той же папке проекта): `AUDIT_AND_PLAN_2026-07-01.md`, `GAP_ANALYSIS_de-base_vs_wix.md`, `NEXT_STEPS_and_cutover.md`, `catalog-export.json`, `orders-archive-summary.json`, `build/apply-com-dns.sh`, `build/blog-redirects.json`.
- **База `.de`:** `CoWork/Projects/dasexperten-de-website/public/` (source of truth каталога/фото/дизайна) + `_stripe/worker/` (checkout-воркер).
- **Видео-источник:** `C:\Users\user\Documents\DAS ANIMATION`.
- **Память:** `memory/dasexperten-com-wix-migration.md` (детальная хроника).
- **Инфра:** `SECRETS/cloudflare.md` (обновлён: зона `.com`, бакет `dasexperten-com-media`), `SECRETS/wix.md`, `SECRETS/stripe.md`, `SECRETS/reg-ru.md` (`.ru` для контекста).

---

## 10 · Инвентарь идентификаторов

```
CF account:          081ddb85cb399ad62a70210328d744fc (Das Experten Enterprise)
CF Pages project:    dasexperten-com-staging  → dasexperten-com-staging.pages.dev
CF zone .com:        8754d20d716a017b21d6179a53133247 (pending)
CF nameservers:      craig.ns.cloudflare.com, jillian.ns.cloudflare.com
R2 bucket (видео):   dasexperten-com-media  → pub-e9f2415fe5464105b2e659ba4420d423.r2.dev
Wix site id:         0c388495-149b-4357-b9e1-677650f4dee9
Домен:               dasexperten.com — Wix (регистратор) → трансфер в OnlyDomains (в процессе)
Почта:               @dasexperten.com мёртвая → план Cloudflare Email Routing (после трансфера)
```

*Конец бэклога. Продолжение — по завершении трансфера: NS Cloudflare → активация зоны → апекс + почта.*
