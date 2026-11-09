// Save-only amount review. No provider, approval or payment call belongs here.
const PENDING = new Set(['awaiting_approval', 'approved']);
const SNAPSHOT = /^[a-f0-9]{64}$/;

export function parseReviewAmount(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,3}(?:[.,]\d{1,2})?$/.test(text)) {
    return { error: 'Введите сумму в рублях, не больше двух знаков после запятой.' };
  }
  const [rub, kopecks = ''] = text.replace(',', '.').split('.');
  // Integer arithmetic only: never round or strip unexpected characters.
  const amount_minor = Number(rub) * 100 + Number(kopecks.padEnd(2, '0'));
  if (amount_minor < 5000 || amount_minor > 99900) return { error: 'Допустимая сумма: от 50 до 999 ₽.' };
  return { amount_minor };
}

export function reviewAmountInput(minor) {
  return Number.isSafeInteger(minor) ? `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}` : '';
}

function sameRow(row, id, creatorId) {
  return row?.id === id && row?.creator_id === creatorId;
}

function validReview(row, id, creatorId) {
  return sameRow(row, id, creatorId) && Number.isSafeInteger(row.amount_minor)
    && typeof row.payout_hold === 'boolean' && typeof row.can_edit === 'boolean'
    && typeof row.review_snapshot === 'string' && SNAPSHOT.test(row.review_snapshot);
}

export function matchesReviewReceipt(row, request, id) {
  const saved = row?.saved_request;
  return Boolean(request && sameRow(row, id, request.creator_id) && row.payout_hold === true
    && PENDING.has(row.status) && row.amount_minor === request.amount_minor && saved?.request_id === request.request_id
    && saved?.expected_snapshot === request.expected_snapshot && saved?.amount_minor === request.amount_minor);
}

// A session survives modal dismissal in memory, so retrying a lost response uses
// the same request and snapshot. No financial data is written to browser storage.
export function createAmountReviewSession({ id, creatorId, read, save, requestId, onSaved = () => {} }) {
  let state = { phase: 'loading', review: null, request: null, error: '' };
  let working = false;
  const listeners = new Set();
  const publish = (patch) => { state = { ...state, ...patch }; for (const listener of listeners) listener(state); };
  const saved = (row) => { publish({ phase: 'saved', review: row, error: '' }); onSaved(row); };

  async function check() {
    publish({ phase: state.request ? 'checking' : 'loading', error: '' });
    try {
      const response = await read(id, state.request?.request_id);
      const row = response?.result;
      if (!response?.success || !validReview(row, id, creatorId)) {
        publish({ phase: 'error', error: 'Не удалось проверить эту выплату. Обновите данные и повторите проверку.' });
        return;
      }
      publish({ review: row });
      if (state.request) {
        if (matchesReviewReceipt(row, state.request, id)) { saved(row); return; }
        if (row.can_edit && row.amount_minor === 1 && PENDING.has(row.status) && row.review_snapshot === state.request.expected_snapshot) {
          publish({ phase: 'retry', error: 'Сохранение не подтверждено. Можно повторить тот же запрос. Оплата не запускается.' });
        } else {
          publish({ phase: 'blocked', error: 'Выплата изменилась. Сохранение этого запроса не подтверждено. Проверьте запись; повторная запись заблокирована.' });
        }
      } else if (row.can_edit && row.amount_minor === 1 && PENDING.has(row.status)) {
        publish({ phase: 'ready', error: '' });
      } else {
        publish({ phase: 'blocked', error: 'Сумму этой выплаты сейчас нельзя изменить. Обновите список и проверьте запись.' });
      }
    } catch {
      publish({ phase: 'error', error: state.request
        ? 'Нет подтверждения сохранения. Проверьте состояние этой выплаты. Не повторяйте действие в другой записи.'
        : 'Нет связи с сервером. Повторите проверку выплаты.' });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async open() {
      if (working) return;
      working = true;
      try { await check(); } finally { working = false; }
    },
    async submit(value) {
      if (working || !['ready', 'retry'].includes(state.phase)) return;
      if (!state.request) {
        const parsed = parseReviewAmount(value);
        if (parsed.error) { publish({ error: parsed.error }); return; }
        let uuid;
        try { uuid = requestId(); } catch { publish({ error: 'Не удалось создать запрос. Обновите страницу.' }); return; }
        if (typeof uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
          publish({ error: 'Не удалось создать запрос. Обновите страницу.' }); return;
        }
        publish({ request: Object.freeze({ creator_id: creatorId, expected_snapshot: state.review.review_snapshot,
          amount_minor: parsed.amount_minor, request_id: uuid }) });
      }
      working = true;
      publish({ phase: 'saving', error: '' });
      try {
        const response = await save(id, state.request);
        if (response?.success && matchesReviewReceipt(response.result, state.request, id)) { saved(response.result); return; }
        // A rejection, malformed response or lost response is never payment
        // evidence. Read the same row and match the exact saved receipt.
        await check();
      } catch { await check(); }
      finally { working = false; }
    },
  };
}
