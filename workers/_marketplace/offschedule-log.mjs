/**
 * offschedule-log.mjs — журнал работы, сделанной вне расписания.
 *
 * Владелец 2026-08-19, замысел целиком:
 *
 *   Внерасписная работа НЕ пишет на доску сама. Клетка расписания принадлежит
 *   своему слоту, и запуск, пришедший в чужой час, показал бы выполненным то,
 *   что ещё не наступало.
 *
 *   Но и пропасть она не должна. Её подбирает СЛЕДУЮЩИЙ крон: отметка часа
 *   смотрит не на одно мгновение, а на весь отрезок с прошлой отметки — и если
 *   в промежутке рукой ответили на письмо, получили ответ, что-то узнали, всё
 *   это входит в её строку как «сделано».
 *
 *   Доску всегда пишет крон. Но пишет он промежуток, а не миг.
 *
 * До этого журнала подобрать было нечего: ручная почтовая смена возвращала
 * числа, и они испарялись вместе с ответом HTTP.
 *
 * Эта часть — только запись. Подбор отрезка кроном идёт следующей частью.
 */

/** Создаёт таблицу, если её ещё нет. Дешевле одной проверки на запуск. */
export async function ensureOffScheduleTable(env) {
  const db = env?.DB || env?.ORG_DB;
  if (!db) return false;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS org_offschedule_log (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       agent_slug TEXT NOT NULL,
       done_at    TEXT NOT NULL DEFAULT (datetime('now')),
       source     TEXT NOT NULL,
       kind       TEXT NOT NULL,
       line       TEXT NOT NULL,
       detail     TEXT,
       picked_up  INTEGER NOT NULL DEFAULT 0
     )`,
  ).run();
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS ix_offsched_pickup
       ON org_offschedule_log (agent_slug, picked_up, done_at)`,
  ).run();
  return true;
}

/** Откуда пришла работа. Не косметика: Владелец должен видеть, кто её поднял. */
export const SOURCE = {
  telegram: "телеграм",     // задание Владельца вне расписания
  manual: "вручную",        // /mail/shift, /run поднятые рукой
  other_seat: "другое место", // разбудило соседнее место
  poll: "опрос почты",      // полчаса между часами — ящик прочитан и отвечен (§6.0i)
};

/**
 * Записывает одно событие. Пишется ЧЕЛОВЕЧЕСКОЙ строкой — её через час
 * дословно возьмёт крон и покажет Владельцу на доске. Служебный счёт вида
 * «дел 3» здесь бесполезен: он ничего не скажет ни ему, ни следующей отметке.
 */
export async function logOffSchedule(env, { slug, source, kind, line, detail } = {}) {
  const db = env?.DB || env?.ORG_DB;
  if (!db) return { ok: false, error: "нет базы" };
  const s = String(slug || "").trim();
  const text = String(line || "").trim();
  if (!s || !text) return { ok: false, error: "нужны место и строка" };
  try {
    await ensureOffScheduleTable(env);
    await db.prepare(
      `INSERT INTO org_offschedule_log (agent_slug, source, kind, line, detail)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(
      s,
      String(source || SOURCE.manual).slice(0, 40),
      String(kind || "работа").slice(0, 60),
      text.slice(0, 400),
      detail ? String(detail) : null,
    ).run();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 140) };
  }
}

/**
 * Что накопилось у места и ещё не попало ни в одну отметку. Отдаётся
 * следующему крону — он и напишет это на доску.
 */
export async function pendingOffSchedule(env, slug, { limit = 20 } = {}) {
  const db = env?.DB || env?.ORG_DB;
  if (!db) return [];
  try {
    const r = await db.prepare(
      `SELECT id, done_at, source, kind, line
         FROM org_offschedule_log
        WHERE agent_slug = ?1 AND picked_up = 0
        ORDER BY done_at
        LIMIT ?2`,
    ).bind(String(slug || ""), Math.max(1, Math.min(50, limit))).all();
    return r.results || [];
  } catch {
    return [];
  }
}

/**
 * Помечает подобранное. Отдельным шагом, а не внутри чтения: пометить до того,
 * как отметка реально легла на доску, значит потерять работу молча — ровно та
 * ошибка, которую мы сегодня уже ловили с молчаливым «ок».
 */
export async function markPickedUp(env, ids = []) {
  const db = env?.DB || env?.ORG_DB;
  if (!db || !ids.length) return { ok: true, changed: 0 };
  const list = ids.map((n) => Number(n)).filter(Number.isInteger);
  if (!list.length) return { ok: true, changed: 0 };
  try {
    const holes = list.map((_, i) => `?${i + 1}`).join(",");
    const res = await db.prepare(
      `UPDATE org_offschedule_log SET picked_up = 1 WHERE id IN (${holes})`,
    ).bind(...list).run();
    return { ok: true, changed: res?.meta?.changes || 0 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 140) };
  }
}

/** Строка для отметки часа: что было сделано в промежутке, словами. */
export function offScheduleLine(rows = []) {
  if (!rows.length) return "";
  const by = new Map();
  for (const r of rows) {
    const k = String(r.source || "");
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(String(r.line || "").trim());
  }
  const parts = [];
  for (const [src, lines] of by) {
    parts.push(`${src}: ${lines.join("; ")}`);
  }
  return `вне расписания — ${parts.join(" · ")}`.slice(0, 400);
}
