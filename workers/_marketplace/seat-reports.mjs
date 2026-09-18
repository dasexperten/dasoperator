// Seat reports moved to dasoperator on 2026-09-18 (Owner: model-free timers live here).
// Copied verbatim from organizacia fleet/dasha-ozon and fleet/arina-wb index.js at 1e4cfb0.
// They read the marketplace, write the seat's cell on the board (BOARD binding) and
// pick up the seat's off-schedule notes (env.DB = the board database).
import { dayTurnover, ozonNoticeDetail, ozonNoticeLine, ozonNotices, turnoverLine, wbNews, wbNewsDetail, wbNewsLine, weekLine, weekRollup } from "./marketplace-watch.mjs";
import { markHour, markWeek } from "./schedule-mark.mjs";
import { runRyazanWatch } from "./wb-ryazan-watch.mjs";

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
  const n = await wbNews(env, { daysBack });
  const line = wbNewsLine(n);
  // Владелец 2026-08-21: в клетку идёт строка, в окно — разбор всей ленты.
  // Собран из уже полученного списка, площадка второй раз не дёргается.
  const detail = wbNewsDetail(n);
  console.log("[arina-wb:news] " + JSON.stringify({ total: n.total, hot: n.hot, ours: n.ours, error: n.error }));
  const worth = (n.hot || 0) + (n.ours || 0);
  const mark = await markHour(env, {
    slug: "arina-volkova",
    hour: cell.hour,
    outcome: n.ok ? (worth ? "сделано" : "проверено") : "ошибка",
    mail: {},
    tasks: worth ? { actions: worth, kinds: ["новости площадки"] } : {},
    error: n.ok ? undefined : n.error,
    line,
    detail,
    finding: (n.ours || 0) > 0,
  }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
  return { ...n, line, detail, mark };
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
export async function runRyazanCheck(env) {
  const r = await runRyazanWatch(env);
  return r;
}
