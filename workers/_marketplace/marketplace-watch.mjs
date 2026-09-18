/**
 * marketplace-watch.mjs — новости площадки и итог прошедшего дня.
 *
 * Владелец 2026-08-19: у двух маркетплейсных мест слоты перестают быть
 * одинаковыми. Ночной слот считает оборот закрытого дня; утренний и дневной
 * читают, что площадка сказала селлеру. Остальные слоты — как были, стоки и
 * продажи.
 *
 * Живая проверка 18.08 21:45 UTC на боевых ключах:
 *   WB  GET  common-api/api/communications/v2/news?from=…   → 200, 68 записей
 *       (v1 того же пути — 404, не звать)
 *   OZ  GET  api-seller/v1/actions                          → 200, 10 акций
 *       POST api-seller/v1/rating/summary                   → 200, 4 группы
 *
 * Ничего не пишет наружу: только читает и возвращает выжимку для отметки часа.
 */

import { wbFetch, ozonFetch, ozonClientId } from "./marketplace-api.mjs";

const WB_COMMON = "https://common-api.wildberries.ru";

/**
 * Общий помощник Ozon умеет только POST — так устроены почти все их пути.
 * Но /v1/actions на POST отвечает 405 (проверено 18.08), ему нужен GET.
 */
async function ozonGet(env, path) {
  const key = String(env.OZON_API_KEY || env.DASHA_OZON_API_KEY || "").trim();
  const clientId = ozonClientId(env) || String(env.DASHA_OZON_CLIENT_ID || "").trim();
  if (!key || !clientId) throw new Error("нет ключей Ozon");
  const res = await fetch(`https://api-seller.ozon.ru${path}`, {
    headers: {
      "Client-Id": clientId,
      "Api-Key": key,
      "User-Agent": "dasha-ozon/1.0 (+dasexperten fleet)",
    },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { ok: res.ok, status: res.status, body };
}

/** YYYY-MM-DD в московском дне, со сдвигом назад. */
export function mskDay(daysBack = 0) {
  return new Date(Date.now() + 3 * 3600_000 - daysBack * 86400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Слова, по которым новость площадки касается денег или сроков. Всё
 * остальное — фон: склад в другом городе, конкурс, интерфейс.
 */
const HOT = [
  "комисси", "тариф", "штраф", "удержан", "блокиров", "приостанов",
  "акци", "скидк", "промо", "дедлайн", "до \u0020", "обязательн", "требован",
  "маркировк", "честный знак", "возврат", "хранени", "логистик", "приём",
  "не принимает", "закрыт", "эвакуирова", "изменени",
];

function isHot(text) {
  const s = String(text || "").toLowerCase();
  return HOT.some((w) => s.includes(w));
}

/** Наши склады и направления — новость про них важнее прочих. */
const OURS = ["рязан", "краснодар", "электростал", "шушар", "невинномысск", "коледино", "казан", "тула"];

function touchesUs(text) {
  const s = String(text || "").toLowerCase();
  return OURS.some((w) => s.includes(w));
}

/**
 * WB: новости портала за окно. Возвращает список коротких строк, уже
 * отсортированный: сначала то, что задевает деньги или наши склады.
 */
// Владелец 2026-08-21: восемь было потолком, пока из ленты выносилась одна
// строка — лишнее всё равно выбрасывалось. Теперь час отдаёт разбор, и обрезка
// до восьми съедала половину ленты ДО сборки: за 19–20 августа площадка
// прислала 16 новостей, на доску доехало 8. Площадка опрашивается тем же
// одним запросом — цена подъёма нулевая.
export async function wbNews(env, { daysBack = 1, limit = 16 } = {}) {
  const from = mskDay(daysBack);
  const r = await wbFetch(env, WB_COMMON, "/api/communications/v2/news", {
    query: `from=${from}`,
  });
  if (!r.ok) {
    return { ok: false, http: r.status, error: `WB news HTTP ${r.status}`, items: [] };
  }
  const raw = Array.isArray(r.body?.data) ? r.body.data : [];
  const since = Date.parse(from + "T00:00:00+03:00");
  const items = raw
    .filter((x) => {
      const t = Date.parse(x.date || "");
      return Number.isNaN(t) ? true : t >= since;
    })
    .map((x) => ({
      date: String(x.date || "").slice(0, 10),
      header: String(x.header || ""),
      text: String(x.content || "").replace(/\s+/g, " "),
      hot: isHot(x.header) || isHot(x.content),
      ours: touchesUs(x.header) || touchesUs(x.content),
    }));
  items.sort((a, b) => (b.ours - a.ours) || (b.hot - a.hot) || (b.date < a.date ? -1 : 1));
  return {
    ok: true,
    http: r.status,
    from,
    total: items.length,
    hot: items.filter((x) => x.hot).length,
    ours: items.filter((x) => x.ours).length,
    items: items.slice(0, limit),
  };
}

/**
 * Ozon: акции, в которых мы участвуем или можем, плюс сводка рейтингов.
 * Собственного ленточного канала новостей у Seller API нет — площадка говорит
 * с селлером акциями и рейтингом, поэтому смотрим их.
 */
export async function ozonNotices(env, { limit = 8 } = {}) {
  const out = { ok: true, actions: [], ratings: [], error: null };

  try {
    const a = await ozonGet(env, "/v1/actions");
    if (!a.ok) throw new Error(`акции HTTP ${a.status}`);
    const rows = Array.isArray(a.body?.result) ? a.body.result : [];
    const now = Date.now();
    out.actions = rows
      .map((x) => {
        const end = Date.parse(x.date_end || "");
        const daysLeft = Number.isNaN(end) ? null : Math.round((end - now) / 86400_000);
        return {
          id: x.id,
          title: String(x.title || "").slice(0, 90),
          participating: Boolean(x.is_participating),
          in_count: Number(x.participating_products_count) || 0,
          could_count: Number(x.potential_products_count) || 0,
          days_left: daysLeft,
          // Горячее — то, что кончается на неделе, или то, куда можно войти.
          hot: (daysLeft != null && daysLeft <= 7) ||
            (!x.is_participating && Number(x.potential_products_count) > 0),
        };
      })
      .sort((p, q) => (q.hot - p.hot) || ((p.days_left ?? 999) - (q.days_left ?? 999)))
      .slice(0, limit);
  } catch (e) {
    out.ok = false;
    out.error = "actions: " + String((e && e.message) || e).slice(0, 120);
  }

  try {
    const r = await ozonFetch(env, "/v1/rating/summary", {});
    if (!r.ok) throw new Error(`рейтинг HTTP ${r.status}`);
    const groups = Array.isArray(r.body?.groups) ? r.body.groups : [];
    for (const g of groups) {
      for (const it of g.items || []) {
        const st = String(it.status || "");
        // UNKNOWN_STATUS — площадка ещё не посчитала, это не тревога.
        if (st === "OK" || st === "UNKNOWN_STATUS") continue;
        out.ratings.push({
          group: String(g.group_name || ""),
          name: String(it.name || ""),
          value: it.current_value,
          was: it.past_value,
          status: st,
        });
      }
    }
  } catch (e) {
    out.ok = false;
    out.error = (out.error ? out.error + " · " : "") +
      "rating: " + String((e && e.message) || e).slice(0, 120);
  }

  return out;
}

/**
 * Итог закрытого дня из хранилища ERP. Одна цифра и движение к позавчера —
 * этого хватает для ночной отметки; за подробностями есть /sales-report.
 */
export async function dayTurnover(env, marketplace) {
  if (!env.ERP_DB) return { ok: false, error: "no ERP_DB" };
  const day = mskDay(1);
  const prev = mskDay(2);
  try {
    const res = await env.ERP_DB.prepare(
      // Деньги в хранилище лежат в копейках. Делим здесь, у самого чтения,
      // чтобы дальше по файлу рубль был рублём и никто не напечатал сотню лишних.
      `SELECT date, units_sold, ${sqlRub("revenue_rub", "rub")}
         FROM marketplace_sales_daily
        WHERE marketplace = ?1 AND date IN (?2, ?3)`
    ).bind(marketplace, day, prev).all();
    const rows = res.results || [];
    const pick = (d) => rows.find((r) => String(r.date).slice(0, 10) === d) || null;
    const a = pick(day);
    const b = pick(prev);
    if (!a) {
      return { ok: false, day, error: "за закрытый день строки нет — ночной сбор не дошёл" };
    }
    const rev = Number(a.rub) || 0;
    const prevRev = b ? Number(b.rub) || 0 : null;
    const delta = prevRev ? Math.round(((rev - prevRev) / prevRev) * 100) : null;
    return {
      ok: true,
      day,
      units: Number(a.units_sold) || 0,
      revenue: rev,
      prev_revenue: prevRev,
      delta_pct: delta,
    };
  } catch (e) {
    return { ok: false, day, error: String((e && e.message) || e).slice(0, 140) };
  }
}

import { unitPriceSane, unitSanityNote, sqlRub } from "./money.mjs";

/** Одна строка для отметки часа — по-русски, без терминов. */
export function turnoverLine(t) {
  if (!t.ok) return null;
  if (!unitPriceSane(t.revenue, t.units)) {
    return unitSanityNote(`оборот ${t.day}`);
  }
  const money = Math.round(t.revenue).toLocaleString("ru-RU");
  const move = t.delta_pct == null
    ? ""
    : `, ${t.delta_pct >= 0 ? "+" : ""}${t.delta_pct}% ко вчера`;
  return `оборот ${t.day}: ${money} ₽, ${t.units} шт${move}`;
}

/** Одна строка для отметки часа по новостям WB. */
export function wbNewsLine(n) {
  if (!n.ok) return null;
  if (!n.total) return "новостей площадки нет";
  const head = n.items[0];
  const tail = n.ours ? `, наших складов ${n.ours}` : "";
  return `новостей ${n.total}, важных ${n.hot}${tail} · ${head.header}`;
}

/**
 * Слова, по которым новость значит остановленную приёмку. Это худший вид
 * новости для поставки: машина уже в пути, а ворота закрыты.
 */
const HALTED = ["не принимает", "приостанов", "эвакуирова", "закрыт", "ограничен"];

function isHalted(item) {
  const s = (String(item.header || "") + " " + String(item.text || "")).toLowerCase();
  return HALTED.some((w) => s.includes(w));
}

/** Одна строка перечня: заголовок и начало текста, без обрыва посреди слова. */
function newsRow(item, room = 170) {
  const body = String(item.text || "").trim();
  if (!body || room < 40) return `• ${item.header}`;
  if (body.length <= room) return `• ${item.header} — ${body}`;
  let cut = body.slice(0, room);
  const space = cut.lastIndexOf(" ");
  if (space > room * 0.7) cut = cut.slice(0, space);
  return `• ${item.header} — ${cut}…`;
}

/**
 * Разбор часа по новостям площадки: то, что не влезло в строку. Собирается из
 * уже полученного списка — площадка второй раз не опрашивается.
 *
 * Владелец 2026-08-21: до этого дня место выносило на доску счётчики и
 * заголовок первой новости, а остальные — уже прочитанные, разобранные и
 * отсортированные — выбрасывало. Порядок групп по цене ошибки: наши склады,
 * остановленная приёмка, деньги и сроки, фон.
 */
export function wbNewsDetail(n) {
  if (!n || !n.ok || !Array.isArray(n.items) || !n.items.length) return "";
  const seen = new Set();
  const take = (test) => n.items.filter((x) => !seen.has(x) && test(x)).map((x) => { seen.add(x); return x; });

  const ours = take((x) => x.ours);
  const halted = take((x) => isHalted(x));
  const money = take((x) => x.hot);
  const rest = take(() => true);

  const groups = [
    ["Наши склады", ours],
    ["Приёмка встала", halted],
    ["Деньги и сроки", money],
    ["Прочее", rest],
  ].filter(([, rows]) => rows.length);

  // Потолок отметки — 3000 знаков. Резать по нему вслепую значит оборвать
  // новость посреди слова и не сказать об этом. Поэтому сначала ужимается
  // текст новости, и только если и это не помогло — хвост снимается целиком
  // и называется цифрой (§ никакой слой не режется молча).
  const LIMIT = 2900;
  for (const room of [170, 120, 80, 0]) {
    const out = [];
    for (const [title, rows] of groups) {
      out.push(`${title} — ${rows.length}`);
      out.push(...rows.map((x) => newsRow(x, room)));
      out.push("");
    }
    if (n.total > n.items.length) out.push(`Всего в ленте ${n.total}, разобрано ${n.items.length}.`);
    const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length <= LIMIT) return text;
  }

  // Хвост не влез даже голыми заголовками: показываем сколько поместилось.
  const flat = groups.flatMap(([title, rows]) => rows.map((x) => ({ title, x })));
  const out = [];
  let used = 0;
  let last = "";
  let shown = 0;
  for (const { title, x } of flat) {
    const row = newsRow(x, 0);
    const head = title === last ? "" : `${title}\n`;
    if (used + head.length + row.length + 1 > LIMIT) break;
    if (head) out.push(title);
    out.push(row);
    used += head.length + row.length + 1;
    last = title;
    shown += 1;
  }
  out.push("", `Не поместилось в разбор: ${n.items.length - shown} из ${n.items.length}.`);
  return out.join("\n").trim();
}

/** Одна строка для отметки часа по уведомлениям Ozon. */
export function ozonNoticeLine(o) {
  const parts = [];
  const hot = o.actions.filter((a) => a.hot);
  if (hot.length) {
    const h = hot[0];
    parts.push(
      `акций горячих ${hot.length} · ${h.title}` +
        (h.days_left != null ? ` (осталось ${h.days_left} дн)` : "")
    );
  } else if (o.actions.length) {
    parts.push(`акций ${o.actions.length}, срочных нет`);
  }
  if (o.ratings.length) {
    parts.push(`рейтинг просел: ${o.ratings.map((r) => r.name).join(", ")}`);
  }
  return parts.length ? parts.join(" · ") : "уведомлений нет";
}

/** Одна строка акции: срок, участие и сколько товаров можно завести. */
function actionRow(a) {
  const bits = [];
  if (a.days_left != null) bits.push(a.days_left <= 0 ? "заканчивается сегодня" : `осталось ${a.days_left} дн`);
  if (a.participating) bits.push(`мы внутри, товаров ${a.in_count}`);
  else if (a.could_count) bits.push(`не участвуем, можно завести ${a.could_count}`);
  else bits.push("не участвуем");
  return `• ${a.title} — ${bits.join(", ")}`;
}

/**
 * Разбор часа по уведомлениям Ozon. Тот же принцип, что и у новостей WB:
 * площадка уже опрошена, список в руках — на доску идёт весь, а не первая
 * строка (Владелец 2026-08-21).
 */
export function ozonNoticeDetail(o) {
  if (!o) return "";
  const out = [];
  const hot = o.actions.filter((a) => a.hot);
  const calm = o.actions.filter((a) => !a.hot);

  if (hot.length) {
    out.push(`Акции, где решать сейчас — ${hot.length}`);
    out.push(...hot.map(actionRow));
    out.push("");
  }
  if (calm.length) {
    out.push(`Прочие акции — ${calm.length}`);
    out.push(...calm.map(actionRow));
    out.push("");
  }
  if (o.ratings.length) {
    out.push(`Просевшие показатели — ${o.ratings.length}`);
    for (const r of o.ratings) {
      const move = r.was != null && r.was !== r.value ? ` (было ${r.was})` : "";
      out.push(`• ${r.name} — сейчас ${r.value}${move}, группа ${r.group}`);
    }
    out.push("");
  }
  if (o.error) out.push(`Площадка ответила не полностью: ${o.error}`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Свод недели: закрытые семь дней против предыдущих семи. Считается из той же
 * таблицы дневных продаж — отдельного сбора не нужно, значит и лишних вызовов
 * к площадке нет.
 */
export async function weekRollup(env, marketplace) {
  if (!env.ERP_DB) return { ok: false, error: "нет хранилища" };
  try {
    const res = await env.ERP_DB.prepare(
      // Копейки делятся здесь же — см. dayTurnover выше.
      `SELECT date, units_sold, ${sqlRub("revenue_rub", "rub")}
         FROM marketplace_sales_daily
        WHERE marketplace = ?1
        ORDER BY date DESC LIMIT 14`
    ).bind(marketplace).all();
    const rows = (res.results || []).filter((r) => r && r.date);
    if (rows.length < 8) {
      return { ok: false, error: `дней в хранилище ${rows.length} — на две недели не хватает` };
    }
    const sum = (arr, k) => arr.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const now = rows.slice(0, 7);
    const was = rows.slice(7, 14);
    const rev = sum(now, "rub");
    const prevRev = sum(was, "rub");
    const best = [...now].sort((a, b) => (Number(b.rub) || 0) - (Number(a.rub) || 0))[0];
    return {
      ok: true,
      from: now[now.length - 1].date,
      to: now[0].date,
      units: sum(now, "units_sold"),
      revenue: rev,
      prev_revenue: prevRev,
      delta_pct: prevRev ? Math.round(((rev - prevRev) / prevRev) * 100) : null,
      best_day: best ? { date: best.date, revenue: Number(best.rub) || 0 } : null,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 140) };
  }
}

/** Строка недельной клетки. */
export function weekLine(w) {
  if (!w.ok) return null;
  if (!unitPriceSane(w.revenue, w.units)) {
    return unitSanityNote(`неделя ${w.from}–${w.to}`);
  }
  const money = Math.round(w.revenue).toLocaleString("ru-RU");
  const move = w.delta_pct == null ? "" : `, ${w.delta_pct >= 0 ? "+" : ""}${w.delta_pct}% к прошлой`;
  const peak = w.best_day
    ? ` · лучший день ${w.best_day.date}, ${Math.round(w.best_day.revenue).toLocaleString("ru-RU")} ₽`
    : "";
  return `неделя ${w.from}–${w.to}: ${money} ₽, ${w.units} шт${move}${peak}`;
}
