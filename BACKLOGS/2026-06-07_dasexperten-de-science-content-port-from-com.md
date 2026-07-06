# Session backlog — 2026-06-07 — dasexperten.de: порт научного контента с .com + подведение источников под claims

**Суть сессии:** аудит научной базы `dasexperten.com` (старый Wix-стор, богатый наукой) против `dasexperten.de` (новый полированный сайт, наука срезана до 3 механизмов). Цель — какой научный контент и какие продуктовые позиции с .com перенести на .de. Дальше — написаны готовые блоки (Parabiotics/Inocles, SYMBIOS live-vs-dead, detox/innoWeiss), и под каждую цифру-claim подведён первоисточник (или claim исправлен/опровергнут).

**Ключевой принцип (CLAUDE.md anti-simplicity):** .de срезал плотную науку, которая и продаёт. Задача — вернуть термины и цифры, а не упрощать.

---

## Карта двух сайтов (зафиксировано)

**dasexperten.de** (Cloudflare, EN/DE/RU/VN). Страницы: `/`, `/products`, `/bundles`, `/system`, `/science`, `/professionals`, `/about`, `/partners`. **Блога нет.** `/science` ужата до 3 механизмов:
1. 5-enzyme cascade (Dextranase · Invertase · GOX · Bromelain · Papain)
2. Live probiotics (Bacillus coagulans 4·10¹⁰ CFU)
3. Termo-activation (Papain · Lysozyme · Dextranase @ 39 °C)
Ассортимент: 9 паст (symbios, innoWeiss, detox, termo 39°, schwarz, ginger force, cococannabis, buddy microbies, evolution kids), 11 щёток, флосс.
- ⚠️ WebFetch к .de даёт **403** (Cloudflare). Снимать только через `curl -A "<UA>"`.

**dasexperten.com** (Wix). Научные страницы: `/enzymes`, `/probiotics`, `/microbiomefriendly`, `/naturals`. Блог: bacillus-coagulans, **inocles (the-hidden-dna)**, illusion-of-innovation, future-of-oral-health, great-toothpaste-myth, fluoride-free, innovating-with-probiotics, имбирь-и-зубы.
Продукты .com (17), которых разворот на .de потерял: **bio-100 biodegradable toothbrush (wheat straw)**, отдельная **Naturals** линия.

---

## ✅ Что сделано в этой сессии

### Готовый файл для вёрстки: `CoWork/dasexperten-de-science-blocks.md`
Содержит 4 блока, каждый EN/DE/RU, со вшитыми сносками и compliance-нотами:
- **Блок 1** — `/science` «04 · Parabiotics / Inocles»
- **Блок 2** — карточка SYMBIOS «live vs dead» + строка «×20 к клин. дозе»
- **Блок 4a** — detox (исправленные числа)
- **Блок 4b** — innoWeiss (механизм, без процент-claims)

### Подведение источников под цифры-claims (verification)
| Claim | Вердикт | Источник |
|---|---|---|
| Корица снижает IL-6 **до 98%** | ✅ подтверждено (IL-6 −98,3%, in vitro) | Ben Lagha A. et al., *PLOS ONE* 2021;16(1):e0244805 |
| Эвгенол предотвращает **до 90%** деминерализации | ❌ опровергнуто → реально **40–60%** (clove oil −59%, eugenol −41% от контроля 41 мг/л) | Marya CM. et al., *Int J Dent* 2012;2012:759618 |
| Inocles / Nature Communications | ✅ прямая ссылка; фейк-акроним «insertion-sequence-encoded…» убран (нет в статье) | Hamamoto N. et al., *Nat Commun* 2025;16, s41467-025-62406-5 |
| **4·10¹⁰ CFU** | ✅ спец рецептуры (CoA), эффективность дозы ×20 | Ratna Sudha M. et al., *Int J Dent* 2020;2020:8891708 (B. coagulans Unique IS2, 2·10⁹ CFU, РКИ) |

### Multi-agent workflow `dasexperten-science-gap-audit`
- Запускался для перепроверки gap-анализа. **Упал** на фазе Verify (sub-агенты зависали на curl+python-heredoc, таймаут 6×180с). Output пустой — ничего не дал. Не блокер, блоки писались из уже собранного материала.
- Скрипт: `…/workflows/scripts/dasexperten-science-gap-audit-wf_f1c4c9dd-24a.js`. Если перезапускать — вынести curl в отдельный bash-шаг без heredoc.

---

## 📋 BACKLOG — научные блоки с .com, ещё НЕ перенесённые на .de

Полный список gap'ов (приоритет high→low). Блоки 1/2/4 уже написаны; ниже — что осталось.

- [ ] **(сделать live)** Блок 1 Parabiotics, Блок 2 SYMBIOS, Блок 4 detox/innoWeiss — вставить в .de страницы из готового .md.
- [ ] **HIGH — Mouth–gut axis / системная связь** (с `/microbiomefriendly`): H. pylori в слизистой рта, жёлчные кислоты, ферменты+иммунные клетки слюны, стресс→падение слюны→дисбиоз, 700+ видов, метафора «firefighting → fire-resistant walls», 8 evidence-based стратегий. → новая страница `/science/microbiome` + блок на `/professionals`.
- [ ] **HIGH — Bacillus coagulans механизм (полный)**: спора переживает heat/acid/bile, дормантна месяцами, просыпается в слюне; молочная кислота vs S. mutans; ингибирует P. gingivalis; разрушает биоплёнку; снижает цитокины; синергия с корицей/гвоздикой. (Частично в Блоке 2, можно раскрыть на `/science` или в блог-посте.)
- [ ] **MEDIUM — Реминерализация без фтора**: CPP-ACP (Recaldent™), кальций-фосфатные системы, пептид **GH12** (buddy microbies, селективно бьёт кариесные бактерии, swallow-safe). История «чем заменили фтор». → блок на `/science` + карточки buddy/evolution.
- [ ] **MEDIUM — Блог / Journal на .de** (сейчас отсутствует). Портировать 5–6 статей: Inocles, Bacillus coagulans, fluoride-free, illusion-of-innovation, имбирь-и-зубы. Главный SEO+авторитет-актив.
- [ ] **LOW — «Великий миф о зубной пасте» / fluoride-free аргументация** как отдельный лендинг или блок «почему без фтора».

## 📋 BACKLOG — продуктовые позиции / категории для .de

- [ ] **HIGH — Ополаскиватель (mouthwash)**: реальная дыра ассортимента. `/microbiomefriendly` сам называет «microbiome-friendly mouthwash», а в линейке .de нет ни одного ринса.
- [ ] **MEDIUM — Скребок для языка** как отдельный SKU (сейчас «tongue cleaner» только на обороте щёток; tongue scraping = одна из 8 стратегий).
- [ ] **MEDIUM — Эко-щётка Bio 100 (wheat straw, биоразлагаемая)**: есть на .com, нет среди 11 щёток .de. Sustainability-угол для DE-рынка полностью отсутствует.
- [ ] **LOW — Витрина/коллекция «Naturals»**: .com `/naturals` = 4 натуральные формулы под зонтиком; на .de растворены в отдельных SKU. Собрать обратно как фильтр/категорию.
- [ ] **R&D / vision — Парабиотик-паста** (на принципе Inocles/постбиотиков): пока нет продукта, но Блок 1 закладывает позиционирование «next frontier».

## 📋 BACKLOG — compliance (HWG/UWG, рынок DE) перед публикацией цифр

- [ ] Все процент-claims пометить **«in vitro»** в видимой сноске (не клиника на людях).
- [ ] **98%**: формулировать как эффект полифенолов корицы (фракция из исследования), не «наша паста даёт −98%».
- [ ] **4·10¹⁰ CFU**: подтвердить сертификатом партии (CoA производителя). Если штамм в SYMBIOS ≠ **Unique IS2** — claim держать на уровне вида *B. coagulans*, не приписывать результат своему штамму.
- [ ] **Inocles**: «associated with / lower in», без причинно-следственного «снижает риск рака».
- [ ] (опц.) прогнать финальные формулировки через skill **legalizer** для немецкой витрины.

## 📋 BACKLOG — вёрстка / технические задачи

- [ ] Вставить блоки 1/2/4 в .de (Cloudflare Pages проект `Projects/dasexperten-de-website/`, деплой через wrangler — реквизиты в backlog 2026-06-05).
- [ ] Переводы **VN** для всех новых блоков (сейчас EN/DE/RU готовы).
- [ ] Если делать блог — поднять структуру `/journal` или `/blog` на .de (в sitemap сейчас нет).
- [ ] (опц.) починить и перезапустить gap-audit workflow для финальной перепроверки.

---

## Источники (полные выходные данные)
1. Ben Lagha A., Azelmat J., Vaillancourt K., Grenier D. *A polyphenolic cinnamon fraction exhibits anti-inflammatory properties in a monocyte/macrophage model.* PLOS ONE 2021;16(1):e0244805. https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0244805
2. Marya CM. et al. *In Vitro Inhibitory Effect of Clove Essential Oil and Its Two Active Principles on Tooth Decalcification by Apple Juice.* Int J Dent 2012;2012:759618. https://pmc.ncbi.nlm.nih.gov/articles/PMC3432374/
3. Hamamoto N. et al. *Giant extrachromosomal element "Inocle" potentially expands the adaptive capacity of the human oral microbiome.* Nat Commun 2025. https://www.nature.com/articles/s41467-025-62406-5
4. Ratna Sudha M. et al. *Evaluation of the Effect of Probiotic Bacillus coagulans Unique IS2 on Mutans Streptococci and Lactobacilli Levels in Saliva and Plaque.* Int J Dent 2020;2020:8891708. https://pmc.ncbi.nlm.nih.gov/articles/PMC7787822/

## Артефакты сессии
- `CoWork/dasexperten-de-science-blocks.md` — готовые блоки EN/DE/RU + сноски (для вёрстки)
- `CoWork/BACKLOGS/2026-06-07_dasexperten-de-science-content-port-from-com.md` — этот файл
