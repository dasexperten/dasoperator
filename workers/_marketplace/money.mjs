/**
 * Одна дверь для денег.
 *
 * В хранилище КАЖДАЯ графа с денежным именем содержит копейки — и та, что
 * названа revenue_rub, и та, что названа amount. Имя графы врёт, и переучить
 * восемнадцать таблиц за один вечер нельзя без риска показать Владельцу новые
 * неправильные числа. Поэтому правда обеспечивается не именем графы, а тем,
 * что деньги физически не могут попасть на страницу мимо этого файла.
 *
 * Закон: рубль на странице — это рубль. Копейка живёт только в хранилище и
 * умирает на этой границе.
 *
 * 2026-08-19. Карточки Арины и Даши напечатали 30 597 200 ₽ вместо 305 972 ₽
 * за 18 августа: общая функция прочитала графу сырой. Числа завышенные ровно
 * в сто раз доска показывала обоим местам, дневным и недельным.
 */

/** Графы хранилища, в которых лежат копейки. Дополнять при появлении новых. */
export const KOPECK_COLUMNS = [
  "revenue_rub", "prev_period_revenue_rub", "current_price_rub", "ad_spend_rub",
  "acquiring_rub", "brand_commission_rub", "cost_per_click_rub", "cost_per_order_rub",
  "expenses_total_rub", "returns_cost_rub", "reviews_cost_rub", "stars_membership_rub",
  "stars_promo_rub", "amount", "total_amount", "line_amount", "gross_amount",
  "retail_amount", "order_amount", "extracted_amount", "commission_amount",
  "services_amount", "dc_amount", "rc_amount", "inbound_amount", "outbound_amount",
  "variance_amount",
];

/** Копейки хранилища → рубли. Единственный разрешённый способ перевода. */
export function rub(kopecks) {
  const v = Number(kopecks);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v) / 100;
}

/** Рубли → строка для человека. Без копеечного хвоста: доска читается глазами. */
export function moneyRu(rubles) {
  const v = Number(rubles);
  if (!Number.isFinite(v)) return "0 ₽";
  return `${Math.round(v).toLocaleString("ru-RU")} ₽`;
}

/** Копейки хранилища → готовая строка. Короткий путь для отметок часа. */
export function moneyFromKopecks(kopecks) {
  return moneyRu(rub(kopecks));
}

/**
 * Кусок SQL, который делит прямо у чтения. Если запрос собран через него,
 * сырая копейка не выйдет из хранилища вообще.
 *   sqlRub("revenue_rub") → round(revenue_rub / 100.0, 0) AS rub
 */
export function sqlRub(column, alias = "rub") {
  return `round(${column} / 100.0, 0) AS ${alias}`;
}

/**
 * Сторож среднего чека. Паста стоит сотни рублей — не десятки тысяч и не
 * копейки. Если рубль на штуку вне коридора, единица измерения где-то потеряна.
 */
export const UNIT_RUB_MIN = 50;
export const UNIT_RUB_MAX = 5000;

export function unitPriceSane(revenueRub, units) {
  const u = Number(units) || 0;
  const r = Number(revenueRub) || 0;
  if (u <= 0) return true;
  const per = r / u;
  return per >= UNIT_RUB_MIN && per <= UNIT_RUB_MAX;
}

/** Одна строка вместо числа, когда числу верить нельзя. */
export function unitSanityNote(what) {
  return `${what}: число не показано — рубль на штуку вне коридора, единица измерения потеряна`;
}
