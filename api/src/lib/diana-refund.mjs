// Owner 2026-11-18 / 19.11 (dasha_vous, 01:03): «на какой номер вернуть деньги?» gets the number at once,
// never «передадим владельцу». Whether a blogger returns money is still the Owner's decision;
// the number itself is fixed and not a decision. A rule with no judgement left: craft, no model call.
export const REFUND_ANSWER = 'Вот номер для возврата: Т-Банк, +7 930 955-40-25';
const RETURN = /(?:^|[^а-яё])(?:верн|возвра|вернуть|возврат)/i;
const WHERE = /номер|куда|реквизит|карт[уаы]|сч[её]т|телефон|банк/i;
/** She asks where or to which number to send money back. */
export function asksRefundNumber(text) {
  const t = String(text ?? '');
  return RETURN.test(t) && WHERE.test(t);
}
