// UGC payout → Konsol fps payment. Pure orchestration: the D1 store, the Konsol
// client and the Telegram sender are passed in, so the money rules are tested
// without a network or a database (ugc-payout-execute.test.mjs).
//
// Owner 2026-10-14 («запускай выплаты через API»):
//   - auto-approve within 999 ₽ per creator per day and 10 000 ₽ for all per day;
//   - own RUB = balance − 1 905 000 ₽; pay only if own RUB ≥ amount + 30 ₽;
//     otherwise stop and tell the Owner — the overdraft is never touched;
//   - one Konsol payment per ugc_payouts row, ever.
//
// Idempotency: a row that already has konsol_payment_id returns it. A row is
// claimed (execute_claim) before Konsol is called; a definite Konsol refusal
// releases the claim, an unclear answer (network, 5xx) keeps it, so the row
// cannot be paid twice by a blind retry — a person checks Konsol first.

import {
  checkDailyLimit, checkOwnRub, formatRub, isFpsBankMemberId,
  konsolPhone, KONSOL_SERVICE_TITLE, mapKonsolStatus, maskPhoneWide, payoutDate,
  UGC_PAYOUT_MAX_MINOR,
} from './ugc-payouts.mjs';

const EXECUTABLE = new Set(['awaiting_approval', 'approved']);

function result(http, body) {
  return { http, ...body };
}

function who(row) {
  return row.handle || row.creator_handle || row.creator_id || row.id;
}

/** Text the Owner reads when own RUB stops a payout. Never the overdraft figure. */
export function ownRubStopText(check, row) {
  if (check.code === 'own_rub_low') {
    return `Свой рублёвый счёт Консоли кончился: ${formatRub(check.own_minor)}, нужно пополнить. Выплата ${who(row)} ${formatRub(row.amount_minor)} не ушла.`;
  }
  return `Свой рублёвый счёт Консоли не сходится, выплаты остановлены. Выплата ${who(row)} ${formatRub(row.amount_minor)} не ушла. Проверь лимит овердрафта.`;
}

/** Diana to the blogger the moment the payout turns green (Owner 2026-10-16). Mid-dialogue: no greeting. */
export function bloggerPaidText(row) {
  // An old debt pays for a reel already made (Owner 2026-10-16, madifood_: «Я уже
  // отчиталась по вашей пасте»): thank her, never ask for a new order.
  if (/долг|повтор/i.test(String(row.note ?? ''))) return `Перевела ${formatRub(row.amount_minor)} по СБП. Это за ваш ролик и отзыв, спасибо вам!`;
  // Owner 2026-10-16: «Мы вам оплатили… И после этого мост перекидываешь сразу про сценарий».
  // Owner 2026-10-17 («сделай это… голос Дианы»): paid notice in Diana's voice, short messages
  // split on a blank line, no dashes; own idea first, cards second.
  return [
    `Перевела ${formatRub(row.amount_minor)} по СБП. Проверьте, пожалуйста, должно быть уже дошло.`,
    'Оформите, пожалуйста, заказ и пришлите скрин.',
    'А пока можно подумать о ролике. Если у вас есть своя идея, расскажите.',
    'Если нет, выберите карточку и пришлите номер от 1 до 4.',
  ].join('\n\n');
}

export function paidNoticeText(row) {
  return `Деньги пришли: ${who(row)}, ${formatRub(row.amount_minor)} по СБП. Пишу блогеру: «Деньги пришли 👍 Заказывайте и пришлите скрин».`;
}

async function findOrCreateContractor(konsol, requisites, phone) {
  const found = await konsol.findContractorByPhone(phone);
  if (found.error) return { error: found.error, definitive: true };
  if (found.id) return { id: found.id, created: false };
  const body = { kind: 'individual', first_name: requisites.first_name, last_name: requisites.last_name, phone };
  if (requisites.patronymic) body.patronymic = requisites.patronymic;
  const made = await konsol.createContractor(body);
  if (made.ok && made.body && made.body.id) return { id: made.body.id, created: true };
  return { error: `contractor: ${made.error || `HTTP ${made.status}`}`, definitive: true };
}

/**
 * deps: { store, konsol, notifyOwner(text) → bool, now (ms), claimToken }
 * Returns { http, ok, code?, message?, payout? , already? }.
 */
export async function executePayout(id, deps) {
  const { store, konsol, notifyOwner } = deps;
  const now = deps.now ?? Date.now();
  const row = await store.getPayout(id);
  if (!row) return result(404, { ok: false, code: 'not_found', message: 'Payout not found' });
  if (row.konsol_payment_id) {
    return result(200, { ok: true, already: true, payout: { id: row.id, status: row.status, konsol_payment_id: row.konsol_payment_id, konsol_contractor_id: row.konsol_contractor_id } });
  }
  if (row.execute_claim) return result(409, { ok: false, code: 'execute_unclear', message: 'An earlier send has no clear answer from Konsol. Check Konsol before anything else; do not retry.', payout: { id: row.id, status: row.status } });
  if (!EXECUTABLE.has(row.status)) return result(409, { ok: false, code: 'not_executable', message: `Payout is ${row.status}`, payout: { id: row.id, status: row.status } });
  // Owner 2026-10-16: one ready queue; a recorded date never schedules or delays payment.
  const today = payoutDate(null, now);
  // Owner 2026-10-15: one blogger is not paid twice a day. A second payout the
  // same day goes only when it was explicitly approved (and fits the 999 ₽ cap).
  if (row.status !== 'approved' && (await store.handedToday(row.creator_id, today, row.id)) > 0) {
    return result(409, { ok: false, code: 'already_paid_today', message: 'This blogger already has a payout handed to Konsol today' });
  }

  const amount = Number(row.amount_minor);
  if (!(Number.isInteger(amount) && amount > 0 && amount <= UGC_PAYOUT_MAX_MINOR)) return result(422, { ok: false, code: 'invalid_amount', message: 'Amount outside 0–999 ₽' });

  // The money leaves today, so today's limits apply whatever date the row was made.
  const day = payoutDate(null, now);
  const daily = checkDailyLimit(await store.sameDayMinor(row.creator_id, day, row.id), amount);
  if (!daily.ok) return result(422, { ok: false, code: daily.code, message: daily.message });
  // Owner 2026-10-16: «убираешь лимит на 10 тысяч, вообще убираешь» — no day total for all bloggers.

  const requisites = await store.getRequisites(row.id);
  const phone = konsolPhone(requisites?.fps_mobile_phone);
  const bankId = row.fps_bank_member_id;
  if (!phone) return result(422, { ok: false, code: 'phone_required', message: 'SBP phone missing — PUT /payouts/:id/requisites' });
  if (!isFpsBankMemberId(bankId)) return result(422, { ok: false, code: 'bank_required', message: 'SBP bank id (12 digits) missing — PUT /payouts/:id/requisites' });
  if (!requisites.first_name || !requisites.last_name) return result(422, { ok: false, code: 'name_required', message: 'Konsol needs first_name and last_name of the recipient' });

  const bank = await konsol.bankMember(bankId);
  if (bank.error) return result(502, { ok: false, code: 'konsol_unreachable', message: bank.error });
  if (!bank.found) return result(422, { ok: false, code: 'bank_unknown', message: `Bank ${bankId} is not in Konsol's SBP list` });

  const accounts = await konsol.companyAccounts();
  if (!accounts.ok) return result(502, { ok: false, code: 'konsol_unreachable', message: accounts.error || `HTTP ${accounts.status}` });
  const own = checkOwnRub(accounts.body, amount, now);
  if (!own.ok) {
    await notifyOwner(ownRubStopText(own, row));
    return result(409, { ok: false, code: own.code, message: own.code === 'own_rub_low' ? `Own RUB ${formatRub(own.own_minor)} < amount + 30 ₽` : own.reason });
  }

  const claimed = await store.claim(row.id, deps.claimToken, new Date(now).toISOString());
  if (!claimed) {
    const again = await store.getPayout(row.id);
    if (again?.konsol_payment_id) return result(200, { ok: true, already: true, payout: { id: again.id, status: again.status, konsol_payment_id: again.konsol_payment_id, konsol_contractor_id: again.konsol_contractor_id } });
    // A competing payout can consume today's budget between the first check and the atomic claim.
    const dailyNow = checkDailyLimit(await store.sameDayMinor(row.creator_id, day, row.id), amount);
    if (!dailyNow.ok) return result(422, { ok: false, code: dailyNow.code, message: dailyNow.message });
    return result(409, { ok: false, code: 'execute_in_progress', message: 'Another send of this payout or creator is running' });
  }

  const contractor = await findOrCreateContractor(konsol, requisites, phone);
  if (contractor.error) {
    await store.release(row.id, contractor.error);
    return result(502, { ok: false, code: 'konsol_contractor', message: contractor.error });
  }
  await store.setContractor(row.id, contractor.id);

  const rub = amount / 100;
  const payment = await konsol.createPayment({
    contractor_id: contractor.id,
    amount: rub,
    // Konsol 2026-10-15 live 422: SBP details go in bank_details_kind + bank_details, not top-level fields.
    bank_details_kind: 'fps',
    bank_details: { fps_mobile_phone: phone, fps_bank_member_id: bankId },
    services_list: [{ title: KONSOL_SERVICE_TITLE, amount: rub }],
  });
  if (payment.ok && payment.body && payment.body.id) {
    const sentAt = new Date(now).toISOString();
    await store.markSent(row.id, { paymentId: payment.body.id, contractorId: contractor.id, konsolStatus: payment.body.status ?? null, sentAt, day, phoneMasked: maskPhoneWide(phone), bankRef: bank.name ?? null });
    return result(201, { ok: true, payout: { id: row.id, status: 'sent', konsol_payment_id: payment.body.id, konsol_contractor_id: contractor.id, konsol_status: payment.body.status ?? null, sent_at: sentAt } });
  }
  if (payment.status >= 400 && payment.status < 500) {
    await store.release(row.id, `payment refused: ${payment.error || `HTTP ${payment.status}`}`);
    return result(502, { ok: false, code: 'konsol_refused', message: payment.error || `HTTP ${payment.status}` });
  }
  await store.holdUnclear(row.id, `payment unclear: ${payment.error || `HTTP ${payment.status}`}`);
  return result(502, { ok: false, code: 'konsol_unclear', message: 'Konsol gave no clear answer. The payout stays locked; check Konsol before anything else.' });
}

/**
 * Applies a payment as Konsol reports it (callback re-fetch or poll). The body
 * of a callback is never trusted: `payment` is what GET /payments/:id returned.
 * deps: { store, notifyOwner, now }
 */
export async function applyKonsolPayment(row, payment, deps) {
  const { store, notifyOwner } = deps;
  const now = deps.now ?? Date.now();
  if (!row || !payment || payment.id !== row.konsol_payment_id) return { changed: false, reason: 'payment does not belong to this payout' };
  const target = mapKonsolStatus(payment.status);
  let changed = false;
  if (target === 'paid' && row.status !== 'paid') {
    await store.markPaid(row.id, { paidAt: payment.paid_at || new Date(now).toISOString(), konsolStatus: payment.status });
    changed = true;
  } else if (target === 'failed' && row.status !== 'failed' && row.status !== 'paid') {
    await store.markFailed(row.id, { failedAt: new Date(now).toISOString(), konsolStatus: payment.status, error: payment.error_message || 'Konsol: failed' });
    changed = true;
  } else if (row.konsol_status !== payment.status) {
    await store.setKonsolStatus(row.id, payment.status);
  }
  // Owner 2026-10-16: no Telegram message per payment — he checks Instagram himself.
  // Green is Diana's trigger («как только оплата сделана… сразу написала им»): one
  // Instagram message to the blogger, once per payout (paid_notice_at is the lock).
  let noticed = false;
  if (changed && target === 'paid' && deps.notifyBlogger) {
    if (await store.claimNotice(row.id, new Date(now).toISOString())) {
      const sent = await deps.notifyBlogger(row, bloggerPaidText(row));
      if (sent && sent.ok) noticed = true;
      else await store.releaseNotice(row.id);
    }
  }
  return { changed, status: target === 'sent' ? row.status : target, konsol_status: payment.status, noticed };
}

// ---------------------------------------------------------------------------
// Registry payouts of 14.10 (Owner 2026-10-15, «Да, выкладывай»): two payouts
// went through Konsol by the chat registry, before the API flow, so their ERP
// rows carry no Konsol id. They are linked by Konsol GET only — never a POST.
// Exactly one executed Konsol payment of the same amount, made on the payout
// day or the day after (Yerevan), not linked to any other row. Anything else
// leaves the row as it is.
// ---------------------------------------------------------------------------

export const REGISTRY_LINK_IDS = ['ugcpay_20261014_yasmin_i_b', 'ugcpay_20261014_mis_alina_010'];

function yerevanDayOf(value) {
  const at = Date.parse(String(value ?? ''));
  return Number.isNaN(at) ? null : new Date(at + 4 * 3600_000).toISOString().slice(0, 10);
}

function nextDay(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 3600_000).toISOString().slice(0, 10);
}

/** → { payment } when exactly one Konsol payment fits, else { reason }. */
export function matchRegistryPayment(row, payments, linkedIds = new Set()) {
  const days = new Set([row.payout_date, nextDay(row.payout_date)]);
  const fits = (payments ?? []).filter((p) => p && p.status === 'executed'
    && Math.round(Number(p.amount) * 100) === Number(row.amount_minor)
    && !linkedIds.has(String(p.id))
    && [p.paid_at, p.created_at].some((v) => days.has(yerevanDayOf(v))));
  if (fits.length === 1) return { payment: fits[0] };
  return { reason: fits.length ? `ambiguous: ${fits.length} executed payments fit` : 'no executed payment fits' };
}
