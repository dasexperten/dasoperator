/**
 * schedule-mark.mjs — отметка часа (Owner 2026-08-18).
 *
 * Час не считается выполненным, пока в журнале нет отметки. До этой правки
 * писать её было НЕЧЕМ: эндпоинта не существовало, и за всё время журнал набрал
 * одну строку, проведённую руками.
 *
 * ТРИ исхода, не два:
 *
 *   проверено — сиденье проснулось, посмотрело, находить было нечего. Это
 *               честный результат, а не провал. На борде золотом.
 *   сделано   — есть что перечислить, и перечисленное обязано стоять в строке.
 *               Пустое «сделано» — ложь в журнале, эндпоинт его отвергает.
 *   ошибка    — час сорвался.
 *
 * Час — это почта И задания, а не только почта. Поэтому исход считается по
 * сумме обоих: пустая почта при сделанном задании — всё равно «сделано».
 */

import { offScheduleLine, pendingOffSchedule, markPickedUp } from "./offschedule-log.mjs";

const DONE_FIELDS = ["sent", "parked", "skipped", "looped", "unread", "failed"];

/**
 * Свести результат часа в исход и строку.
 * @param {{mail?: object, tasks?: object, error?: string}} x
 */
export function verdictForHour(x = {}) {
  if (x.error) return { outcome: "ошибка", line: String(x.error).slice(0, 300), finding: 0 };

  const m = x.mail || {};
  const t = x.tasks || {};
  const done = [];

  // Владелец 2026-08-19: длина массива, а не только счётчик. Смена возвращает
  // sent/parked списками — кому ответила и с какой темой; счётчик под тем же
  // именем приходит только от старых вызовов. Читать надо оба, иначе ответ на
  // письмо не поднимет исход и час ляжет «проверено» при сделанной работе.
  const count = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);
  if (count(m.sent) > 0) done.push(`отправлено ${count(m.sent)}`);
  if (count(m.parked) > 0) done.push(`отложено ${count(m.parked)}`);
  if (count(m.unread) > 0) done.push(`без ответа ${count(m.unread)}`);
  if (count(m.failed) > 0) done.push(`сбоев ${count(m.failed)}`);
  if (Number(t.actions) > 0) done.push(`дел ${t.actions}`);
  // Владелец 2026-08-19: работа между отметками — тоже работа этого часа.
  // Час, в промежутке которого рукой ответили на письмо, не может быть
  // «проверено»: находить было ЧТО, просто нашли не по будильнику.
  if (Number(x.offSchedule) > 0) done.push(`вне расписания ${x.offSchedule}`);
  if (Array.isArray(t.kinds) && t.kinds.length) done.push(`видов ${t.kinds.length}`);

  // skipped и looped — это роботы и петли: сиденье их отбросило, работой они не
  // являются и «сделано» не дают.
  if (!done.length) {
    const seen = DONE_FIELDS.filter((k) => count(m[k]) > 0).length;
    return {
      outcome: "проверено",
      line: seen ? "почта и задания просмотрены, отвечать было нечего" : "почта и задания пусты",
      finding: 0,
    };
  }
  return { outcome: "сделано", line: done.join(", "), finding: x.finding ? 1 : 0 };
}

/**
 * Поставить отметку на борде. Молча не падает: сорванная отметка не должна
 * ронять сам час, но и тихо теряться не должна — возвращает причину.
 */
export async function markHour(env, { slug, hour, minute, mail, tasks, error, finding, cache, line, detail, offSchedule } = {}) {
  const board = env.BOARD;
  if (!board) return { ok: false, error: "no_board_binding" };
  // Владелец 2026-08-19: крон пишет ПРОМЕЖУТОК, а не миг. Работа, сделанная
  // между отметками рукой или по команде из телеграма, входит в исход этого
  // часа: час с отвеченным вручную письмом — «сделано», а не «проверено».
  // Отрезок забирается ЗДЕСЬ, а не в каждом из двадцати мест: место не должно
  // помнить про журнал, чтобы подобрать его работу. Забыть в одном месте —
  // значит потерять его ручную работу навсегда и не узнать об этом.
  const off = Array.isArray(offSchedule)
    ? offSchedule
    : await pendingOffSchedule(env, slug).catch(() => []);
  const v = verdictForHour({ mail, tasks, error, finding, offSchedule: off.length });
  // Владелец 2026-08-19: когда час — это названная работа, а не общая почтовая
  // смена, строку пишет сама работа. Служебное «дел 6, видов 1» ничего не
  // говорит Владельцу; «акций горячих 6 · Распродажа стока, осталось 1 дн» —
  // говорит. Свод считается по-прежнему, но подписью идёт человеческая строка.
  if (String(line || "").trim()) v.line = String(line).trim().slice(0, 400);
  // Строка отрезка идёт ПОСЛЕ строки часа: сначала что сделал сам час, потом
  // что подобрано из промежутка. Владельцу видно и то и другое.
  if (off.length) {
    const tail = offScheduleLine(off);
    if (tail) v.line = [v.line, tail].filter(Boolean).join(" · ").slice(0, 400);
  }
  try {
    const res = // Владелец 2026-08-19: запись живёт ТОЛЬКО под /api. Без этой приставки
    // борд отдаёт страницу с кодом 200, отметка отвечает «ок» — и клетка стоит
    // пустой при сделанной работе. Молчаливая ложь худшего сорта.
    await board.fetch("https://board/api/schedule/mark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_slug: slug,
        hour_utc: Number.isInteger(hour) ? hour : new Date().getUTCHours(),
        // Владелец 2026-08-19: минуту клетки знает доска, не место. Если
        // работа названа своей клеткой — шлём её; молчание значит «посади
        // сама», и доска возьмёт минуту из строки расписания.
        minute_utc: Number.isInteger(minute) ? minute : null,
        // Владелец 2026-08-20: в клетке короткая сводка, в окне полный разбор.
        // До этого окно показывало ТУ ЖЕ строку — подробностей не было вовсе,
        // и клик ничего не добавлял.
        detail: String(detail || "") || null,
        outcome: v.outcome,
        line: v.line,
        finding: v.finding,
        // Owner 2026-08-18: попадание кэша за прогон. DeepSeek возвращает его в
        // каждом ответе; отметка — единственное место, куда числа записываются.
        prompt_tokens: cache ? Number(cache.prompt) || 0 : null,
        cache_hit: cache ? Number(cache.hit) || 0 : null,
      }),
    });
    if (!res.ok) return { ok: false, error: `board ${res.status}`, ...v };
    // Код 200 сам по себе ничего не доказывает: страница борда тоже 200.
    // Настоящее подтверждение — JSON с ok от самой записи.
    const body = await res.json().catch(() => null);
    if (!body || body.ok !== true) {
      return { ok: false, error: `борд не подтвердил запись: ${JSON.stringify(body).slice(0, 120)}`, ...v };
    }
    // Помечаем подобранным только теперь, когда доска подтвердила запись.
    // Пометить раньше — значит стереть работу молча при сбое доставки.
    if (off.length) {
      await markPickedUp(env, off.map((r) => r.id)).catch(() => {});
    }
    return { ok: true, ...v, off_schedule: off.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 140), ...v };
  }
}

/**
 * Отметка недельной клетки (Владелец 2026-08-19). Неделя живёт своей таблицей:
 * ключ там агент × день недели × час, минуты нет.
 */
export async function markWeek(env, { slug, dow, hour, outcome, line } = {}) {
  const board = env.BOARD;
  if (!board) return { ok: false, error: "no_board_binding" };
  const d = new Date();
  try {
    const res = await board.fetch("https://board/api/schedule/weekly/mark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_slug: slug,
        dow: Number.isInteger(dow) ? dow : d.getUTCDay(),
        hour_utc: Number.isInteger(hour) ? hour : d.getUTCHours(),
        outcome: outcome || "проверено",
        line: String(line || "").slice(0, 400),
      }),
    });
    if (!res.ok) return { ok: false, error: `board ${res.status}` };
    const body = await res.json().catch(() => null);
    if (!body || body.ok !== true) {
      return { ok: false, error: `борд не подтвердил запись: ${JSON.stringify(body).slice(0, 120)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 140) };
  }
}
