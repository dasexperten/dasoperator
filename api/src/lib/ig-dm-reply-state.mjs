// A failed Direct step is pending work, never a handled incoming message.
const TECHNICAL = new Set(['unparsable', 'too long', 'promises payment', 'claims money sent, not paid in ERP', 'menu jargon in a reply', 'says face is optional', 'scenario outside active menu', 'provider_error', 'payout_registration_failed', 'conversation_check_failed', 'send_failed']);
export const RETRY_DELAY_MS = 5 * 60_000;
export const MAX_REPLY_ATTEMPTS = 3;

export function readReplyState(value) {
  try { const s = typeof value === 'string' ? JSON.parse(value) : value; return s && typeof s.at === 'string' ? s : null; } catch { return null; }
}
export function canAttemptReply(state, at, now = Date.now()) {
  if (!state || state.at !== at) return true;
  return state.status === 'retry' && Number(state.next_retry_at ?? 0) <= now;
}
export function nextReplyFailure(previous, { at, handle, reason, now = Date.now() }) {
  const attempts = previous?.at === at ? Number(previous.attempts ?? 0) + 1 : 1;
  const kind = TECHNICAL.has(reason) ? 'technical' : 'business';
  return { handle, at, reason: String(reason || 'Требуется ручная проверка').replace(/(?:\+?7|8)[\s\d()\-]{9,18}/g, '[телефон]').slice(0, 200), kind, attempts,
    status: kind === 'technical' && attempts < MAX_REPLY_ATTEMPTS ? 'retry' : 'needs_review',
    next_retry_at: now + RETRY_DELAY_MS,
    notified_at: previous?.at === at ? previous.notified_at ?? null : null };
}
export function replyAttention(state) {
  const technical = state.kind === 'technical' || TECHNICAL.has(state.reason);
  return { at: state.at, status: state.status === 'retry' ? 'retry' : 'needs_review',
    kind: technical ? 'technical' : 'business',
    label: state.status === 'retry' ? 'Повторная обработка' : 'Требует проверки',
    reason: technical ? 'Автоответ не завершён; обращение остаётся в работе.' : 'Обращение передано на ручную проверку; требуется решение по переписке.' };
}
