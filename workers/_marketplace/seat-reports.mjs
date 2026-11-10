// Seat reports moved to dasoperator on 2026-09-18 (Owner: model-free timers live here).
// Copied verbatim from organizacia fleet/dasha-ozon and fleet/arina-wb index.js at 1e4cfb0.
// They read the marketplace, write the seat's cell on the board (BOARD binding) and
// pick up the seat's off-schedule notes (env.DB = the board database).
import { dayTurnover, ozonNoticeDetail, ozonNoticeLine, ozonNotices, turnoverLine, wbNews, wbNewsDetail, wbNewsLine, weekLine, weekRollup } from "./marketplace-watch.mjs";
import { markHour, markWeek } from "./schedule-mark.mjs";

export async function runOzonDayTurnover(env) {
  const t = await dayTurnover(env, "ozon");
  const line = turnoverLine(t);
  console.log("[dasha-ozon:turnover] " + JSON.stringify(t));
  const mark = await markHour(env, {
    slug: "dasha-kozlovskaya",
    // Владелец 2026-08-21: минуту клетки знает доска. Место шлёт только час,
    // и отметка садится ровно в свою клетку — минута берётся из строки
    // расписания. Прибитая здесь минута расходилась с доской и вешала отметку
    // рядом с клеткой.
    hour: 20,
    outcome: t.ok ? "сделано" : "ошибка",
    mail: {},
    tasks: t.ok ? { actions: 1, kinds: ["оборот дня"] } : {},
    error: t.ok ? undefined : t.error,
    line,
  }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
  return { ...t, line, mark };
}
export async function runOzonNotices(env, cell = { hour: 4 }) {
  const o = await ozonNotices(env);
  const line = ozonNoticeLine(o);
  // Владелец 2026-08-21: разбор часа — все акции и просевшие показатели,
  // а не первая строка. Площадка уже опрошена, лишних вызовов нет.
  const detail = ozonNoticeDetail(o);
  console.log("[dasha-ozon:notices] " + JSON.stringify({ actions: o.actions.length, ratings: o.ratings.length, error: o.error }));
  const hot = o.actions.filter((a) => a.hot).length + o.ratings.length;
  const mark = await markHour(env, {
    slug: "dasha-kozlovskaya",
    hour: cell.hour,
    outcome: o.ok ? (hot ? "сделано" : "проверено") : "ошибка",
    mail: {},
    tasks: hot ? { actions: hot, kinds: ["уведомления площадки"] } : {},
    error: o.ok ? undefined : o.error,
    line,
    detail,
    finding: hot > 0,
  }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
  return { ...o, line, detail, mark };
}
export async function runOzonWeek(env) {
  const w = await weekRollup(env, "ozon");
  const line = weekLine(w);
  console.log("[dasha-kozlovskaya:week] " + JSON.stringify(w));
  const mark = await markWeek(env, {
    slug: "dasha-kozlovskaya",
    dow: 1,
    hour: 20,
    outcome: w.ok ? "сделано" : "ошибка",
    line: line || w.error,
  }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
  return { ...w, line, mark };
}
export async function runWbDayTurnover(env) {
  const t = await dayTurnover(env, "wb");
  const line = turnoverLine(t);
  console.log("[arina-wb:turnover] " + JSON.stringify(t));
  const mark = await markHour(env, {
    slug: "arina-volkova",
    // Владелец 2026-08-21: минуту клетки знает доска. Место шлёт только час,
    // и отметка садится ровно в свою клетку — минута берётся из строки
    // расписания. Прибитая здесь минута расходилась с доской и вешала отметку
    // рядом с клеткой.
    hour: 20,
    outcome: t.ok ? "сделано" : "ошибка",
    mail: {},
    tasks: t.ok ? { actions: 1, kinds: ["оборот дня"] } : {},
    error: t.ok ? undefined : t.error,
    line,
  }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
  return { ...t, line, mark };
}
export async function runWbNews(env, daysBack = 1, cell = { hour: 4 }) {
  const n = await wbNews(env, { daysBack, limit: Infinity });
  let review = null;
  let error = n.ok ? null : n.error;
  if (!error) {
    try {
      if (!env.ARINA_NEWS) throw new Error("Arina news review binding missing");
      const response = await env.ARINA_NEWS.fetch("https://arina-internal/news-review", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ total: n.total, items: n.items }),
      });
      review = await response.json();
      if (!response.ok || !review.ok || review.reviewed !== n.total) throw new Error(review?.error || "incomplete Arina news review");
    } catch (e) { error = `Арина не разобрала новости: ${String(e?.message || e)}`; }
  }
  const selected = review?.decisions?.filter(x => x.status === "new_knowledge") || [];
  const relevant = review?.decisions?.filter(x => x.status === "new_knowledge" || x.status === "relevant_known") || [];
  const line = error || `Новости WB: прочитано ${review.reviewed}, важных ${relevant.length}, новых знаний ${selected.length} · DeepSeek`;
  const findings = relevant.map(x => `${x.title}: ${x.summary}`).join("\n\n") || "Важных новых сообщений нет.";
  const feed = wbNewsDetail(n);
  const fullDetail = `${findings}\n\nЛента WB:\n${feed}`;
  const detail = error ? feed : fullDetail.length <= 2900 ? fullDetail :
    `${findings.slice(0, 2700)}\n\nПолная лента не поместилась в отметку; Арина рассмотрела все ${n.total} новостей.`;
  const mark = await markHour(env, {
    slug: "arina-volkova", hour: cell.hour, mail: {},
    tasks: !error && relevant.length ? { actions: relevant.length, kinds: ["новости площадки"] } : {},
    error: error || undefined, line, detail, finding: relevant.length > 0,
  }).catch(e => ({ ok: false, error: String(e?.message || e) }));
  if (!mark.ok && !error) error = `Отметка не сохранена: ${mark.error}`;
  return { ...n, ok: !error, error, review, line, detail, mark };
}
export async function runWbWeek(env) {
  const w = await weekRollup(env, "wb");
  const line = weekLine(w);
  console.log("[arina-volkova:week] " + JSON.stringify(w));
  const mark = await markWeek(env, {
    slug: "arina-volkova",
    dow: 1,
    hour: 20,
    outcome: w.ok ? "сделано" : "ошибка",
    line: line || w.error,
  }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
  return { ...w, line, mark };
}
