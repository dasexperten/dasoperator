// Копия organizacia fleet/shared/seat-core.mjs (один сборщик CORE для всех прогонов). Менять обе копии одним днём.
// Постоянный слой поведения места (CORE.md) — Владелец 18.11.2026, поручение Виктору (UGC).
// Слой грузится в каждом прогоне целиком, вместе с VOICE и CHARTER, без отбора JEV и без обрезки.
// Пока status не approved, слой не грузится: правила ещё не согласованы с Владельцем.
// Один сборщик для всех прогонов места: Direct, обход, Threads, Scout, сессия (tools/session-load.mjs).
import { createHash } from "node:crypto";

export const CORE_LIMIT = 15;
const RULE = /^C(\d{2}) \| (.+)$/;

/**
 * @param {string} text содержимое CORE.md
 * @returns {{status: string, approved: string, rules: {id: string, text: string}[], sha: string, errors: string[]}}
 */
export function parseCore(text) {
  const src = String(text || "");
  const sha = createHash("sha256").update(src).digest("hex");
  const status = (src.match(/^status:[ \t]*(\S+)/m)?.[1] || "missing").toLowerCase();
  const approvedRaw = src.match(/^approved:[ \t]*(.*)$/m)?.[1]?.trim() || "";
  const approved = /^[—-]?$/.test(approvedRaw) ? "" : approvedRaw;
  const errors = [];
  const rules = [];
  const seen = new Set();
  const body = src.split(/^## Правила\s*$/m)[1];
  if (body === undefined) errors.push("нет раздела «## Правила»");
  for (const raw of String(body || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("<!--")) continue;
    if (line.startsWith("#")) break;
    const m = line.match(RULE);
    if (!m) { errors.push(`строка не по формату C<NN> | текст: ${line.slice(0, 60)}`); continue; }
    const id = `C${m[1]}`;
    if (seen.has(id)) errors.push(`повтор номера ${id}`);
    seen.add(id);
    rules.push({ id, text: m[2].trim() });
  }
  if (rules.length > CORE_LIMIT) errors.push(`правил ${rules.length}, предел ${CORE_LIMIT}: предложить Владельцу, что объединить или вынести`);
  if (!["draft", "approved"].includes(status)) errors.push(`status ${status}: ждём draft или approved`);
  if (status === "approved" && !approved) errors.push("status approved без строки approved: (дата и слово Владельца)");
  return { status, approved, rules, sha, errors };
}

/** Загружается ли слой: только согласованный Владельцем и без ошибок формата. */
export function coreLive(core) {
  return core.status === "approved" && core.errors.length === 0 && core.rules.length > 0;
}

/** Отметка прогона: что CORE загружен (или почему нет). */
export function coreStamp(core) {
  // Места без CORE.md отметки не получают: слой заведён не у всех.
  if (!core || core.status === "missing") return "";
  if (core.errors.length) return `core: ERROR — not loaded (${core.errors[0]})`;
  if (!coreLive(core)) return "core: draft — not loaded (ждёт согласования Владельца)";
  return `core: loaded ${core.rules.length}/${CORE_LIMIT} sha=${core.sha.slice(0, 8)}`;
}

/** Текст слоя для подсказки модели: целиком, без отбора и обрезки; пусто, если слой не живой. */
export function coreBlock(core, seatName = "") {
  if (!coreLive(core)) return "";
  return [
    `=== CORE — постоянный слой поведения${seatName ? ` · ${seatName}` : ""} (целиком; выше ситуативных правил; противоречие — Владельцу) ===`,
    ...core.rules.map((r) => `${r.id}. ${r.text}`),
  ].join("\n");
}

/**
 * Один вызов для любого прогона: текст CORE.md → блок для подсказки и отметка.
 * @returns {{block: string, stamp: string, core: ReturnType<typeof parseCore>}}
 */
export function assembleCore(text, seatName = "") {
  const core = parseCore(text);
  return { block: coreBlock(core, seatName), stamp: coreStamp(core), core };
}

/**
 * Ночной разбор нарушений: какие правила CORE сверять первыми.
 * Возвращает строки правил в порядке слоя — разбор идёт по ним до ситуативных правил.
 */
export function coreChecklist(core) {
  return coreLive(core) ? core.rules.map((r) => `${r.id} | ${r.text}`) : [];
}
